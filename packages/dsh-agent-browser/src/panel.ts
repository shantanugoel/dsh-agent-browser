/**
 * Server half of the baked-in live view: an authenticated localhost WS proxy
 * over agent-browser's per-session JPEG viewport stream, plus a tiny session
 * inventory endpoint the panel consumes.
 *
 * Design notes:
 * - No raw ports are exposed. Browsers talk ONLY to the DSH web server
 *   (same-origin); this module dials 127.0.0.1:<streamPort> itself.
 * - Frames flow with ack pacing and a conservative fps cap so a hidden panel
 *   never floods the machine; input forwarding is opt-in per connection
 *   (?input=1) AND gated on config.takeoverEnabled — read-only by default.
 *
 * @module dsh-agent-browser/panel
 */

import { WebSocketServer, WebSocket, type WebSocket as WsSocket } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { resolveStreamPort, SessionRegistry } from "dsh-agent-browser-core";

export interface PanelConfig {
  autoOpenPanel: boolean;
  /** Optional live counters surfaced in the inventory payload (§6 instrumentation). */
  metrics?: () => Record<string, number>;
  /** Forward human pointer/keyboard input while takeover is held. Default false. */
  takeoverEnabled?: boolean;
  /** Cap for frames delivered to one panel client. Default 12. */
  maxFps?: number;
}

/** Sessions with human takeover currently held (input forwarding allowed). */
const takeoverHeld = new Set<string>();

interface WebServerLike {
  register(route: { kind: "exact" | "prefix"; path: string; handler: (req: IncomingMessage, res: import("node:http").ServerResponse) => void | Promise<void> }): () => void;
  registerUpgrade(route: { path: string; handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void> }): () => void;
}

/** Same-origin guard: browser clients may only connect through our own host. */
function originAllowed(req: IncomingMessage, selfHost: string): boolean {
  const origin = req.headers["origin"];
  if (!origin) return true; // non-browser clients pass; the server binds loopback anyway
  try {
    return new URL(origin).host === selfHost;
  } catch {
    return false;
  }
}

/**
 * Mount the panel's HTTP + upgrade routes onto the host web server.
 * @returns disposer removing both routes and closing live proxies.
 */
