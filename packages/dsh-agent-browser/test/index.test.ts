import { describe, expect, it } from "vitest";
import { SessionRegistry } from "dsh-agent-browser-core";
import { apply } from "../src/index.ts";

const MOCK = new URL("../../dsh-agent-browser-core/test/fixtures/mock-agent-browser.mjs", import.meta.url).pathname;

/** Build a fake ctx, apply the plugin, return the named tool. */
function boot(config: Record<string, unknown> = {}) {
  const tools = new Map<string, { execute: (args: never, exec: never) => Promise<unknown>; timeoutMs?: number }>();
  const registryRef: { current?: SessionRegistry } = {};
  const ctx = {
    tools: { register: (d: { name: string; execute: never; timeoutMs?: number }) => tools.set(d.name, d as never) },
    systemPrompt: { section: () => undefined },
    effect: (_factory: () => unknown, _label: string) => undefined,
    webServer: undefined,
  };
  apply(ctx as never, { binaryPath: MOCK, ...config } as never);
  return { getTool: (name: string) => tools.get(name)! };
}

describe("defaultTimeoutMs budget scaling", () => {
  it("keeps the historical budgets at the default base (60s)", () => {
    const { getTool } = boot();
    expect(getTool("browser_open").timeoutMs).toBe(90_000);
    expect(getTool("browser_snapshot").timeoutMs).toBe(60_000);
    expect(getTool("browser_act").timeoutMs).toBe(180_000);
    expect(getTool("browser_get").timeoutMs).toBe(45_000);
    expect(getTool("browser_eval").timeoutMs).toBe(30_000);
    expect(getTool("browser_screenshot").timeoutMs).toBe(60_000);
  });

  it("scales every per-operation budget from an explicit base", () => {
    const { getTool } = boot({ defaultTimeoutMs: 10_000 });
    expect(getTool("browser_open").timeoutMs).toBe(15_000); // nav 1.5×
    expect(getTool("browser_snapshot").timeoutMs).toBe(10_000); // snapshot 1×
    expect(getTool("browser_act").timeoutMs).toBe(30_000); // act 3×
    expect(getTool("browser_get").timeoutMs).toBe(7_500); // read 0.75×
    expect(getTool("browser_eval").timeoutMs).toBe(5_000); // eval 0.5×
    expect(getTool("browser_screenshot").timeoutMs).toBe(10_000); // shot 1×
  });
});

describe("browser_get cookies redaction", () => {
  it("redacts cookie values by default (cookiesRedacted: true)", async () => {
    const { getTool } = boot();
    const res = (await getTool("browser_get").execute({ what: "cookies" } as never, {} as never)) as {
      data: Array<{ value: string }>;
    };
    expect(Array.isArray(res.data)).toBe(true);
    for (const cookie of res.data) expect(cookie.value).toBe("[redacted]");
  });

  it("passes values through when cookiesRedacted is false", async () => {
    const { getTool } = boot({ cookiesRedacted: false });
    const res = (await getTool("browser_get").execute({ what: "cookies" } as never, {} as never)) as {
      data: Array<{ value: string }>;
    };
    // The mock's raw value survives untouched.
    expect(res.data[0]!.value).toBe("redacted-by-driver");
  });

  it("browser_eval fails closed without an approval service", async () => {
    const { getTool } = boot();
    await expect(
      getTool("browser_eval").execute({ js: "1+1" } as never, { signal: undefined } as never),
    ).rejects.toThrow(/not permitted/);
  });

  it("browser_eval allows through when allowEval is true", async () => {
    const { getTool } = boot({ allowEval: true });
    const res = (await getTool("browser_eval").execute({ js: "1+1" } as never, { signal: undefined } as never)) as {
      result: unknown;
    };
    expect(res.result).toBeDefined();
  });

  it("browser_open denies off-list domains without approval", async () => {
    const { getTool } = boot({ allowedDomains: ["example.com"] });
    await expect(
      getTool("browser_open").execute({ url: "https://evil.test/" } as never, {} as never),
    ).rejects.toThrow(/allowlist/);
  });

  it("browser_open allows listed domains", async () => {
    const { getTool } = boot({ allowedDomains: ["example.com"] });
    const res = (await getTool("browser_open").execute(
      { url: "https://example.com/" } as never,
      {} as never,
    )) as { url?: string };
    expect(res.url).toBeDefined();
  });

  it("browser_session stop drops the registry handle", async () => {
    const { getTool } = boot();
    await getTool("browser_snapshot").execute({} as never, {} as never);
    const before = (await getTool("browser_session").execute({ action: "list" } as never, {} as never)) as {
      sessions: unknown[];
    };
    expect(before.sessions.length).toBeGreaterThan(0);
    await getTool("browser_session").execute({ action: "stop" } as never, {} as never);
    const after = (await getTool("browser_session").execute({ action: "list" } as never, {} as never)) as {
      sessions: unknown[];
    };
    expect(after.sessions).toHaveLength(0);
  });

  it("browser_eval honors an allowed-once approval", async () => {
    let asked = false;
    const tools = new Map<string, { execute: (args: never, exec: never) => Promise<unknown> }>();
    const ctx = {
      tools: { register: (d: { name: string; execute: never }) => tools.set(d.name, d as never) },
      systemPrompt: { section: () => undefined },
      effect: () => undefined,
      approval: {
        request: (req: { reason?: string }) => {
          void req;
          asked = true;
          return Promise.resolve("allowed-once");
        },
      },
    };
    apply(ctx as never, { binaryPath: MOCK } as never);
    const res = (await tools.get("browser_eval")!.execute(
      { js: "2+2" } as never,
      { signal: undefined, agent: { id: "a1" }, callId: "c1" } as never,
    )) as { result: unknown };
    expect(asked).toBe(true);
    expect(res.result).toBeDefined();
  });
});
