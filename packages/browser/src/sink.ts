import type { Batch } from "./types";
import type { SnapshotBody } from "./snapshot";
import { gzip } from "./util";

/**
 * Outcome of one delivery attempt. `accepted` (or no return value) clears the
 * item, `retry` keeps it for a bounded retry, `rejected` drops it, and `denied`
 * stops capture and clears everything pending (like HTTP 401/403).
 */
export type SinkResult = "accepted" | "retry" | "rejected" | "denied";

export interface SinkSnapshot {
  /** Lowercase hex SHA-256 of `serialized` (UTF-8). */
  sha256: string;
  body: SnapshotBody;
  /** Exact uncompressed JSON whose hash is `sha256`. */
  serialized: string;
}

export interface SinkContext {
  /** True while the page is being unloaded; deliveries should be small and fast. */
  keepalive: boolean;
  /** Aborted when the SDK's request timeout passes or capture stops. */
  signal: AbortSignal;
  /**
   * The page's `fetch` as it was before the SDK wrapped it. Requests made with it
   * are never recorded. Requests a sink starts before its first `await` are not
   * recorded either, whichever `fetch` or `XMLHttpRequest` they use.
   */
  fetch: typeof fetch;
}

/** A destination for evidence. Throwing or hanging is safe: calls are timed out and isolated. */
export interface InteractionSink {
  sendBatch(
    batch: Batch,
    serialized: string,
    context: SinkContext,
  ): Promise<SinkResult | void> | SinkResult | void;
  sendSnapshot(
    snapshot: SinkSnapshot,
    context: SinkContext,
  ): Promise<SinkResult | void> | SinkResult | void;
}

export interface MemorySink extends InteractionSink {
  readonly batches: Batch[];
  readonly serializedBatches: string[];
  readonly snapshots: SinkSnapshot[];
  clear(): void;
}

/** Keeps everything in memory. Intended for tests and local inspection. */
export function createMemorySink(): MemorySink {
  const batches: Batch[] = [];
  const serializedBatches: string[] = [];
  const snapshots: SinkSnapshot[] = [];
  return {
    batches,
    serializedBatches,
    snapshots,
    sendBatch(_batch, serialized) {
      serializedBatches.push(serialized);
      batches.push(JSON.parse(serialized) as Batch);
      return "accepted";
    },
    sendSnapshot(snapshot) {
      snapshots.push({
        sha256: snapshot.sha256,
        serialized: snapshot.serialized,
        body: JSON.parse(snapshot.serialized) as SnapshotBody,
      });
      return "accepted";
    },
    clear() {
      batches.length = 0;
      serializedBatches.length = 0;
      snapshots.length = 0;
    },
  };
}

const statusResult = (status: number): SinkResult =>
  status >= 200 && status < 300
    ? "accepted"
    : status === 401 || status === 403
      ? "denied"
      : status >= 400 && status < 500 && status !== 429 && status !== 408
        ? "rejected"
        : "retry";

/**
 * The hosted-service transport. Batches: `POST {base}/v2/batches`. Snapshot bodies:
 * `HEAD {base}/v2/snapshots/{sha256}`, then `PUT` (gzip when supported) only on 404.
 */
export function createHttpSink(
  base: string,
  projectKey: string,
  transport: typeof fetch,
): InteractionSink {
  const root = base.replace(/\/$/, "");
  const authorization = `Bearer ${projectKey}`;
  const call = (url: string, init: RequestInit) =>
    transport.call(window, url, { credentials: "omit", ...init });
  return {
    async sendBatch(_batch, serialized, { keepalive, signal }) {
      const response = await call(`${root}/v2/batches`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authorization,
        },
        body: serialized,
        keepalive,
        signal,
      });
      return statusResult(response.status);
    },
    async sendSnapshot({ sha256, serialized }, { signal }) {
      const url = `${root}/v2/snapshots/${sha256}`;
      const head = await call(url, {
        method: "HEAD",
        headers: { Authorization: authorization },
        signal,
      });
      if (head.status !== 404) return statusResult(head.status);
      const compressed = await gzip(serialized);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: authorization,
      };
      if (compressed) headers["Content-Encoding"] = "gzip";
      const put = await call(url, {
        method: "PUT",
        headers,
        body: compressed ?? serialized,
        signal,
      });
      return put.status === 409 ? "accepted" : statusResult(put.status);
    },
  };
}

/**
 * Calls a sink method without letting it affect the host page: synchronous throws
 * become `retry`, late rejections are swallowed, and a hang resolves as `retry`
 * after `timeoutMs`.
 */
export function callSink(
  invoke: (context: Omit<SinkContext, "fetch">) => Promise<SinkResult | void> | SinkResult | void,
  timeoutMs: number,
  keepalive: boolean,
  stopSignal?: AbortSignal,
): Promise<SinkResult> {
  const controller = new AbortController();
  const onStop = () => controller.abort();
  stopSignal?.addEventListener("abort", onStop, { once: true });
  return new Promise<SinkResult>((resolve) => {
    let done = false;
    const finish = (result: SinkResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stopSignal?.removeEventListener("abort", onStop);
      resolve(result);
    };
    const timer = setTimeout(() => {
      controller.abort();
      finish("retry");
    }, timeoutMs);
    controller.signal.addEventListener("abort", () => finish("retry"), {
      once: true,
    });
    try {
      Promise.resolve(invoke({ keepalive, signal: controller.signal })).then(
        (result) =>
          finish(
            result === "retry" || result === "rejected" || result === "denied"
              ? result
              : "accepted",
          ),
        () => finish("retry"),
      );
    } catch {
      finish("retry");
    }
  });
}
