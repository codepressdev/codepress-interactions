export const VERSION = "1.4.0";

export const numberOption = (
  value: number | undefined,
  fallback: number,
  maximum = 1_000_000,
): number =>
  Number.isFinite(value) && value! >= 1
    ? Math.min(Math.floor(value!), maximum)
    : fallback;

/** Static developer identifiers only (data-testid style). */
export const safeIdentifier = (value: string | null | undefined): string | undefined =>
  value && /^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/.test(value) ? value : undefined;

/**
 * Decides which `data-interaction-id` / `data-testid` values may be recorded:
 * return the value (or a static replacement) to keep it, `null` to drop it.
 */
export type TestIdFilter = (value: string, element: Element) => string | null;

/**
 * The default test ID filter. Drops any value that contains a `.` (domains,
 * file names, versions), and any value with a segment (split on `-`, `_`, `.`
 * or `:`) that contains a digit or is longer than 32 characters (record IDs,
 * UUIDs, hashes, counters). Keeps `save-button` and `nav:settings`; drops
 * `item-42`, `row-3f2a9c1e-…` and `domain-row-example.com`.
 */
export function defaultTestIdFilter(value: string, _element?: Element): string | null {
  if (typeof value !== "string" || value.includes(".")) return null;
  for (const segment of value.split(/[-_:]/))
    if (segment.length > 32 || /[0-9]/.test(segment)) return null;
  return value;
}

/** Reads one ID attribute through the filter. A throw or a non-string result drops it. */
function filteredId(element: Element, name: string, filter: TestIdFilter): string | undefined {
  const value = element.getAttribute(name);
  if (!value) return undefined;
  let kept: unknown;
  try {
    kept = filter(value, element);
    // An async hook is a non-string result; its rejection must not reach the page as an app error.
    if (typeof (kept as PromiseLike<unknown> | null)?.then === "function")
      (kept as PromiseLike<unknown>).then(undefined, () => {});
  } catch {
    return undefined;
  }
  return typeof kept === "string" ? safeIdentifier(kept) : undefined;
}

/**
 * The element's recorded test ID: `data-interaction-id`, else `data-testid`,
 * each passed through `filter` (default `defaultTestIdFilter`) and then the
 * identifier shape check. Undefined when neither survives.
 */
export function elementTestId(element: Element, filter?: TestIdFilter): string | undefined {
  const use = typeof filter === "function" ? filter : defaultTestIdFilter;
  return filteredId(element, "data-interaction-id", use) ?? filteredId(element, "data-testid", use);
}

/** A control's identifier: its safe test ID, else a non-unique path of at most five tags up to `root`. */
export function controlIdOf(target: Element, root: Element, filter?: TestIdFilter): string {
  const explicit = elementTestId(target, filter);
  if (explicit) return explicit;
  // Non-unique structural hint: at most five ancestor tags, never a sibling scan.
  const path: string[] = [];
  for (let node: Element | null = target; node && node !== root && path.length < 5; node = node.parentElement)
    path.unshift(node.tagName.toLowerCase());
  // The protocol bounds control_id at 128; the end of the path is nearest the control.
  return path.join("/").slice(-128);
}

export const safeLabel = (value: unknown, max = 64): string | undefined =>
  typeof value === "string" &&
  value.length <= max &&
  /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(value)
    ? value
    : undefined;

export const safeRelease = (value: unknown): string | null =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.+:@/-]{0,127}$/.test(value)
    ? value
    : null;

export const safeTraceId = (value: string | null | undefined): string | undefined =>
  value && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : undefined;

export const safeHeaderName = (value: unknown): string | null =>
  typeof value === "string" && /^[A-Za-z0-9-]{1,64}$/.test(value) ? value : null;

export const validInteractionId = (value: string | null): string | null =>
  value &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;

const ROUTE = /^\/[A-Za-z0-9_\-./:{}[\]*()+@~]{0,255}$/;
const WORD = /^[a-z][a-z_-]{0,31}$/;

/** Default route template: lowercase words survive, every other segment becomes `:id`. */
/** Static path words an app allows in route templates (`routeSegments`). */
export function routeSegmentSet(value: unknown): ReadonlySet<string> {
  const words = new Set<string>();
  if (!Array.isArray(value)) return words;
  for (const word of value.slice(0, 256)) if (typeof word === "string" && WORD.test(word)) words.add(word);
  return words;
}

/**
 * Default route template. Only the path is used, never the query or hash, and
 * every segment becomes `:id` unless it is one of the static words in `allowed`
 * (the `routeSegments` option). With no allowlist, `/u/jane-smith` and
 * `/acme-corp/projects` both become `/:id/:id`, so no path text reaches the
 * payload. Pass `routeSegments`, or `routeTemplate` for exact router patterns.
 */
export function defaultRouteTemplate(
  location: URL,
  allowed: ReadonlySet<string> | readonly string[] = [],
): string {
  const words = allowed instanceof Set ? allowed : routeSegmentSet(allowed);
  const segments = location.pathname.split("/").filter(Boolean).slice(0, 16);
  return "/" + segments.map((segment) => (words.has(segment) ? segment : ":id")).join("/");
}

export function safeRoute(value: unknown): string | null {
  return typeof value === "string" && ROUTE.test(value) && !value.includes("?")
    ? value
    : null;
}

export const clampMs = (value: number): number =>
  Math.round(Math.min(86_400_000, Math.max(0, value)) * 10) / 10;

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Gzip with CompressionStream when available; null when the browser lacks it. */
export async function gzip(text: string): Promise<Blob | null> {
  if (typeof CompressionStream !== "function") return null;
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Blob([await new Response(stream).arrayBuffer()]);
}

export const now = (): number => performance.now();

/**
 * Bounded memory of keys already sent, by recency. A key seen again moves to
 * the newest end; past `max`, the least recently seen key is forgotten, so an
 * old one can be sent again only after it has gone unseen for a while. A key
 * seen during the current run is never forgotten to make room: when every
 * remembered key is that fresh (one run produced more than `max` keys), a new
 * key is refused and waits for a later run instead of pushing out keys that
 * would come straight back, which would resend everything on every run.
 */
export class RecentKeys {
  private keys = new Map<string, number>();
  private run = 0;

  constructor(readonly max: number) {}

  get size(): number {
    return this.keys.size;
  }

  /** Starts a run: keys seen from here on are protected until the next one. */
  beginRun(): void {
    this.run++;
  }

  /** "seen": already remembered (now the newest); "new": remembered now; "full": refused for this run. */
  admit(key: string): "seen" | "new" | "full" {
    if (this.keys.has(key)) {
      this.keys.delete(key);
      this.keys.set(key, this.run);
      return "seen";
    }
    if (this.keys.size >= this.max) {
      const [oldest, run] = this.keys.entries().next().value!;
      if (run === this.run) return "full";
      this.keys.delete(oldest);
    }
    this.keys.set(key, this.run);
    return "new";
  }
}
