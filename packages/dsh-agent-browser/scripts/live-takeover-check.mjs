// LIVE end-to-end: frames + console feed + HUMAN-takeover click through the proxy.
process.env["HOME"] = process.env["MOCK_HOME"];
import { createServer } from "node:http";
import { SessionRegistry } from "dsh-agent-browser-core";
import { mountPanel } from "../lib/panel.js";
import { WebSocket } from "ws";

const session = process.env["SESSION"] || "s2";
const registry = new SessionRegistry({
  binaryPath: process.env["AB_BIN"],
  launchArgs: ["--no-sandbox", "--disable-crashpad"],
});
registry.session(session);

const PAGE = "data:text/html," + encodeURIComponent(
  "<body style='margin:0'>" +
  "<button id=\"go\" onclick=\"document.title='CLICKED';console.log('click-landed')\" " +
  "style='position:absolute;left:100px;top:100px;width:240px;height:80px;font-size:28px'>GO</button>" +
  "</body>",
);
await registry.client.call(["open", PAGE], { session });
await new Promise((r) => setTimeout(r, 600));

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
}, registry, { autoOpenPanel: false, takeoverEnabled: true, maxFps: 24 });

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

// Hold takeover for this session via the HTTP toggle.
const tr = await fetch(`http://127.0.0.1:${port}/browser/takeover`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ session, enabled: true }),
});
console.log("takeover hold:", await tr.json());

const ws = new WebSocket(`ws://127.0.0.1:${port}/browser/stream?session=${session}&maxFps=24&pacing=ack&input=1`);
ws.binaryType = "arraybuffer";

let sawFrame = false;
let sawConsole = false;
const consoleLines = [];

function send(obj) { ws.send(JSON.stringify(obj)); }

ws.on("message", async (data, isBinary) => {
  const msg = JSON.parse(data.toString("utf8"));
  if (msg.type === "frame") {
    if (!sawFrame) { sawFrame = true; console.log("first frame bytes:", Buffer.byteLength(msg.data, "base64")); }
    // Click the GO button (device px): press -> release -> click
    if (sawFrame && !globalThis.__clicked) {
      globalThis.__clicked = true;
      send({ type: "input_mouse", eventType: "mousePressed", x: 220, y: 140, button: "left", clickCount: 1, modifiers: 0 });
      send({ type: "input_mouse", eventType: "mouseReleased", x: 220, y: 140, button: "left", clickCount: 0, modifiers: 0 });
    }
    if (msg.seq !== undefined && ws.readyState === WebSocket.OPEN) send({ type: "ack", seq: msg.seq });
    return;
  }
  if (msg.type === "url") console.log("url msg:", String(msg.url).slice(0, 40));
});

setTimeout(async () => { try { await registry.client.call(["eval", "--stdin"], { session, stdin: "console.log('hello-from-page')" }); } catch {} }, 2500);

const deadline = Date.now() + 20000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
  const title = await registry.session(session).get("title").catch(() => null);
  if (title === "CLICKED") break;
}
const finalTitle = await registry.session(session).get("title");
console.log("FINAL TITLE:", finalTitle);
console.log("RESULT:", finalTitle === "CLICKED" ? "TAKEOVER CLICK LANDED" : "CLICK DID NOT LAND");
ws.close(); server.close(); process.exit(finalTitle === "CLICKED" ? 0 : 1);
