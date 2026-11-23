/**
 * The snapshot body format: decoding tables and types only. No DOM access, so
 * checks can import it in Node.
 */

export const POSITIONS = ["static", "relative", "absolute", "fixed", "sticky"] as const;

/** Bit values of `elements.flags`. */
export const FLAGS = {
  visible: 1,
  interactive: 2,
  clipped: 4,
  scrollable: 8,
  overlay: 16,
  ignored: 32,
  pointer_events_none: 64,
  opaque: 128,
  clips_content: 256,
  in_shadow: 512,
  popover_open: 1024,
  ellipsis: 2048,
  broken_image: 4096,
  aria_hidden: 8192,
  allow_overlap: 16384,
} as const;

/**
 * Bit values of `state.bits` (1.5.0): what the UI claims about an element,
 * read from ARIA and native state. Booleans only; attribute values are never
 * recorded.
 */
export const STATE = {
  /** aria-current present and not "false". */
  current: 1,
  /** aria-selected="true". */
  selected: 2,
  /** aria-expanded="true". */
  expanded: 4,
  /** aria-pressed="true". */
  pressed: 8,
  /** A checked checkbox or radio, or aria-checked="true". */
  checked: 16,
  /** A disabled form control (:disabled), or aria-disabled="true". */
  disabled: 32,
  /** aria-invalid present and not "false", or :user-invalid. */
  invalid: 64,
  /** aria-busy="true". */
  busy: 128,
  /** An open details or dialog, or an open popover. */
  open: 256,
  /** A same-origin link whose path is the page's path (trailing slash ignored). */
  links_here: 512,
} as const;

/** Color scheme on screen. A bounded enum: anything else is recorded as "unknown". */
export type Theme = "light" | "dark" | "unknown";
export const THEMES: readonly Theme[] = ["light", "dark", "unknown"];

/** Bit values of `hit_tests.points`: center, then the four inset points. */
export const HIT_POINTS = ["center", "top_left", "top_right", "bottom_left", "bottom_right"] as const;

export interface SnapshotBody {
  schema_version: 2;
  route_template: string | null;
  viewport: {
    width: number;
    height: number;
    client_width: number;
    client_height: number;
    device_pixel_ratio: number;
    scroll_x: number;
    scroll_y: number;
    /** `(pointer: coarse)` matched: the primary input is touch. Absent in 0.2.0 bodies. */
    coarse_pointer?: boolean;
    /** Color scheme on screen: the host's `theme()` when given, else `prefers-color-scheme`. Absent before 0.3.0. */
    theme?: Theme;
  };
  document: { width: number; height: number };
  element_count: number;
  truncated: boolean;
  torn: boolean;
  legend: {
    position: readonly string[];
    flags: Readonly<Record<string, number>>;
    hit_points: readonly string[];
    /** Bit values of `state.bits`; present only with a `state` table (1.5.0). */
    state?: Readonly<Record<string, number>>;
  };
  dictionaries: { tag: string[]; role: string[]; test_id: string[] };
  elements: {
    parent: number[];
    tag: number[];
    role: number[];
    test_id: number[];
    x: number[];
    y: number[];
    width: number[];
    height: number[];
    z_index: (number | null)[];
    position: number[];
    flags: number[];
    text_length: number[];
  };
  text_boxes: {
    element: number[];
    x: number[];
    y: number[];
    width: number[];
    height: number[];
    lines: number[];
  };
  hit_tests: {
    element: number[];
    tested: number[];
    blocked: number[];
    points: number[];
    top: number[];
  };
  /**
   * Overlaps allowed with `data-layout-allow-overlap`, resolved in the page:
   * `element` (a row flagged `allow_overlap`) allows `other` (a row, or -1 for
   * any). Only pairs whose boxes intersect are listed. Absent when no recorded
   * element carries the marker, and in bodies before 1.2.0.
   */
  allow_overlap?: {
    element: number[];
    other: number[];
  };
  /**
   * Text below 4.5:1 (the highest WCAG AA threshold): the contrast of the text
   * each listed element holds itself (direct text nodes), measured in the
   * page; colours are never recorded. Only elements whose background could be
   * worked out are listed; disabled controls and text hidden from assistive
   * technology are not. Absent before 1.2.0.
   */
  contrast?: {
    element: number[];
    /** Contrast ratio, rounded down to 2 decimal places. */
    ratio: number[];
    /** Computed font size, CSS px, rounded to 0.01. */
    font_px: number[];
    /** Computed font weight 700 or more. */
    bold: boolean[];
  };
  /** Shown controls whose accessible name is empty. Absent before 1.2.0. */
  unnamed_controls?: {
    element: number[];
    /** The control has a title attribute (blank, or it would have named the control). */
    has_title: boolean[];
    /** The control holds images or SVG and no text. */
    icon_only: boolean[];
  };
  /**
   * Elements with any UI state set (1.5.0): row and bitmask (see
   * `legend.state`). Only rows with a bit set are listed, at most
   * `MAX_STATE_ROWS`; `truncated` is true when more had state. Absent when no
   * recorded element has state, and before 1.5.0.
   */
  state?: {
    element: number[];
    bits: number[];
    truncated: boolean;
  };
}