export function mountPanel(
  ctx: unknown,
  webServer: WebServerLike,
  registry: SessionRegistry,
  config: PanelConfig,
): () => void {
  const wss = new WebSocketServer({ noServer: true });
  const upstreams = new Set<WsSocket>();

  // Human-takeover toggle: HUMAN-initiated only (panel button / pop-out), never
  // model-callable; gated on the static config switch.
  const disposeTakeover = webServer.register({
    kind: "exact",
    path: "/browser/takeover",
    handler: async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      let body = "";
      for await (const chunk of req) body += String(chunk);
      try {
        const parsed = JSON.parse(body || "{}") as { session?: string | null; enabled?: boolean };
        const key = parsed.session ?? "__default__";
        if (parsed.enabled === true) {
          if (config.takeoverEnabled !== true) {
            res.writeHead(403, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "takeover disabled by configuration" }));
            return;
          }
          takeoverHeld.add(key);
        } else {
          takeoverHeld.delete(key);
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, held: takeoverHeld.has(key) }));
      } catch {
        res.writeHead(400).end();
      }
    },
  });

  // Pop-out tab: a standalone same-origin viewer page.
  const disposeViewer = webServer.register({
    kind: "exact",
    path: "/browser/viewer",
    handler: async (req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(viewerHtml());
    },
  });

  // Session inventory for the panel's open/close controls.
  const disposeInventory = webServer.register({
    kind: "exact",
    path: "/browser/sessions",
    handler: async (_req, res) => {
      const rows = [];
      for (const entry of registry.list()) {
        const port = await resolveStreamPort(registry.client, entry.name);
        const key = entry.name ?? "__default__";
        rows.push({
          name: entry.name ?? null,
          label: entry.label ?? null,
          createdAt: entry.createdAt,
          lastUsedAt: entry.lastUsedAt,
          takeover: config.takeoverEnabled === true && takeoverHeld.has(key),
          ...(port !== null ? { streamPort: port } : {}),
        });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        sessions: rows,
        autoOpenPanel: config.autoOpenPanel,
        ...(config.metrics ? { metrics: config.metrics() } : {}),
      }));
    },
  });

  const disposeUpgrade = webServer.registerUpgrade({
    path: "/browser/stream",
    handler: async (req, socket, head) => {
      try {
        if (!originAllowed(req, req.headers.host ?? "")) {
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
        const session = url.searchParams.get("session") ?? undefined;
        const key = session ?? "__default__";
        const wantInput = url.searchParams.get("input") === "1" && config.takeoverEnabled === true && takeoverHeld.has(key);
        const maxFpsRaw = Number(url.searchParams.get("maxFps") ?? config.maxFps ?? 12);
        const maxFps = Math.min(Math.max(Number.isFinite(maxFpsRaw) ? maxFpsRaw : 12, 1), 60);
        const port = await resolveStreamPort(registry.client, session);
        if (port === null) {
          socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (clientWs) => {
          const upstream = new WebSocket(`ws://127.0.0.1:${port}/?pacing=ack&maxFps=${maxFps}`);
          upstreams.add(upstream);
          let upstreamOpen = false;
          upstream.on("open", () => {
            upstreamOpen = true;
          });
          upstream.on("message", (data, isBinary) => {
            try {
              clientWs.send(data, { binary: isBinary });
            } catch {
              /* client vanished */
            }
          });
          upstream.on("close", () => {
            upstreams.delete(upstream);
            try {
              clientWs.close();
            } catch {
              /* already closed */
            }
          });
          upstream.on("error", () => {
            try {
              clientWs.close(1011);
            } catch {
              /* ignore */
            }
          });
          clientWs.on("message", (data, isBinary) => {
            if (!upstreamOpen) return;
            if (!wantInput && !isBinary) {
              let parsed: { type?: string };
              try {
                parsed = JSON.parse(data.toString("utf8")) as { type?: string };
              } catch {
                return;
              }
              // Config + ack messages always pass; pointer/keyboard/touch need takeover.
              if (parsed.type !== "config" && parsed.type !== "ack") return;
            }
            try {
              upstream.send(data, { binary: isBinary });
            } catch {
              /* upstream gone */
            }
          });
          clientWs.on("close", () => {
            try {
              upstream.close();
            } catch {
              /* ignore */
            }
            upstreams.delete(upstream);
          });
        });
      } catch {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      }
    },
  });

  const dispose = () => {
    disposeViewer();
    disposeInventory();
    disposeTakeover();
    disposeUpgrade();
    for (const ws of upstreams) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    upstreams.clear();
    void wss.close();
  };

  // Tie the proxy lifetime to the plugin fiber when a cordis context is given.
  const maybeCtx = ctx as { on?: (event: string, listener: () => void) => void } | null;
  maybeCtx?.on?.("dispose", dispose);
  return dispose;
}

/** Standalone pop-out viewer page (same-origin only; no external assets). */
function viewerHtml(): string {
  return /* html */ `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Browser live view</title>
<style>
  body { margin: 0; background: #141416; color: #ddd; font: 12px system-ui; display: flex; flex-direction: column; height: 100vh; }
  header { padding: 6px 10px; display: flex; gap: 8px; align-items: center; border-bottom: 1px solid #2a2a2e; }
  canvas { width: 100%; height: auto; background: #111; flex: 1; object-fit: contain; }
  main { flex: 1; display: flex; align-items: center; justify-content: center; min-height: 0; }
  #status { opacity: .7; }
</style>
</head>
<body>
<header><strong>Browser live view</strong><span id="status">connecting…</span></header>
<main><canvas id="view" width="1280" height="720"></canvas></main>
<script>
(() => {
  const params = new URLSearchParams(location.search);
  const status = document.getElementById("status");
  const canvas = document.getElementById("view");
  const p = new URLSearchParams({ maxFps: "24", pacing: "ack" });
  const session = params.get("session");
  if (session) p.set("session", session);
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  let bitmap = null;
  let ageMs = null;
  setInterval(() => { if (ageMs !== null) { ageMs += 500; if (ageMs > 4000) status.textContent = Math.round(ageMs / 1000) + "s stale"; } }, 500);
  const ws = new WebSocket(proto + "//" + location.host + "/browser/stream?" + p);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => status.textContent = "live";
  ws.onerror = () => status.textContent = "error";
  ws.onmessage = async (ev) => {
    // daemon sends TEXT JSON (base64 JPEG inside); binary never arrives
    if (typeof ev.data !== "string") return;
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type !== "frame") return;
      const bytes = Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0));
      const next = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
      if (bitmap) bitmap.close();
      bitmap = next; ageMs = 0;
      canvas.width = next.width; canvas.height = next.height;
      canvas.getContext("2d").drawImage(next, 0, 0);
      if (typeof msg.seq === "number") ws.send(JSON.stringify({ type: "ack", seq: msg.seq }));
    } catch {}
  };
})();
</script>
</body>
</html>`;
}
