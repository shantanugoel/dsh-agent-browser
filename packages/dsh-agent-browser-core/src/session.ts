/**
 * Per-session facade over {@link AgentBrowserClient}: the object model tools
 * consume. One instance maps to one agent-browser session (its own daemon,
 * cookies, tabs); every operation is one CLI round-trip except act(), which
 * batches all steps into a single call.
 *
 * @module dsh-agent-browser-core/session
 */

import type { AgentBrowserClient } from "./client.ts";
import { resolveStreamPort, SessionStream, type StreamOptions } from "./stream.ts";
import type { SnapshotData, SnapshotRef, TabInfo } from "./types.ts";

/** How to locate an element: a snapshot ref (@eN id without @), or raw selector. */
export interface TargetRef {
  /** Snapshot ref id, e.g. "e12" (the driver adds the leading @). */
  ref?: string;
  /** Raw CSS selector fallback. */
  selector?: string;
}

export type ActAction =
  | { kind: "click"; target: TargetRef; newTab?: boolean }
  | { kind: "dblclick"; target: TargetRef }
  | { kind: "fill"; target: TargetRef; text: string }
  | { kind: "type"; target: TargetRef; text: string }
  | { kind: "press"; key: string }
  | { kind: "hover"; target: TargetRef }
  | { kind: "focus"; target: TargetRef }
  | { kind: "check"; target: TargetRef }
  | { kind: "uncheck"; target: TargetRef }
  | { kind: "select"; target: TargetRef; values: string[] }
  | { kind: "upload"; target: TargetRef; files: string[] }
  | { kind: "scroll"; direction: "up" | "down" | "left" | "right"; pixels?: number }
  | { kind: "scrollintoview"; target: TargetRef }
  | { kind: "drag"; from: TargetRef; to: TargetRef };

/** Resolve a target to argv tokens (the ref token itself). */
function targetToken(target: TargetRef): string {
  if (target.ref) return `@${target.ref.replace(/^@/, "")}`;
  if (target.selector) return target.selector;
  throw new Error("act step requires a ref or selector");
}

/** Project one typed step into its agent-browser argv tokens. */
export function stepToArgv(step: ActAction): string[] {
  switch (step.kind) {
    case "click": {
      const argv = ["click", targetToken(step.target)];
      if (step.newTab) argv.push("--new-tab");
      return argv;
    }
    case "dblclick":
      return ["dblclick", targetToken(step.target)];
    case "fill":
      return ["fill", targetToken(step.target), step.text];
    case "type":
      return ["type", targetToken(step.target), step.text];
    case "press":
      return ["press", step.key];
    case "hover":
      return ["hover", targetToken(step.target)];
    case "focus":
      return ["focus", targetToken(step.target)];
    case "check":
      return ["check", targetToken(step.target)];
    case "uncheck":
      return ["uncheck", targetToken(step.target)];
    case "select":
      return ["select", targetToken(step.target), ...step.values];
    case "upload":
      return ["upload", targetToken(step.target), ...step.files];
    case "scroll":
      return ["scroll", step.direction, String(step.pixels ?? 300)];
    case "scrollintoview":
      return ["scrollintoview", targetToken(step.target)];
    case "drag":
      return ["drag", targetToken(step.from), targetToken(step.to)];
    default: {
      const never: never = step;
      void never;
      throw new Error("unknown act step");
    }
  }
}

/** Model-facing act step (DSH/pi tools use `action` + optional ref, not `kind`). */
export interface ModelActStep {
  action: ActAction["kind"] | string;
  ref?: string;
  selector?: string;
  text?: string;
  key?: string;
  values?: string[];
  files?: string[];
  direction?: "up" | "down" | "left" | "right";
  pixels?: number;
  newTab?: boolean;
}

function targetOf(step: ModelActStep): TargetRef {
  return {
    ...(step.ref !== undefined ? { ref: step.ref.replace(/^@/, "") } : {}),
    ...(step.selector !== undefined ? { selector: step.selector } : {}),
  };
}

