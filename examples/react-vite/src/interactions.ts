import type {
  InteractionOptions,
  InteractionSink,
  SinkResult,
} from "@codepress/interactions-browser";

// The browser cannot write files, so this sink posts each batch and snapshot
// body to the Vite dev server, where local-sink.ts writes them to .interactions/.
const BASE = "/__interactions";

// The sink contract: 2xx means stored, 4xx means this item will never be
// accepted (drop it), anything else is worth a bounded retry.
function result(status: number): SinkResult {
  if (status >= 200 && status < 300) return "accepted";
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return "rejected";
  return "retry";
}

const localSink: InteractionSink = {
  // context.fetch is the page's fetch without the SDK's wrapper, so these uploads
  // are not recorded as the app's own requests.
  async sendBatch(_batch, serialized, { keepalive, signal, fetch }) {
    const response = await fetch(`${BASE}/batches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serialized,
      keepalive,
      signal,
    });
    return result(response.status);
  },
  async sendSnapshot({ sha256, serialized }, { signal, fetch }) {
    const response = await fetch(`${BASE}/snapshots/${sha256}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: serialized,
      signal,
    });
    return result(response.status);
  },
};

// Module-level, so useInteractions gets the same object on every render.
export const interactionOptions: InteractionOptions = {
  // Only the dev server has the endpoint that writes files.
  enabled: import.meta.env.DEV,
  sink: localSink,
  // Flush sooner than the 5 s default so files show up quickly while you work.
  flushIntervalMs: 2000,
};
