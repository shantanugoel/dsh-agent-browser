// LIVE check A: console messages flow through the proxy (activity feed path).
// LIVE check B: the idle reaper closes+drops an untouched throwaway session.
process.env["HOME"] = process.env["MOCK_HOME"];
import { createServer } from "node:http";
import { SessionRegistry } from "dsh-agent-browser-core";
import { mountPanel } from "../lib/panel.js";
import { WebSocket } from "ws";

// ── A) console feed via proxy on the main session
const main = process.env["SESSION"] || "s2";
const registry = new SessionRegistry({
  binaryPath: process.env["AB_BIN"],
  launchArgs: ["--no-sandbox", "--disable-crashpad"],
});
registry.session(main);

const routes = [];
const upgrades = [];
const server = createServer((req, res) => {
  const route = routes.find((r) => r.path === req.url?.split("?")[0]);
  if (!route) { res.writeHead(404).end(); return; }
  void route.handler(req, res);
});
server.on("upgrade", (req, socket, head) => {
  const up = upgrades.find((r) => r.path === req.url?.split("?")[0]);
  if (!up) { socket.destroy(); return; }
  void up.handler(req, socket, head);
});
mountPanel({}, {
  register: (r) => (routes.push(r), () => {}),
  registerUpgrade: (r) => (upgrades.push(r), () => {}),
}, registry, { autoOpenPanel: false, takeoverEnabled: false, maxFps: 12 });

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const ws = new WebSocket(`ws://127.0.0.1:${port}/browser/stream?session=${main}&maxFps=6`);
let consoleSeen = null;
ws.on("message", (data) => {
  try {
    const msg = JSON.parse(data.toString("utf8"));
    if (msg.type === "console" && typeof msg.text === "string" && msg.text.includes("proxy-console-marker")) {
      consoleSeen = msg.text;
    }
  } catch {}
});
await new Promise((r) => ws.on("open", r));

await registry.client.call(["eval", "--stdin"], { session: main, stdin: "console.log('proxy-console-marker-42')" });
const t0 = Date.now();
while (!consoleSeen && Date.now() - t0 < 10000) await new Promise((r) => setTimeout(r, 200));
console.log("A) console-through-proxy:", consoleSeen ? "PASS (" + consoleSeen + ")" : "FAIL");
ws.close();

// B) idle reaper via the REAL timer path.
const reaperRegistry = new SessionRegistry(
  { binaryPath: process.env["AB_BIN"], launchArgs: ["--no-sandbox", "--disable-crashpad"] },
  { idleTimeoutMs: 1200, reapIntervalMs: 300 },
);
const closed = [];
reaperRegistry.on((e) => { if (e.type === "closed") closed.push(e.name ?? "default"); });
const tmp = reaperRegistry.session("tmp-reap", { label: "reaper-check" });
await tmp.open("about:blank");
console.log("B) tracked:", reaperRegistry.list().map((e) => e.name).join(","));
await new Promise((r) => setTimeout(r, 3000));
const names = reaperRegistry.list().map((e) => e.name);
console.log("B) after wait:", JSON.stringify(names), "closedEvents:", JSON.stringify(closed));
console.log("B) reaper:", !names.includes("tmp-reap") && closed.includes("tmp-reap") ? "PASS" : "FAIL");
server.close();
process.exit(consoleSeen && !names.includes("tmp-reap") ? 0 : 1);
