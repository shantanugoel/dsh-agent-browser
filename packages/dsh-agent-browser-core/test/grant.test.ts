import { describe, expect, it } from "vitest";
import { AgentBrowserClient } from "../src/client.ts";
import { buildChildEnv } from "../src/env.ts";

const MOCK = new URL("./fixtures/mock-agent-browser.mjs", import.meta.url).pathname;

describe("grantAllowedDomains", () => {
  it("merges runtime grants into the effective allowlist", () => {
    const client = new AgentBrowserClient({ binaryPath: MOCK, allowedDomains: ["example.com"] });
    client.grantAllowedDomains(["Internal.Corp", "example.com"]);
    expect(client.allowedDomains).toEqual(["example.com", "internal.corp"]);
    const env = buildChildEnv(process.env, { allowedDomains: client.allowedDomains });
    expect(env["AGENT_BROWSER_ALLOWED_DOMAINS"]).toBe("example.com,internal.corp");
  });

  it("grants on an unrestricted client start a fresh allowlist", () => {
    const client = new AgentBrowserClient({ binaryPath: MOCK });
    expect(client.allowedDomains).toEqual([]);
    client.grantAllowedDomains(["a.test"]);
    expect(client.allowedDomains).toEqual(["a.test"]);
  });
});
