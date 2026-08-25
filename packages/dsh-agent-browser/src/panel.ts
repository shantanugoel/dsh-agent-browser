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
 * CSRF fence for STATE-CHANGING requests. Browsers attach an Origin header to
 * cross-site POSTs even under no-cors, and a text/plain body still parses as
 * JSON here — so without this check a hostile webpage could drive a live
 * daemon's tabs from the operator's browser. Requests WITHOUT Origin
 * (curl, same-process callers) pass; loopback binding stays the outer gate.
 */
function writeAllowed(req: IncomingMessage): boolean {
  return originAllowed(req, req.headers.host ?? "");
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

  // Sessions with human takeover currently held (input forwarding allowed).
  // Scoped to THIS mount (not module-global) and self-cleaning: whenever the
  // registry reports a session closed — explicit stop, stopAll, or the idle
  // reaper — its held flag drops so a respawned daemon starts read-only.
  const takeoverHeld = new Set<string>();
  const onRegistryEvent = (event: { type?: string; name?: string | null }) => {
    if (event.type !== "closed") return;
    if (typeof event.name === "string" && event.name.length > 0) takeoverHeld.delete(event.name);
    else takeoverHeld.delete("__default__");
  };
  const disposeRegistryListener = registry.on?.(onRegistryEvent);

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
      if (!writeAllowed(req)) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "cross-site write rejected" }));
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

  // Browser-tab management for the panel's tab strip: HUMAN-initiated only
  // (sidebar/pop-out controls), never model-callable — the model has its own
  // browser_tabs tool. GET lists the session's tabs; POST switches, opens,
  // or closes one and returns the fresh list.
  const disposeTabStrip = webServer.register({
    kind: "exact",
    path: "/browser/tabs",
    handler: async (req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const session = url.searchParams.get("session") ?? undefined;
      if (req.method === "GET") {
        try {
          // Never get-or-create here: a stray GET must not boot Chrome.
          const existing = registry.peek(session);
          const tabs = existing ? await existing.tabs() : [];
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, tabs }));
        } catch (err) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String((err as Error)?.message ?? err), tabs: [] }));
        }
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      if (!writeAllowed(req)) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "cross-site write rejected", tabs: [] }));
        return;
      }
      let body = "";
      for await (const chunk of req) body += String(chunk);
      try {
        const parsed = JSON.parse(body || "{}") as {
          session?: string | null;
          action?: "switch" | "new" | "close";
          tab?: string;
          url?: string;
          label?: string;
        };
        const sess = registry.session(parsed.session ?? undefined);
        switch (parsed.action) {
          case "switch":
            if (!parsed.tab) throw new Error("switch requires tab");
            await sess.tabSwitch(parsed.tab);
            break;
          case "close":
            if (!parsed.tab) throw new Error("close requires tab");
            await sess.tabClose(parsed.tab);
            break;
          case "new":
            await sess.tabNew(parsed.url, parsed.label);
            break;
          default:
            throw new Error(`unknown action ${String(parsed.action)}`);
        }
        const tabs = await sess.tabs();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, tabs }));
      } catch (err) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String((err as Error)?.message ?? err), tabs: [] }));
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
        const key = entry.name ?? "__default__";
        rows.push({
          name: entry.name ?? null,
          label: entry.label ?? null,
          createdAt: entry.createdAt,
          lastUsedAt: entry.lastUsedAt,
          takeover: config.takeoverEnabled === true && takeoverHeld.has(key),
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
    disposeTabStrip();
    disposeTakeover();
    disposeUpgrade();
    disposeRegistryListener?.();
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
  #tabstrip { display: none; gap: 4px; align-items: center; padding: 4px 10px; border-bottom: 1px solid #2a2a2e; overflow-x: auto; }
  .btab { display: inline-flex; align-items: center; gap: 4px; max-width: 160px; padding: 2px 6px; font-size: 11px;
          border-radius: 6px; cursor: pointer; white-space: nowrap; color: inherit; background: transparent;
          border: 1px solid transparent; }
  .btab.active { background: #26262b; border-color: #444; }
  .btab span { overflow: hidden; text-overflow: ellipsis; }
  .btab button { all: unset; cursor: pointer; opacity: .6; padding: 0 3px; }
  .btab button:hover { opacity: 1; }
  #newtab { all: unset; cursor: pointer; padding: 0 6px; font-size: 13px; opacity: .7; }
  #newtab:hover { opacity: 1; }
  canvas { width: 100%; height: auto; background: #111; flex: 1; object-fit: contain; }
  main { flex: 1; display: flex; align-items: center; justify-content: center; min-height: 0; }
  #status { opacity: .7; }
</style>
</head>
<body>
<header><strong>Browser live view</strong><span id="status">connecting…</span></header>
<div id="tabstrip"></div>
<main><canvas id="view" width="1280" height="720"></canvas></main>
<script>
(() => {
  const params = new URLSearchParams(location.search);
  const status = document.getElementById("status");
  const canvas = document.getElementById("view");
  const strip = document.getElementById("tabstrip");
  const p = new URLSearchParams({ maxFps: "24", pacing: "ack" });
  const session = params.get("session");
  if (session) p.set("session", session);

  // ── browser tab strip (human-driven; same-origin /browser/tabs routes) ──
  const normTabs = (raw) => {
    const list = Array.isArray(raw) ? raw : Array.isArray(raw && raw.tabs) ? raw.tabs : [];
    return list.slice(0, 16).map((t, i) => ({
      id: String((t && (t.tabId ?? t.id ?? t.targetId)) ?? "t" + (i + 1)),
      title: typeof (t && t.title) === "string" ? t.title : "",
      url: typeof (t && t.url) === "string" ? t.url : "",
      active: Boolean(t && t.active),
    }));
  };
  const renderTabs = (tabs) => {
    if (!strip) return;
    if (!tabs || tabs.length === 0) { strip.style.display = "none"; strip.textContent = ""; return; }
    strip.style.display = "flex";
    strip.textContent = "";
    for (const t of tabs) {
      const chip = document.createElement("span");
      chip.className = "btab" + (t.active ? " active" : "");
      chip.title = t.title ? t.title + "\n" + t.url : t.url;
      const label = document.createElement("span");
      label.textContent = t.title || t.url || t.id;
      chip.append(label);
      if (t.active) {
        chip.onclick = null;
      } else {
        chip.onclick = () => postTab({ action: "switch", tab: t.id });
        const close = document.createElement("button");
        close.textContent = "\u00d7";
        close.title = "Close tab " + t.id;
        close.onclick = (ev) => { ev.stopPropagation(); postTab({ action: "close", tab: t.id }); };
        chip.append(close);
      }
      strip.append(chip);
    }
    const plus = document.createElement("button");
    plus.id = "newtab";
    plus.textContent = "+";
    plus.title = "New tab (about:blank)";
    plus.onclick = () => postTab({ action: "new" });
    strip.append(plus);
  };
  const postTab = async (body) => {
    try {
      const res = await fetch("/browser/tabs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session, ...body }),
      });
      if (res.ok) renderTabs(normTabs((await res.json()).tabs));
    } catch {}
  };
  const refreshTabs = async () => {
    try {
      const q = session ? "?session=" + encodeURIComponent(session) : "";
      const res = await fetch("/browser/tabs" + q, { headers: { accept: "application/json" } });
      if (res.ok) renderTabs(normTabs((await res.json()).tabs));
    } catch {}
  };
  void refreshTabs();
  setInterval(refreshTabs, 5000);
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
      if (msg.type === "tabs") { renderTabs(normTabs(msg.tabs)); return; }
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
