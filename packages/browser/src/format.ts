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
} as const;

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
  };
  document: { width: number; height: number };
  element_count: number;
  truncated: boolean;
  torn: boolean;
  legend: {
    position: readonly string[];
    flags: Readonly<Record<string, number>>;
    hit_points: readonly string[];
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
}
