import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStream, resolveStreamPort } from "../src/stream.ts";
import type { AgentBrowserClient } from "../src/client.ts";

/** Minimal scriptable WebSocket double. */
class FakeWS {
  static instances: FakeWS[] = [];
  readonly url: string;
  readyState = 0; // CONNECTING
  sent: string[] = [];
  private handlers = new Map<string, Set<(ev: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }

  addEventListener(type: string, fn: (ev: unknown) => void): void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn);
  }

  private fire(type: string, ev: unknown = {}): void {
    for (const fn of this.handlers.get(type) ?? []) fn(ev);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  /** Test hooks simulating the server side. */
  serverOpen(): void {
    this.readyState = 1; // OPEN
    this.fire("open", {});
  }

  serverMessage(payload: unknown): void {
    this.fire("message", { data: JSON.stringify(payload) });
  }

  serverClose(reason = "peer closed"): void {
    this.readyState = 3;
    this.fire("close", { reason });
  }

  serverError(): void {
    this.readyState = 3;
    this.fire("error", {});
  }

  close(): void {
    /* user-initiated: no events fired here */
  }
}

const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64"); // SOI+EOI

beforeEach(() => {
  FakeWS.instances = [];
});

describe("SessionStream", () => {
  it("connects, decodes frames, and acks in ack pacing mode", async () => {
    const stream = new SessionStream(59000, { pacing: "ack", WebSocketImpl: FakeWS });
    const frames: number[] = [];
    stream.on("frame", (f) => frames.push(f.seq));
    const connecting = stream.connect();
    FakeWS.instances[0]!.serverOpen();
    await connecting;
    expect(FakeWS.instances).toHaveLength(1);
    expect(FakeWS.instances[0]!.url).toContain(":59000");
    expect(FakeWS.instances[0]!.url).toContain("pacing=ack");

    const ws = FakeWS.instances[0]!;
    ws.serverMessage({ type: "frame", seq: 7, data: JPEG_B64 });
    expect(frames).toEqual([7]);
    const acked = ws.sent.some((raw) => {
      const msg = JSON.parse(raw) as { type?: string; seq?: number };
      return msg.type === "ack" && msg.seq === 7;
    });
    expect(acked).toBe(true);
    stream.close();
  });

  it("decodes base64 jpeg bytes exactly", async () => {
    const stream = new SessionStream(59001, { WebSocketImpl: FakeWS });
    let bytes: Buffer | null = null;
    stream.on("frame", (f) => (bytes = f.jpeg));
    const connecting = stream.connect();
    FakeWS.instances[0]!.serverOpen();
    await connecting;
    FakeWS.instances[0]!.serverMessage({ type: "frame", seq: 1, data: JPEG_B64 });
    expect(bytes).not.toBeNull();
    expect([...Buffer.from(bytes!)]).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    stream.close();
  });

  it("reconnects after an unexpected close and resets the failure budget", async () => {
    const stream = new SessionStream(59002, {
      WebSocketImpl: FakeWS,
      reconnectBaseMs: 2,
      maxReconnects: 5,
    });
    let opens = 0;
    stream.on("open", () => (opens += 1));
    const first = stream.connect();
    FakeWS.instances[0]!.serverOpen();
    await first;
    FakeWS.instances[0]!.serverClose();
    // Backoff (2ms) fires; second socket opens successfully.
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && FakeWS.instances.length < 2) {
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(FakeWS.instances.length).toBe(2);
    FakeWS.instances[1]!.serverOpen();
    expect(opens).toBe(2);
    stream.close();
  });

  it("gives up after maxReconnects and emits an error", async () => {
    const stream = new SessionStream(59003, {
      WebSocketImpl: FakeWS,
      reconnectBaseMs: 2,
      maxReconnects: 2,
    });
    const errors: string[] = [];
    stream.on("error", (e) => errors.push(e.message));
    const firstConnect = stream.connect();
    FakeWS.instances[0]!.serverOpen();
    await firstConnect;
    // Drop the healthy connection, then let both reconnect attempts fail:
    // maxReconnects: 2 -> after two errored attempts the stream gives up.
    FakeWS.instances[0]!.serverClose();
    for (let i = 1; i <= 2; i++) {
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline && FakeWS.instances.length < i + 1) {
        await new Promise((r) => setTimeout(r, 2));
      }
      expect(FakeWS.instances.length).toBeGreaterThanOrEqual(i + 1);
      FakeWS.instances[i]!.serverError();
    }
    expect(errors.some((m) => m.includes("gave up"))).toBe(true);
    stream.close();
  });

  it("close() stops reconnection entirely", async () => {
    const stream = new SessionStream(59004, { WebSocketImpl: FakeWS, reconnectBaseMs: 2 });
    const connecting = stream.connect();
    FakeWS.instances[0]!.serverOpen();
    await connecting;
    stream.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(FakeWS.instances).toHaveLength(1); // no reconnect attempt
  });
});

describe("resolveStreamPort", () => {
  it("reads the session sidecar first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ab-sidecar-"));
    writeFileSync(join(dir, "s9.stream"), "4321\n");
    process.env["AGENT_BROWSER_STATE_DIR"] = dir;
    try {
      const port = await resolveStreamPort({} as AgentBrowserClient, "s9");
      expect(port).toBe(4321);
    } finally {
      delete process.env["AGENT_BROWSER_STATE_DIR"];
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects out-of-range sidecar values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ab-sidecar-"));
    writeFileSync(join(dir, "bad.stream"), "99999");
    process.env["AGENT_BROWSER_STATE_DIR"] = dir;
    try {
      // No client fallback provided -> call would throw -> null.
      const port = await resolveStreamPort({
        call: async () => ({ data: {}, envelope: { success: true, data: {}, error: null } }),
      } as unknown as AgentBrowserClient, "bad");
      expect(port).toBeNull();
    } finally {
      delete process.env["AGENT_BROWSER_STATE_DIR"];
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
