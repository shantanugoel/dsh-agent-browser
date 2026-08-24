/**
 * Live viewport stream handle. The daemon binds a localhost WebSocket per
 * session (port persisted in the <session>.stream sidecar and reported by
 * `stream status --json`). This module discovers that port, connects with
 * ack pacing + fps cap, decodes JPEG frames, re-emits typed messages, and
 * reconnects with backoff — the exact surface a proxy route or dashboard
 * needs.
 *
 * @module dsh-agent-browser-core/stream
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { AgentBrowserClient } from "./client.ts";
import { BrowserDriverError } from "./errors.ts";
import type { FrameMetadata, StreamServerMessage } from "./types.ts";

export interface StreamFrame {
  seq: number;
  /** Decoded JPEG bytes. */
  jpeg: Buffer;
  metadata: FrameMetadata;
}

export interface StreamEvents {
  frame: (frame: StreamFrame) => void;
  status: (payload: Record<string, unknown>) => void;
  tabs: (payload: Record<string, unknown>) => void;
  url: (payload: Record<string, unknown>) => void;
  console: (payload: Record<string, unknown>) => void;
  open: () => void;
  close: (reason: string) => void;
  error: (error: Error) => void;
}

export type StreamEventListener<K extends keyof StreamEvents> = (...args: Parameters<StreamEvents[K]>) => void;

/** Options for one stream connection. */
export interface StreamOptions {
  /** Max frames per second delivered to THIS client (1-120; undefined = uncapped). */
  maxFps?: number;
  /**
   * "push" (default) streams newest-first; "ack" holds one frame in flight
   * until acknowledged — right for proxies behind slow links.
   */
  pacing?: "push" | "ack";
  /** Reconnect base delay in ms (exponential, capped). Default 500. */
  reconnectBaseMs?: number;
  /** Give up reconnecting after this many consecutive failures. Default 8. */
  maxReconnects?: number;
  /** Injectable WebSocket constructor (tests). Default: globalThis.WebSocket. */
  WebSocketImpl?: unknown;
}

const MIN_PORT = 1;
const MAX_PORT = 65_535;

/**
 * Discover the stream port for one session. Reads the sidecar file first
 * (zero round-trips), falling back to `stream status --json`.
 */
export async function resolveStreamPort(
  client: AgentBrowserClient,
  session?: string,
): Promise<number | null> {
  const name = session && session.length > 0 ? session : "default";
  const stateDir = process.env["AGENT_BROWSER_STATE_DIR"] ?? path.join(process.env["HOME"] ?? os.homedir(), ".agent-browser");
  const sidecar = path.join(stateDir, `${name}.stream`);
  try {
    const raw = (await readFile(sidecar, "utf8")).trim();
    const port = Number.parseInt(raw, 10);
    if (Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT) return port;
  } catch {
    // fall through to the command
  }
  try {
    const res = await client.call<{ enabled?: boolean; port?: number }>(["stream", "status"], {
      session,
      timeoutMs: 15_000,
      includeLaunchArgs: false,
    });
    if (res.data.enabled && typeof res.data.port === "number") return res.data.port;
  } catch {
    return null;
  }
  return null;
}

type ListenerMap = Map<keyof StreamEvents, Set<StreamEventListener<never>>>;

/**
 * One live connection to a session's viewport stream. Emits decoded frames
 * plus the ordered status/tabs/url/console feed; auto-reconnects until
 * {@link close} or the failure budget is spent.
 */
export class SessionStream {
  private ws: WebSocket | null = null;
  private listeners: ListenerMap = new Map();
  private closedByUser = false;
  private lastAckedSeq = 0;
  private failures = 0;

  constructor(
    readonly port: number,
    private readonly options: StreamOptions = {},
  ) {}

