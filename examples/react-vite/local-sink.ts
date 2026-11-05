// Dev-server half of the local sink (see src/interactions.ts). Writes:
//   .interactions/batches/<batch_id>.json    every protocol v2 batch, as sent
//   .interactions/snapshots/<sha256>.json    every screen snapshot body
//   .interactions/findings.json              ui.finding data, one per fingerprint
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import type { Plugin } from "vite";

const MAX_BODY_BYTES = 5_000_000;
const SHA256 = /^[0-9a-f]{64}$/;
const BATCH_ID = /^[A-Za-z0-9-]{1,64}$/;

export function localSink(dir = ".interactions"): Plugin {
  const root = resolve(dir);
  const batches = join(root, "batches");
  const snapshots = join(root, "snapshots");
  // One findings.json rewrite at a time.
  let queue: Promise<void> = Promise.resolve();

  async function writeJson(path: string, value: unknown) {
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
    await rename(tmp, path);
  }

  // Rebuilt from every stored batch: the newest occurrence of each fingerprint
  // wins, and `last_seen` says when it was last reported.
  async function rebuildFindings() {
    const byFingerprint = new Map<string, Record<string, unknown>>();
    const files = (await readdir(batches)).filter((name) => name.endsWith(".json"));
    for (const name of files) {
      const batch = JSON.parse(await readFile(join(batches, name), "utf8"));
      for (const event of batch.events ?? []) {
        if (event.type !== "ui.finding" || typeof event.data?.fingerprint !== "string") continue;
        const seen = byFingerprint.get(event.data.fingerprint);
        if (seen && String(seen.last_seen) >= event.occurred_at) continue;
        byFingerprint.set(event.data.fingerprint, { ...event.data, last_seen: event.occurred_at });
      }
    }
    await writeJson(join(root, "findings.json"), [...byFingerprint.values()]);
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = req.url ?? "";
    const raw = await readBody(req);
    if (raw === null) return send(res, 413);
    let json: { batch_id?: unknown; events?: unknown };
    try {
      json = JSON.parse(raw.toString("utf8"));
    } catch {
      return send(res, 400);
    }

    if (url === "/batches") {
      if (typeof json.batch_id !== "string" || !BATCH_ID.test(json.batch_id) || !Array.isArray(json.events))
        return send(res, 400);
      await mkdir(batches, { recursive: true });
      // A retried batch has the same batch_id and payload, so rewriting it is safe.
      await writeFile(join(batches, `${json.batch_id}.json`), raw);
      queue = queue.then(rebuildFindings, rebuildFindings);
      await queue;
      return send(res, 204);
    }

    const sha256 = /^\/snapshots\/([^/?]+)$/.exec(url)?.[1] ?? "";
    if (SHA256.test(sha256)) {
      // The SDK hashes the exact bytes it sends; anything else is not that snapshot.
      if (createHash("sha256").update(raw).digest("hex") !== sha256) return send(res, 400);
      await mkdir(snapshots, { recursive: true });
      await writeFile(join(snapshots, `${sha256}.json`), raw);
      return send(res, 204);
    }
    return send(res, 404);
  }

  return {
    name: "interactions-local-sink",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__interactions", (req, res) => {
        if (req.method !== "POST") return send(res, 405);
        handle(req, res).catch((error) => {
          server.config.logger.error(`[local-sink] ${error}`);
          send(res, 500); // the browser sink retries
        });
      });
    },
  };
}

function send(res: ServerResponse, status: number) {
  if (!res.headersSent) res.writeHead(status).end();
}

function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on("end", () => done(size > MAX_BODY_BYTES ? null : Buffer.concat(chunks)));
    req.on("error", fail);
  });
}
