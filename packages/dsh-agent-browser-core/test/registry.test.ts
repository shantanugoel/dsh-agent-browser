import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionRegistry } from "../src/registry.ts";
import { resolveAgentBrowserBinary, BinaryUnavailableError } from "../src/binary.ts";
import { resolveStreamPort } from "../src/stream.ts";
import { mkdirSync, writeFileSync } from "node:fs";

const MOCK = new URL("./fixtures/mock-agent-browser.mjs", import.meta.url).pathname;

describe("SessionRegistry", () => {
  it("get-or-create returns the same handle per name and emits events", () => {
    const reg = new SessionRegistry({ binaryPath: MOCK });
    const events: string[] = [];
    reg.on((e) => events.push(`${e.type}:${e.name ?? "*"}`));
    const a = reg.session("researcher");
    const b = reg.session("researcher");
    expect(a).toBe(b);
    expect(reg.session().name).toBeUndefined();
    reg.forget("researcher");
    expect(reg.list()).toHaveLength(1);
    expect(events).toEqual(["created:researcher", "used:researcher", "created:*", "closed:researcher"]);
  });

  it("closeSession closes the browser then drops the handle", async () => {
    const reg = new SessionRegistry({ binaryPath: MOCK });
    const s = reg.session("doomed");
    await reg.closeSession("doomed");
    expect(reg.list()).toHaveLength(0);
    // The handle still works (it is stateless), but the registry forgot it.
    expect(s.name).toBe("doomed");
  });
});

describe("resolveAgentBrowserBinary", () => {
  it("resolves the real npm dependency via its bin entry", () => {
    const resolved = resolveAgentBrowserBinary();
    expect(resolved.via).toBe("package-bin");
    expect(resolved.command).toMatch(/agent-browser/);
  });

  it("rejects explicit paths that do not exist", () => {
    expect(() => resolveAgentBrowserBinary("/definitely/not/here")).toThrow(BinaryUnavailableError);
  });
});

describe("resolveStreamPort", () => {
  let home: string;
  beforeAll(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "stream-test-"));
  });
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("prefers the sidecar file and validates its contents", async () => {
    const stateDir = path.join(home, ".agent-browser");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(stateDir, "with-sidecar.stream"), "54321\n");
    const prevHome = process.env["HOME"];
    process.env["HOME"] = home;
    try {
      // Sidecar path needs no daemon; use a client that never spawns.
      const client = new (await import("../src/client.ts")).AgentBrowserClient({ binaryPath: MOCK });
      await expect(resolveStreamPort(client, "with-sidecar")).resolves.toBe(54321);
      writeFileSync(path.join(stateDir, "garbage.stream"), "not-a-port");
      // Falls back to stream status (mock reports 54321).
      await expect(resolveStreamPort(client, "garbage")).resolves.toBe(54321);
    } finally {
      if (prevHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = prevHome;
    }
  });
});

describe("SessionRegistry idle reaper", () => {
  it("closes sessions idle beyond idleTimeoutMs and emits closed", async () => {
    const registry = new SessionRegistry(
      { binaryPath: MOCK },
      { idleTimeoutMs: 40, reapIntervalMs: 20 },
    );
    const events: string[] = [];
    registry.on((e) => events.push(e.type + ":" + (e.name ?? "default")));
    registry.session("stale");
    registry.session("fresh", { label: "keep" });
    expect(registry.list()).toHaveLength(2);

    // Keep "fresh" warm while "stale" ages out.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && registry.list().some((e) => e.name === "stale")) {
      registry.session("fresh"); // touch
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(registry.list().map((e) => e.name)).toEqual(["fresh"]);
    expect(events).toContain("closed:stale");
    expect(events).not.toContain("closed:fresh");
    registry.dispose();
  });

  it("has/peek do not create handles; closeAll only closes tracked sessions", async () => {
    const registry = new SessionRegistry({ binaryPath: MOCK });
    expect(registry.has("ghost")).toBe(false);
    expect(registry.peek("ghost")).toBeUndefined();
    registry.session("a");
    registry.session("b");
    expect(registry.has("a")).toBe(true);
    expect(registry.peek("a")).toBeDefined();
    await registry.closeAll();
    expect(registry.list()).toHaveLength(0);
    expect(registry.has("a")).toBe(false);
    registry.dispose();
  });

  it("dispose stops the reaper so nothing reaps afterwards", async () => {
    const registry = new SessionRegistry(
      { binaryPath: MOCK },
      { idleTimeoutMs: 10, reapIntervalMs: 15 },
    );
    registry.session("kept");
    registry.dispose();
    const before = registry.list().length;
    await new Promise((r) => setTimeout(r, 60));
    expect(registry.list()).toHaveLength(before);
  });
});
