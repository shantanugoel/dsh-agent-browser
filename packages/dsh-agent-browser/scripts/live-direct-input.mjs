// Bypass the proxy: talk to the daemon stream port directly to learn the
// exact input event contract.
process.env["HOME"] = process.env["MOCK_HOME"];
import { SessionRegistry } from "dsh-agent-browser-core";
import { resolveStreamPort } from "dsh-agent-browser-core";
import { WebSocket } from "ws";

const session = process.env["SESSION"] || "s2";
const registry = new SessionRegistry({
  binaryPath: process.env["AB_BIN"],
  launchArgs: ["--no-sandbox", "--disable-crashpad"],
});
registry.session(session);
const client = registry.client;

const PAGE = "data:text/html," + encodeURIComponent(
  "<body style='margin:0'>" +
  "<button id=\"go\" onclick=\"document.title='CLICKED';console.log('click-landed')\" " +
  "style='position:absolute;left:100px;top:100px;width:240px;height:80px;font-size:28px'>GO</button>" +
  "</body>",
);
await client.call(["open", PAGE], { session });
await new Promise((r) => setTimeout(r, 600));

const port = await resolveStreamPort(client, session);
console.log("daemon stream port:", port);
const meta = await client.call(["stream", "status"], { session });
console.log("stream status:", JSON.stringify(meta.data).slice(0, 200));

const ws = new WebSocket(`ws://127.0.0.1:${port}/?maxFps=24&pacing=ack`);
ws.binaryType = "arraybuffer";
let gotMeta = null;
ws.on("message", (data, isBinary) => {
  const msg = JSON.parse(data.toString("utf8"));
  if (msg.type === "frame") {
    if (!gotMeta) {
      gotMeta = msg.metadata;
      console.log("frame metadata:", JSON.stringify(msg.metadata));
      // try several coordinate systems / vocabularies
      send({ type: "input_mouse", eventType: "mouse_clicked", x: 220, y: 140, button: "left", clickCount: 1 });
      setTimeout(() => send({ type: "input_mouse", eventType: "clicked", x: 220, y: 140, button: "left", clickCount: 1 }), 300);
      setTimeout(() => send({ type: "input_mouse", eventType: "click", x: 220, y: 140, button: "left", clickCount: 1 }), 600);
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ack", seq: msg.seq }));
  }
  if (msg.type !== "frame") console.log("ctl:", msg.type, JSON.stringify(msg).slice(0, 120));
});
function send(o) { ws.send(JSON.stringify(o)); }
await new Promise((r) => ws.on("open", r));

const deadline = Date.now() + 15000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
  const title = await registry.session(session).get("title").catch(() => "?");
  if (title === "CLICKED") break;
}
console.log("FINAL TITLE:", await registry.session(session).get("title").catch(() => "?"));
ws.close();
process.exit(0);
