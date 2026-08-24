/**
 * Wire types of the agent-browser CLI/JSON protocol, as spoken by the
 * `agent-browser` binary (verified against 0.34.0). The driver parses these
 * envelopes and projects them into the typed surfaces of this package.
 *
 * @module dsh-agent-browser-core/types
 */

/** Envelope every single-command `--json` invocation prints on success-parse. */
export interface CliEnvelope<T = unknown> {
  /** False when the command failed; the human-readable reason is in {@link error}. */
  success: boolean;
  /** Command payload on success; recovery data on some failures (e.g. tab_gone). */
  data: T | null;
  /** Failure reason; null on success. */
  error: string | null;
}

/** Lifecycle bookkeeping agent-browser attaches to most command payloads. */
export interface LifecycleBlock {
  launched?: boolean;
  reused?: boolean;
  browserLaunched?: boolean;
  relaunchedBrowser?: boolean;
  restartedBackground?: boolean;
  restoreStatus?: string;
  saveStatus?: string;
}

/**
 * Strip the lifecycle block (and any other bookkeeping keys) from a payload.
 * Arrays pass through AS ARRAYS at every depth — a naive `{...data}` spread
 * silently turns every list payload (cookies, console lines, tabs, batch step
 * results) into an integer-keyed object.
 */
export function stripLifecycle<T>(data: T): T {
  if (Array.isArray(data)) {
    return data.map((item) => stripLifecycle(item)) as unknown as T;
  }
  if (data !== null && typeof data === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (key === "lifecycle") continue;
      out[key] = stripLifecycle(value);
    }
    return out as unknown as T;
  }
  return data;
}

// ── open ────────────────────────────────────────────────────────────────────

export interface OpenData {
  title?: string;
  url?: string;
  targetId?: string;
}

// ── snapshot ────────────────────────────────────────────────────────────────

/** One interactive element from a snapshot's refs table. */
export interface SnapshotRef {
  name?: string;
  role?: string;
}

export interface SnapshotData {
  origin?: string;
  /** ref id (without the leading @) → element descriptor. */
  refs?: Record<string, SnapshotRef>;
  /** Pre-rendered accessibility tree text with [ref=eN] markers. */
  snapshot?: string;
}

// ── tabs ────────────────────────────────────────────────────────────────────

export interface TabInfo {
  active: boolean;
  label: string | null;
  tabId: string;
  targetId: string;
  title: string;
  type: string;
  url: string;
}

export interface TabListData {
  tabs: TabInfo[];
}

// ── eval ────────────────────────────────────────────────────────────────────

export interface EvalData {
  result?: unknown;
  origin?: string;
}

// ── screenshot / pdf / state files ─────────────────────────────────────────

export interface PathData {
  path: string;
}

// ── console / errors feeds ──────────────────────────────────────────────────

export interface ConsoleData {
  messages?: Array<{
    type?: string;
    text?: string;
    args?: unknown[];
    location?: unknown;
    time?: number;
  }>;
}

// ── batch ───────────────────────────────────────────────────────────────────

/** One entry of the JSON array a `batch --json` prints. */
export interface BatchStepResult<T = Record<string, unknown>> {
  /** argv tokens of the step, echoed back. */
  command: string[];
  result?: T & { lifecycle?: LifecycleBlock };
  success: boolean;
  error?: string | null;
}

// ── stream ──────────────────────────────────────────────────────────────────

export interface StreamStatusData {
  enabled?: boolean;
  connected?: boolean;
  port?: number;
  screencasting?: boolean;
}

/** Metadata attached to every stream frame message. */
export interface FrameMetadata {
  deviceWidth: number;
  deviceHeight: number;
  pageScaleFactor?: number;
  offsetTop?: number;
  scrollOffsetX?: number;
  scrollOffsetY?: number;
  /** Capture time in epoch milliseconds. */
  timestamp: number;
}

export type StreamServerMessage =
  | { type: "frame"; seq: number; data: string; metadata: FrameMetadata }
  | { type: "status"; [key: string]: unknown }
  | { type: "tabs"; [key: string]: unknown }
  | { type: "url"; url?: string; [key: string]: unknown }
  | { type: "console"; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

export type StreamClientMessage =
  | {
      type: "input_mouse";
      eventType: string;
      x: number;
      y: number;
      button?: string;
      clickCount?: number;
    }
  | { type: "input_keyboard"; eventType: string; key?: string; text?: string; code?: number }
  | { type: "input_touch"; eventType: string; touchPoints?: unknown[] }
  | { type: "config"; maxFps?: number; pacing?: "push" | "ack" }
  | { type: "ack"; seq: number };

// ── sessions ────────────────────────────────────────────────────────────────

export interface SessionListEntry {
  name?: string;
  pid?: number;
  [key: string]: unknown;
}