/** Convert one validated model step into the driver's typed action union. */
export function modelStepToActAction(step: ModelActStep): ActAction {
  switch (step.action) {
    case "click":
      return { kind: "click", target: targetOf(step), ...(step.newTab ? { newTab: true } : {}) };
    case "dblclick":
      return { kind: "dblclick", target: targetOf(step) };
    case "fill":
      return { kind: "fill", target: targetOf(step), text: step.text ?? "" };
    case "type":
      return { kind: "type", target: targetOf(step), text: step.text ?? "" };
    case "press":
      return { kind: "press", key: step.key ?? "Enter" };
    case "hover":
      return { kind: "hover", target: targetOf(step) };
    case "focus":
      return { kind: "focus", target: targetOf(step) };
    case "check":
      return { kind: "check", target: targetOf(step) };
    case "uncheck":
      return { kind: "uncheck", target: targetOf(step) };
    case "select":
      return { kind: "select", target: targetOf(step), values: step.values ?? [] };
    case "upload":
      return { kind: "upload", target: targetOf(step), files: step.files ?? [] };
    case "scroll":
      return {
        kind: "scroll",
        direction: step.direction ?? "down",
        ...(step.pixels !== undefined ? { pixels: step.pixels } : {}),
      };
    case "scrollintoview":
      return { kind: "scrollintoview", target: targetOf(step) };
    case "drag":
      throw new Error("drag is not exposed on the model step surface");
    default:
      throw new Error(`unknown action ${String(step.action)}`);
  }
}

export interface OpenOptions {
  /** Launch args only apply on daemon boot; callers rarely need to change this. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface SnapshotOptions {
  interactiveOnly?: boolean;
  maxChars?: number;
  depth?: number;
  scopeSelector?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface FoundNode {
  ref: string;
  role?: string;
  name?: string;
  /** The snapshot line this node came from, for context display. */
  line?: string;
}

/** Result of one screenshot call. */
export interface ScreenshotResult {
  /** PNG bytes read back from the file the CLI wrote. */
  bytes: Buffer;
  path: string;
}

/**
 * Facade for one named browser session. All methods are one spawn unless
 * documented; nothing here holds long-lived state beyond the client reference,
 * so instances are cheap to recreate after daemon restarts.
 */
export class BrowserSession {
  constructor(
    private readonly client: AgentBrowserClient,
    /** Session name; undefined uses the daemon's shared default session. */
    readonly name?: string,
  ) {}

