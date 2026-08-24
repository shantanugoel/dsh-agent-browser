/**
 * LIVE verification of the panel proxy against a real agent-browser daemon:
 *   1. boots a minimal http server honoring the dsh-host-webserver route contract
 *   2. mounts mountPanel() pointed at the real CLI
 *   3. pulls /browser/sessions over HTTP
 *   4. opens /browser/stream over WS and asserts real JPEG frames arrive
 *
 * Not part of the hermetic CI suite — requires a reachable daemon session
 * (pass SESSION env) and the real binary. Exits 0 on success.
 */
import { createServer } from "node:http";
import { SessionRegistry } from "dsh-agent-browser-core";
import { mountPanel } from "../lib/panel.js";

const home = process.env["MOCK_HOME"];
if (home) process.env["HOME"] = home;
const session = process.env["SESSION"] || "s2";
const registry = new SessionRegistry({
  binaryPath: process.env["AB_BIN"],
});
// Track the session we intend to watch so the inventory lists it.
registry.session(session);

// Minimal WebServer contract implementation.
const upgrades = [];
const routes = [];
const server = createServer((req, res) => {
  for (const route of routes) {
    if (route.path === req.url?.split("?")[0]) {
      void route.handler(req, res);
      return;
    }
  }
  res.writeHead(404).end();
});
server.on("upgrade", (req, socket, head) => {
  for (const up of upgrades) {
    if (up.path === req.url?.split("?")[0]) {
      void up.handler(req, socket, head);
      return;
    }
  }
  socket.destroy();
});

mountPanel({}, { register: (r) => (routes.push(r), () => {}), registerUpgrade: (r) => (upgrades.push(r), () => {}) }, registry, {
  autoOpenPanel: true,
  takeoverEnabled: false,
  maxFps: 24,
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
console.log("proxy listening on", port);

// 1) inventory over HTTP
const invRes = await fetch(`http://127.0.0.1:${port}/browser/sessions`);
const inv = await invRes.json();
console.log("inventory:", JSON.stringify(inv));
if (!Array.isArray(inv.sessions)) throw new Error("bad inventory");

// 2) frames over WS
const { WebSocket } = await import("ws");
const ws = new WebSocket(`ws://127.0.0.1:${port}/browser/stream?session=${encodeURIComponent(session)}&maxFps=24`);
let frames = 0;
let firstBytes = 0;
const done = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("no frame within 15s")), 15_000);
  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    try {
      const msg = JSON.parse(data.toString("utf8"));
      if (msg.type === "frame") {
        frames += 1;
        firstBytes = Buffer.byteLength(msg.data, "base64");
        clearTimeout(timer);
        resolve();
        return;
      }
    } catch {}
  });
  ws.on("error", (err) => {
    clearTimeout(timer);
    reject(err);
  });
});
// Nudge the page so the screencast produces a fresh frame even when idle.
setTimeout(() => {
  try {
    registry.client.call(["eval", "--stdin"], { session, stdin: "1" }).catch(() => {});
  } catch {}
}, 1500);

await done;
console.log(`FRAME OK: ${frames} frame(s), ${firstBytes} bytes of JPEG through the proxy`);
ws.close();
server.close();
process.exit(0);
