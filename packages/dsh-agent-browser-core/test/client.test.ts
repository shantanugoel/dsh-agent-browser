import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentBrowserClient } from "../src/client.ts";
import { BatchStepError, CallTimeoutError, CommandFailedError, ProtocolViolationError } from "../src/errors.ts";

const MOCK = new URL("./fixtures/mock-agent-browser.mjs", import.meta.url).pathname;

describe("AgentBrowserClient", () => {
  let home: string;
  beforeAll(() => {
    home = mkdtempSync(path.join(os.tmpdir(), "abc-test-"));
    process.env["MOCK_HOME"] = home;
  });
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function makeClient(): AgentBrowserClient {
    return new AgentBrowserClient({ binaryPath: MOCK });
  }

  it("resolves the fixture and runs a JSON call, stripping lifecycle", async () => {
    const client = makeClient();
    expect(client.binary().via).toBe("explicit");
    const res = await client.call<{ url?: string }>(["get", "url"]);
    expect(res.data.url).toBe("https://example.com/");
    // Raw envelope keeps the lifecycle block; stripped data must not.
    expect((res.envelope.data as Record<string, unknown>)["lifecycle"]).toBeDefined();
    expect((res.data as Record<string, unknown>)["lifecycle"]).toBeUndefined();
  });

  it("passes --json and --session ahead of the command argv", async () => {
    const client = makeClient();
    await client.call(["open", "https://second.example/"], { session: "alpha" });
    const log = readFileSync(path.join(home, ".agent-browser", "alpha.mocklog"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { argv: string[] });
    // The mock strips global flags; assert the command itself arrived intact
    // and that a sidecar for the session exists (proves --session was parsed).
    expect(log.at(-1)!.argv).toEqual(["open", "https://second.example/"]);
    expect(existsSync(path.join(home, ".agent-browser", "alpha.stream"))).toBe(true);
  });

  it("throws CommandFailedError on failure envelopes with classified codes", async () => {
    const client = makeClient();
    await expect(client.call(["fail", "Element not found: @e7"])).rejects.toMatchObject({
      name: "CommandFailedError",
      code: "ref_not_found",
    });
    try {
      await client.call(["fail", "tab_gone"]);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CommandFailedError);
      expect((err as CommandFailedError).code).toBe("tab_gone");
    }
  });

  it("throws ProtocolViolationError when stdout is not the envelope", async () => {
    const client = makeClient();
    process.env["MOCK_PRINT_GARBAGE"] = "1";
    try {
      await expect(client.call(["get", "url"])).rejects.toBeInstanceOf(ProtocolViolationError);
    } finally {
      delete process.env["MOCK_PRINT_GARBAGE"];
    }
  });

  it("enforces cooperative timeouts and kills the child", async () => {
    const client = makeClient();
    process.env["MOCK_DELAY_MS"] = "5000";
    try {
      await expect(client.call(["get", "url"], { timeoutMs: 200 })).rejects.toBeInstanceOf(CallTimeoutError);
    } finally {
      delete process.env["MOCK_DELAY_MS"];
    }
  }, 10_000);

  describe("batch", () => {
    it("runs steps via stdin and cleans lifecycle out of results", async () => {
      const client = makeClient();
      const { results } = await client.batch([
        ["click", "@e1"],
        ["get", "title"],
        ["boom"],
      ]);
      expect(results).toHaveLength(3);
      expect(results[0]!.success).toBe(true);
      expect(results[0]!.result && (results[0].result as Record<string, unknown>)["ok"]).toBe(true);
      expect(results[0]!.result && "lifecycle" in results[0]!.result!).toBe(false);
      expect(results[2]!.success).toBe(false);
      expect(results[2]!.result).toBeUndefined();
      expect(AgentBrowserClient.hasFailures(results)).toBe(true);
      expect(AgentBrowserClient.summarize(results)).toContain("1/3 step(s) failed");
    });

    it("bails at the first failing step when bail is set", async () => {
      const client = makeClient();
      await expect(
        client.batch([["get", "title"], ["boom"], ["get", "url"]], { bail: true }),
      ).rejects.toBeInstanceOf(BatchStepError);
    });

    it("returns an empty result list for zero steps without spawning", async () => {
      const client = makeClient();
      const { results } = await client.batch([]);
      expect(results).toEqual([]);
    });
  });
});


describe("stripLifecycle array preservation", () => {
  it("keeps top-level arrays as arrays", async () => {
    const { stripLifecycle } = await import("../src/types.ts");
    const input = [{ name: "a", value: "v", lifecycle: 1 }, { name: "b" }];
    const out = stripLifecycle(input);
    expect(Array.isArray(out)).toBe(true);
    expect(out).toEqual([{ name: "a", value: "v" }, { name: "b" }]);
  });

  it("strips nested arrays inside objects without converting them", async () => {
    const { stripLifecycle } = await import("../src/types.ts");
    const out = stripLifecycle({ lifecycle: { t: 1 }, cookies: [{ value: "x" }], tabs: [] });
    expect(out).toEqual({ cookies: [{ value: "x" }], tabs: [] });
    expect(Array.isArray((out as { cookies: unknown[] }).cookies)).toBe(true);
  });
});
