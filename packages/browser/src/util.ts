export const VERSION = "0.2.0";

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
export function defaultRouteTemplate(location: URL): string {
  const segments = location.pathname.split("/").filter(Boolean).slice(0, 16);
  return (
    "/" + segments.map((segment) => (WORD.test(segment) ? segment : ":id")).join("/")
  );
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