  private opt(options: { timeoutMs?: number; signal?: AbortSignal } = {}): {
    session?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  } {
    return {
      ...(this.name ? { session: this.name } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    };
  }

  /** Navigate (booting the daemon on first use) and report title/url. */
  async open(url: string, options: OpenOptions = {}): Promise<{ title?: string; url?: string }> {
    const res = await this.client.call<{ title?: string; url?: string }>(["open", url], this.opt(options));
    return { title: res.data.title, url: res.data.url };
  }

  /** Accessibility-tree snapshot with refs; text truncated at maxChars. */
  async snapshot(options: SnapshotOptions = {}): Promise<{
    text: string;
    refs: Record<string, SnapshotRef>;
    origin?: string;
    truncated: boolean;
  }> {
    const argv = ["snapshot"];
    if (options.interactiveOnly !== false) argv.push("-i");
    if (options.depth !== undefined) argv.push("-d", String(options.depth));
    if (options.scopeSelector) argv.push("-s", options.scopeSelector);
    const res = await this.client.call<SnapshotData>(argv, this.opt(options));
    const full = res.data.snapshot ?? "";
    const limit = options.maxChars;
    const truncated = limit !== undefined && full.length > limit;
    return {
      text: truncated ? full.slice(0, limit!) : full,
      refs: res.data.refs ?? {},
      origin: res.data.origin,
      truncated,
    };
  }

  /**
   * Find nodes matching a substring (case-insensitive) or regex in the
   * current snapshot's refs table.
   */
  async find(pattern: string | RegExp, options: SnapshotOptions = {}): Promise<{ matches: FoundNode[]; origin?: string }> {
    const snap = await this.snapshot(options);
    const re =
      pattern instanceof RegExp
        ? pattern
        : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const matches: FoundNode[] = [];
    // Match against ref names AND roles; include the snapshot line when available.
    const linesByRef = new Map<string, string>();
    for (const line of snap.text.split("\n")) {
      const m = /\[ref=(e\d+)\]/.exec(line);
      if (m?.[1]) linesByRef.set(m[1], line.trim());
    }
    for (const [id, info] of Object.entries(snap.refs)) {
      const haystack = `${info.name ?? ""} ${info.role ?? ""}`;
      if (!re.test(haystack)) continue;
      matches.push({ ref: id, role: info.role, name: info.name, line: linesByRef.get(id) });
      if (matches.length >= 25) break;
    }
    return { matches, origin: snap.origin };
  }

  /** Execute multiple interaction steps in ONE daemon round-trip. */
  async act(
    steps: readonly ActAction[],
    options: { bail?: boolean; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Array<{ command: string[]; success: boolean; error?: string | null; result?: Record<string, unknown> }>> {
    const argvs = steps.map(stepToArgv);
    const { results } = await this.client.batch(argvs, { ...this.opt(options), bail: options.bail });
    return results.map((r) => ({
      command: r.command,
      success: r.success,
      error: r.error ?? null,
      ...(r.result ? { result: r.result } : {}),
    }));
  }

  /** Read page or element information. */
  async get(what: "url" | "title", options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<string>;
  async get(
    what: "text" | "html" | "value",
    ref: string,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<unknown>;
  async get(what: "console", options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<unknown>;
  async get(what: "cookies", options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<unknown>;
  async get(
    what: "url" | "title" | "text" | "html" | "value" | "console" | "cookies",
    refOrOptions?: string | { timeoutMs?: number; signal?: AbortSignal },
    maybeOptions: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown> {
    if (what === "url" || what === "title") {
      const opts = typeof refOrOptions === "string" ? maybeOptions : (refOrOptions ?? {});
      const res = await this.client.call<{ [k: string]: unknown }>(["get", what], this.opt(opts));
      return res.data[what];
    }
    if (what === "console") {
      const opts = typeof refOrOptions === "object" && refOrOptions !== null ? refOrOptions : {};
      const res = await this.client.call(["console"], this.opt(opts));
      return res.data;
    }
    if (what === "cookies") {
      const opts = typeof refOrOptions === "object" && refOrOptions !== null ? refOrOptions : {};
      const res = await this.client.call(["cookies"], this.opt(opts));
      return res.data;
    }
    const ref = typeof refOrOptions === "string" ? refOrOptions : "";
    if (!ref) throw new Error(`get(${what}) requires a ref`);
    const res = await this.client.call(["get", what, `@${ref.replace(/^@/, "")}`], this.opt(maybeOptions));
    return res.data;
  }

  /** Run JavaScript in the page context via stdin (no shell quoting hazards). */
  async evaluate(js: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    const res = await this.client.call<{ result?: unknown; [k: string]: unknown }>(["eval", "--stdin"], {
      ...this.opt(options),
      stdin: js,
    });
    // Prefer the scalar eval value; fall back to the whole payload.
    return res.data.result !== undefined ? res.data.result : res.data;
  }

  /** Capture a screenshot; reads the file back and returns raw bytes. */
  async screenshot(
    options: { fullPage?: boolean; outPath?: string; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<ScreenshotResult> {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const target =
      options.outPath ?? path.join(os.tmpdir(), `agent-browser-shot-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
    const argv = ["screenshot", target];
    if (options.fullPage) argv.push("--full");
    const res = await this.client.call<{ path: string }>(argv, this.opt(options));
    const bytes = await fs.readFile(res.data.path ?? target);
    return { bytes, path: res.data.path ?? target };
  }

  // ── tabs ─────────────────────────────────────────────────────────────────

  async tabs(options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<TabInfo[]> {
    const res = await this.client.call<{ tabs: TabInfo[] }>(["tab", "list"], this.opt(options));
    return res.data.tabs ?? [];
  }

  async tabNew(
    url?: string,
    label?: string,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    const argv = ["tab", "new"];
    if (label) argv.push("--label", label);
    if (url) argv.push(url);
    await this.client.call(argv, this.opt(options));
  }

  async tabSwitch(idOrLabel: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    await this.client.call(["tab", idOrLabel], this.opt(options));
  }

  async tabClose(idOrLabel: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    await this.client.call(["tab", "close", idOrLabel], this.opt(options));
  }

  // ── wait ──────────────────────────────────────────────────────────────────

  async waitForText(text: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    await this.client.call(["wait", "--text", text], this.opt(options));
  }

  // ── stream ────────────────────────────────────────────────────────────────

  /** Discover the live-stream port for this session (null when disabled). */
  streamPort(): Promise<number | null> {
    return resolveStreamPort(this.client, this.name);
  }

  /** Connect to this session's viewport stream. */
  async connectStream(options: StreamOptions = {}): Promise<SessionStream> {
    const port = await this.streamPort();
    if (port === null) throw new Error("stream unavailable for this session (not enabled)");
    const stream = new SessionStream(port, options);
    await stream.connect();
    return stream;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /** Close this session's browser and daemon. */
  async close(): Promise<void> {
    await this.client.call(["close"], { ...(this.name ? { session: this.name } : {}), timeoutMs: 30_000, includeLaunchArgs: false });
  }
}