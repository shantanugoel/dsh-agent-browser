/**
 * pi extension: browser tools for pi sessions, over the shared
 * dsh-agent-browser-core driver. Same 9-tool surface as the DSH bundle minus
 * the GUI panel; viewing uses agent-browser's own dashboard command which
 * prints a localhost URL the human can open directly.
 *
 * pi discovers extensions in convention directories (extensions/*.ts next to
 * package.json); each default-exports or named-exports its tool definitions
 * per pi's extension contract (name/description/parameters/execute).
 *
 * @module dsh-agent-browser-pi/browser
 */

import {
  AgentBrowserClient,
  SessionRegistry,
  listSessions,
  stopAllSessions,
  stopSession,
  type ActAction,
} from "dsh-agent-browser-core";

/** Shared registry for this extension's sessions. */
const registry = new SessionRegistry({}, { idleTimeoutMs: 15 * 60_000 });

const client = registry.client;

const resolve = (session?: string) => (session && session.length > 0 ? session : undefined);

/** One pi tool: JSON-schema parameters plus an async execute. */
export interface PiTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<unknown>;
}

function tool<A extends Record<string, unknown>>(
  name: string,
  description: string,
  parameters: Record<string, unknown>,
  run: (args: A) => Promise<unknown>,
): PiTool {
  return { name, description, parameters, execute: run as unknown as PiTool["execute"] };
}

export const tools: PiTool[] = [
  tool(
    "browser_open",
    "Navigate the managed browser to a URL. Returns title and url.",
    {
      type: "object",
      properties: {
        url: { type: "string" },
        session: { type: "string", description: "Named session; omit for default." },
      },
      required: ["url"],
    },
    async (args: { url: string; session?: string }) => {
      const res = await client.call<{ title?: string; url?: string }>(["open", args.url], {
        session: resolve(args.session),
        timeoutMs: 90_000,
      });
      return res.data;
    },
  ),
  tool(
    "browser_snapshot",
    "Accessibility tree with @refs. Re-snapshot after page changes.",
    {
      type: "object",
      properties: {
        interactiveOnly: { type: "boolean" },
        maxChars: { type: "number" },
        session: { type: "string" },
      },
    },
    async (args: { interactiveOnly?: boolean; maxChars?: number; session?: string }) => {
      const snap = await registry.session(resolve(args.session)).snapshot({
        interactiveOnly: args.interactiveOnly !== false,
        ...(args.maxChars !== undefined ? { maxChars: args.maxChars } : {}),
      });
      return snap;
    },
  ),
  tool(
    "browser_act",
    "Run multiple interactions in one call using @refs.",
    {
      type: "object",
      properties: {
        steps: { type: "array", items: { type: "object" } },
        bail: { type: "boolean" },
        session: { type: "string" },
      },
      required: ["steps"],
    },
    async (args: { steps: Array<Record<string, unknown>>; bail?: boolean; session?: string }) => {
      const s = resolve(args.session);
      const actions = args.steps as unknown as ActAction[];
      return registry.session(s).act(actions, { bail: args.bail === true });
    },
  ),
  tool(
    "browser_get",
    "Read url/title/text/console/cookies from the page.",
    {
      type: "object",
      properties: {
        what: { type: "string", enum: ["url", "title", "console", "cookies"] },
        ref: { type: "string" },
        session: { type: "string" },
      },
      required: ["what"],
    },
    async (args: { what: "url" | "title" | "console" | "cookies"; ref?: string; session?: string }) => {
      const sess = registry.session(resolve(args.session));
      switch (args.what) {
        case "url":
          return sess.get("url");
        case "title":
          return sess.get("title");
        case "console":
          return sess.get("console");
        case "cookies":
          return sess.get("cookies");
      }
    },
  ),
  tool(
    "browser_screenshot",
    "Capture a PNG screenshot; returns the saved path.",
    {
      type: "object",
      properties: { fullPage: { type: "boolean" }, outPath: { type: "string" }, session: { type: "string" } },
    },
    async (args: { fullPage?: boolean; outPath?: string; session?: string }) => {
      const shot = await registry.session(resolve(args.session)).screenshot({
        fullPage: args.fullPage === true,
        ...(args.outPath !== undefined ? { outPath: args.outPath } : {}),
      });
      return { path: shot.path, bytes: shot.bytes.length };
    },
  ),
  tool(
    "browser_find",
    "Find interactive elements matching text or a regular expression, with @refs. Cheaper than a snapshot.",
    {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Text substring or /regex/ (e.g. \"/submit/i\")." },
        session: { type: "string" },
      },
      required: ["pattern"],
    },
    async (args: { pattern: string; session?: string }) => {
      const raw = args.pattern;
      const m = /^\/(.*)\/([a-z]*)$/.exec(raw);
      const pattern = m ? new RegExp(m[1]!, m[2]) : raw;
      return registry.session(resolve(args.session)).find(pattern);
    },
  ),
  tool(
    "browser_eval",
    "Evaluate JavaScript in the page and return JSON result. Gated by host approval/policy in DSH; here it is explicit.",
    {
      type: "object",
      properties: { js: { type: "string" }, session: { type: "string" } },
      required: ["js"],
    },
    async (args: { js: string; session?: string }) => {
      const res = await registry.session(resolve(args.session)).evaluate(args.js);
      return { result: res as never };
    },
  ),
  tool(
    "browser_tabs",
    "List open tabs or perform an action (list/new/switch/close). Tab ids (t1, t2, ...) are stable within a session.",
    {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "new", "switch", "close"] },
        url: { type: "string", description: "new action: URL to open." },
        label: { type: "string", description: "new action: optional label." },
        tab: { type: "string", description: "Tab id or label for switch/close." },
        session: { type: "string" },
      },
      required: ["action"],
    },
    async (args: { action: string; url?: string; label?: string; tab?: string; session?: string }) => {
      const sess = registry.session(resolve(args.session));
      if (args.action === "new") {
        await sess.tabNew(args.url, args.label);
      } else if (args.action === "switch") {
        if (!args.tab) throw new Error("switch requires tab");
        await sess.tabSwitch(args.tab);
      } else if (args.action === "close") {
        if (!args.tab) throw new Error("close requires tab");
        await sess.tabClose(args.tab);
      }
      const tabs = await sess.tabs();
      return {
        tabs: tabs.map((t) => ({
          tabId: t.tabId,
          ...(t.title ? { title: t.title } : {}),
          ...(t.url ? { url: t.url } : {}),
          active: t.active,
          ...(t.label ? { label: t.label } : {}),
        })),
      };
    },
  ),
  tool(
    "browser_session",
    "List live browser sessions or close them.",
    {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "stop", "stopAll"] },
        session: { type: "string" },
      },
      required: ["action"],
    },
    async (args: { action: "list" | "stop" | "stopAll"; session?: string }) => {
      switch (args.action) {
        case "list":
          return listSessions(client);
        case "stop":
          await stopSession(client, resolve(args.session));
          return { stopped: true };
        case "stopAll":
          await stopAllSessions(client);
          return { stoppedAll: true };
      }
    },
  ),
];

/** Print the dashboard URL hint when this extension loads in an interactive host. */
export function activate(): void {
  process.env["AGENT_BROWSER_DASHBOARD_HINT"] = "run: agent-browser dashboard start";
}

export default tools;