  on<K extends keyof StreamEvents>(event: K, listener: StreamEventListener<K>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as StreamEventListener<never>);
    return () => set!.delete(listener as StreamEventListener<never>);
  }

  private emit<K extends keyof StreamEvents>(event: K, ...args: Parameters<StreamEvents[K]>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) (listener as (...a: unknown[]) => void)(...args);
  }

  /** Open the socket. Resolves once connected; keeps reconnecting afterwards. */
  async connect(): Promise<void> {
    this.closedByUser = false;
    const params = new URLSearchParams();
    if (this.options.maxFps !== undefined) params.set("maxFps", String(this.options.maxFps));
    if (this.options.pacing === "ack") params.set("pacing", "ack");
    const qs = params.toString();
    const url = `ws://127.0.0.1:${this.port}/${qs ? `?${qs}` : ""}`;
    const WSImpl = (this.options.WebSocketImpl ?? globalThis.WebSocket) as
      | (new (url: string) => WebSocket)
      | undefined;
    if (!WSImpl) throw new BrowserDriverError("no WebSocket implementation available (node >= 22 provides one)");
    await new Promise<void>((resolve, reject) => {
      const ws = new WSImpl(url);
      this.ws = ws;
      // One-shot guard: error+close often arrive together; count ONE down event.
      let down = false;
      const timer = setTimeout(() => {
        if (down) return;
        down = true;
        reject(new BrowserDriverError("stream connect timed out"));
        this.handleDisconnect("connect timed out");
      }, 10_000);
      ws.addEventListener("open", () => {
        if (down) return;
        clearTimeout(timer);
        this.failures = 0;
        this.emit("open");
        resolve();
      });
      ws.addEventListener("error", () => {
        if (down) return;
        down = true;
        clearTimeout(timer);
        reject(new BrowserDriverError(`stream connect failed to ${url}`));
        // A failed ATTEMPT counts toward the reconnect budget; without this a
        // dead port would be retried forever because onClose never fires.
        this.handleDisconnect("connect error");
      });
      ws.addEventListener("message", (ev: MessageEvent) => this.onMessage(ev));
      ws.addEventListener("close", (ev: CloseEvent) => {
        if (down) return;
        down = true;
        clearTimeout(timer);
        this.handleDisconnect(ev.reason || "peer closed");
      });
    });
  }

  private onMessage(ev: MessageEvent): void {
    let msg: StreamServerMessage;
    try {
      msg = JSON.parse(String(ev.data)) as StreamServerMessage;
    } catch {
      this.emit("error", new BrowserDriverError("stream message was not JSON"));
      return;
    }
    switch (msg.type) {
      case "frame": {
        if (typeof msg.seq !== "number" || typeof msg.data !== "string") return;
        if (this.options.pacing === "ack" && msg.seq > this.lastAckedSeq) {
          this.send({ type: "ack", seq: msg.seq });
          this.lastAckedSeq = msg.seq;
        }
        this.emit("frame", {
          seq: msg.seq,
          jpeg: Buffer.from(msg.data, "base64"),
          metadata: msg.metadata as FrameMetadata,
        });
        break;
      }
      case "status":
        this.emit("status", msg as Record<string, unknown>);
        break;
      case "tabs":
        this.emit("tabs", msg as Record<string, unknown>);
        break;
      case "url":
        this.emit("url", msg as Record<string, unknown>);
        break;
      case "console":
        this.emit("console", msg as Record<string, unknown>);
        break;
      default:
        break;
    }
  }

  private handleDisconnect(reason: string): void {
    this.ws = null;
    this.emit("close", reason);
    if (this.closedByUser) return;
    this.failures += 1;
    const cap = this.options.maxReconnects ?? 8;
    if (this.failures > cap) {
      this.emit("error", new BrowserDriverError(`stream gave up after ${cap} reconnect attempts`));
      return;
    }
    const base = this.options.reconnectBaseMs ?? 500;
    const delay = Math.min(base * 2 ** (this.failures - 1), 15_000);
    setTimeout(() => {
      if (this.closedByUser) return;
      this.connect().catch(() => undefined);
    }, delay);
  }

  /** Send one client message (input injection or config). */
  send(message: import("./types.ts").StreamClientMessage): boolean {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  /** Inject pointer input (human-takeover forwarding lives above this layer). */
  mouse(eventType: string, x: number, y: number, button = "left", clickCount = 1): boolean {
    return this.send({ type: "input_mouse", eventType, x, y, button, clickCount });
  }

  keyboard(eventType: string, key?: string, text?: string): boolean {
    return this.send({ type: "input_keyboard", eventType, key, text });
  }

  /** Close the connection and stop reconnecting. */
  close(): void {
    this.closedByUser = true;
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}