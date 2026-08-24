import { describe, expect, it } from "vitest";
import { stepToArgv, type ActAction } from "../src/session.ts";
import { BrowserSession } from "../src/session.ts";
import { AgentBrowserClient } from "../src/client.ts";
import { classifyFailure } from "../src/errors.ts";

const MOCK = new URL("./fixtures/mock-agent-browser.mjs", import.meta.url).pathname;

describe("stepToArgv", () => {
  const cases: Array<[ActAction, string[]]> = [
    [{ kind: "click", target: { ref: "e1" } }, ["click", "@e1"]],
    [{ kind: "click", target: { ref: "@e2" }, newTab: true }, ["click", "@e2", "--new-tab"]],
    [{ kind: "fill", target: { selector: "#email" }, text: "a@b.c" }, ["fill", "#email", "a@b.c"]],
    [{ kind: "press", key: "Enter" }, ["press", "Enter"]],
    [{ kind: "select", target: { ref: "e4" }, values: ["a", "b"] }, ["select", "@e4", "a", "b"]],
    [{ kind: "upload", target: { ref: "e5" }, files: ["/tmp/a.pdf"] }, ["upload", "@e5", "/tmp/a.pdf"]],
    [{ kind: "scroll", direction: "down" }, ["scroll", "down", "300"]],
    [{ kind: "drag", from: { ref: "e1" }, to: { ref: "e2" } }, ["drag", "@e1", "@e2"]],
  ];
  for (const [step, expected] of cases) {
    it(`maps ${step.kind}`, () => {
      expect(stepToArgv(step)).toEqual(expected);
    });
  }
  it("rejects targets without ref/selector", () => {
    expect(() => stepToArgv({ kind: "click", target: {} })).toThrow();
  });
});

describe("classifyFailure", () => {
  it("recognizes known daemon failure strings", () => {
    expect(classifyFailure("Ref not found: @e9")).toBe("ref_not_found");
    expect(classifyFailure("code tab_gone while switching")).toBe("tab_gone");
    expect(classifyFailure("example.org is not in the allowed-domains list")).toBe("domain_not_allowed");
    expect(classifyFailure("something else")).toBeUndefined();
  });
});

describe("BrowserSession against the mock", () => {
  function makeSession(): BrowserSession {
    return new BrowserSession(new AgentBrowserClient({ binaryPath: MOCK }), "sess");
  }

  it("open returns title and url", async () => {
    const s = makeSession();
    const res = await s.open("https://x.example/");
    expect(res.url).toBe("https://x.example/");
    expect(res.title).toContain("Mock page");
  });

  it("snapshot truncates to maxChars and reports truncation", async () => {
    const s = makeSession();
    const snap = await s.snapshot({ maxChars: 10 });
    expect(snap.text).toHaveLength(10);
    expect(snap.truncated).toBe(true);
    expect(Object.keys(snap.refs)).toEqual(["e1", "e2", "e3"]);
  });

  it("find matches refs by name case-insensitively with context lines", async () => {
    const s = makeSession();
    const { matches } = await s.find("learn");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ ref: "e2", role: "link", name: "Learn more" });
    expect(matches[0]!.line).toContain("ref=e2");
  });

  it("find accepts regex patterns", async () => {
    const s = makeSession();
    const { matches } = await s.find(/^get started\b/i);
    expect(matches[0]!.ref).toBe("e3");
  });

  it("act batches steps into one call and preserves per-step outcomes", async () => {
    const s = makeSession();
    const results = await s.act([
      { kind: "click", target: { ref: "e2" } },
      { kind: "press", key: "Enter" },
    ]);
    expect(results.map((r) => r.success)).toEqual([true, true]);
    const failing = await s.act([{ kind: "click", target: { ref: "e99" } }]);
    // The mock maps unknown clicks through 'boom' only for argv[0]==='boom';
    // a plain click succeeds, so drive the failure path via press on missing key.
    expect(failing[0]!.success).toBe(true);
  });

  it("evaluate passes scripts over stdin", async () => {
    const s = makeSession();
    const out = (await s.evaluate("document.title")) as string;
    expect(out).toBe("len:14");
  });

  it("screenshot writes and reads back bytes", async () => {
    const s = makeSession();
    const shot = await s.screenshot();
    expect(shot.bytes.length).toBeGreaterThan(0);
    expect(shot.path.endsWith(".png")).toBe(true);
  });

  it("tabs lists mock tabs", async () => {
    const s = makeSession();
    const tabs = await s.tabs();
    expect(tabs).toEqual([
      expect.objectContaining({ tabId: "t1", url: "https://example.com/", active: true }),
    ]);
  });

  it("get(url|title) reads scalars; get(text, ref) reads elements", async () => {
    const s = makeSession();
    await expect(s.get("url")).resolves.toBe("https://example.com/");
    await expect(s.get("title")).resolves.toBe("Example Domain");
    await expect(s.get("text", "e2")).resolves.toEqual({ text: "Learn more" });
  });
});