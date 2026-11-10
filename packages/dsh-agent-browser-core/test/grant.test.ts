import { describe, expect, it } from "vitest";
import { AgentBrowserClient } from "../src/client.ts";
import { buildChildEnv, defaultHostEnv, defaultHostStateDir } from "../src/env.ts";

const MOCK = new URL("./fixtures/mock-agent-browser.mjs", import.meta.url).pathname;

describe("grantAllowedDomains", () => {
  it("merges runtime grants into the effective allowlist", () => {
    const client = new AgentBrowserClient({ binaryPath: MOCK, allowedDomains: ["example.com"] });
    client.grantAllowedDomains(["Internal.Corp", "example.com"]);
    expect(client.allowedDomains).toEqual(["example.com", "internal.corp"]);
    const env = buildChildEnv(process.env, { allowedDomains: client.allowedDomains });
    expect(env["AGENT_BROWSER_ALLOWED_DOMAINS"]).toBe("example.com,internal.corp");
  });

  it("defaultHostStateDir keeps its legacy pre-0.42 shape", () => {
    expect(defaultHostStateDir({ DSH_HOME: "/tmp/dsh-x" })).toBe("/tmp/dsh-x/agent-browser");
    expect(defaultHostStateDir({})).toBeUndefined();
    expect(defaultHostStateDir({}, "/fallback")).toBe("/fallback");
  });

  it("defaultHostEnv derives a stable namespace and short socket dir from DSH_HOME", () => {
    const env = defaultHostEnv({ DSH_HOME: "/tmp/dsh-x" });
    expect(env).toMatchObject({
      AGENT_BROWSER_NAMESPACE: expect.stringMatching(/^dsh-[0-9a-f]{12}$/),
      AGENT_BROWSER_SOCKET_DIR: expect.stringMatching(/dsh-ab-[0-9a-f]{8}$/),
    });
    expect(defaultHostEnv({ DSH_HOME: "/tmp/dsh-x" })).toEqual(env);
    expect(defaultHostEnv({ DSH_HOME: "/tmp/dsh-y" })).not.toEqual(env);
    expect(defaultHostEnv({})).toBeUndefined();
    expect(defaultHostEnv({}, "/fallback")).toMatchObject({
      AGENT_BROWSER_NAMESPACE: expect.stringMatching(/^dsh-[0-9a-f]{12}$/),
    });
  });

  it("grants on an unrestricted client start a fresh allowlist", () => {
    const client = new AgentBrowserClient({ binaryPath: MOCK });
    expect(client.allowedDomains).toEqual([]);
    client.grantAllowedDomains(["a.test"]);
    expect(client.allowedDomains).toEqual(["a.test"]);
  });
});
