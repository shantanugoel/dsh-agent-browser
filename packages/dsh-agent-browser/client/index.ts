/**
 * dsh-agent-browser browser half: the live viewport panel contributed to the
 * web shell's 'shell.overlay' slot (additive list — floats over the app,
 * click-through until opted in). Plain createElement React: no JSX transform
 * in the build pipeline, so the shipped bundle is a tiny CJS factory wrap.
 *
 * The panel talks ONLY to its own origin: GET /browser/sessions for the
 * inventory, WS /browser/stream?session=… for frames. No raw daemon ports.
 *
 * @module dsh-agent-browser/client
 */

import { createElement, useCallback, useEffect, useRef, useState } from "react";

interface SessionRow {
  name: string | null;
  label: string | null;
  createdAt: number;
  lastUsedAt: number;
  /** Server reports whether human-takeover forwarding is held for this row. */
  takeover?: boolean;
  streamPort?: number;
}

interface Inventory {
  sessions: SessionRow[];
  autoOpenPanel: boolean;
}

/** Fetch the driver's session inventory from our own origin. */
async function fetchInventory(): Promise<Inventory | null> {
  try {
    const res = await fetch("/browser/sessions", { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as Inventory;
  } catch {
    return null;
  }
}

/** One live canvas fed by the session's JPEG stream; optional input takeover. */
function Viewer(props: { session: string | null; fps?: number; takeover?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<"connecting" | "live" | "idle" | "error">("connecting");
  const [ageMs, setAgeMs] = useState<number | null>(null);
  const [feed, setFeed] = useState<string[]>([]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let disposed = false;
    let bitmap: ImageBitmap | null = null;
    const fps = props.fps ?? 12;
    const params = new URLSearchParams({ maxFps: String(fps), pacing: "ack" });
    if (props.session) params.set("session", props.session);

    // Age ticker so a stalled stream is visibly stale.
    const ticker = window.setInterval(() => {
      setAgeMs((prev) => (prev === null ? prev : prev + 500));
    }, 500);

    try {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(`${proto}//${location.host}/browser/stream?${params}`);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => setStatus("live");
      wsRef.current = ws;
      ws.onerror = () => setStatus("error");
      ws.onclose = () => setStatus((s) => (disposed ? s : "idle"));
      ws.onmessage = async (ev: MessageEvent) => {
        // The daemon sends every message as TEXT JSON (frames carry base64 JPEG).
        if (typeof ev.data !== "string") return;
        try {
          const msg = JSON.parse(ev.data) as {
            type?: string;
            seq?: number;
            data?: string;
            text?: string;
            url?: string;
          };
          if (msg.type === "console") {
            const line = typeof msg.text === "string" ? msg.text : JSON.stringify(msg);
            setFeed((prev) => [...prev.slice(-4), line.slice(0, 160)]);
            return;
          }
          if (msg.type === "url" && typeof msg.url === "string") {
            setFeed((prev) => [...prev.slice(-4), `→ ${msg.url}`]);
            return;
          }
          if (msg.type !== "frame" || typeof msg.data !== "string") return;
          const bytes = Uint8Array.from(atob(msg.data), (c) => c.charCodeAt(0));
          const next = await createImageBitmap(new Blob([bytes.buffer as ArrayBuffer], { type: "image/jpeg" }));
          bitmap?.close();
          bitmap = next;
          setAgeMs(0);
          const canvas = canvasRef.current;
          if (canvas) {
            const ctx2d = canvas.getContext("2d");
            if (ctx2d) {
              canvas.width = next.width;
              canvas.height = next.height;
              ctx2d.drawImage(next, 0, 0);
            }
          }
          if (msg.seq !== undefined && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ack", seq: msg.seq }));
          }
        } catch {
          /* malformed frame: skip */
        }
      };
    } catch {
      setStatus("error");
    }

    return () => {
      disposed = true;
      window.clearInterval(ticker);
      bitmap?.close();
      wsRef.current = null;
      ws?.close();
    };
  }, [props.session, props.fps]);

  const freshness =
    status === "live" && ageMs === null ? "" : ageMs !== null && ageMs > 3000 ? ` (${Math.round(ageMs / 1000)}s stale)` : "";
  // Forward a canvas mouse event as an input_mouse message scaled to device px.
  const sendMouse = useCallback(
    (eventType: string) => (ev: MouseEvent) => {
      if (!props.takeover || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = Math.round(((ev.clientX - rect.left) / rect.width) * canvas.width);
      const y = Math.round(((ev.clientY - rect.top) / rect.height) * canvas.height);
      const button = ev.button === 2 ? "right" : ev.button === 1 ? "middle" : "left";
      // Daemon contract (from agent-browser's own dashboard): camelCase
      // eventTypes, clickCount 1 only on press, modifiers bitfield.
      const mods =
        (ev.altKey ? 1 : 0) | (ev.ctrlKey ? 2 : 0) | (ev.metaKey ? 4 : 0) | (ev.shiftKey ? 8 : 0);
      wsRef.current.send(
        JSON.stringify({
          type: "input_mouse",
          eventType,
          x,
          y,
          button,
          clickCount: eventType === "mousePressed" ? 1 : 0,
          modifiers: mods,
        }),
      );
    },
    [props.takeover],
  );

  // Forward canvas keyboard events per the daemon contract.
  const sendKey = useCallback((eventType: "keyDown" | "keyUp") => (ev: KeyboardEvent) => {
    if (!props.takeover || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    ev.preventDefault();
    ev.stopPropagation();
    const text = eventType === "keyDown" && ev.key.length === 1 ? ev.key : undefined;
    wsRef.current.send(
      JSON.stringify({
        type: "input_keyboard",
        eventType,
        key: ev.key,
        code: ev.code,
        ...(text !== undefined ? { text } : {}),
        windowsVirtualKeyCode: ev.key.length === 1 ? ev.key.charCodeAt(0) : 0,
        modifiers: (ev.altKey ? 1 : 0) | (ev.ctrlKey ? 2 : 0) | (ev.metaKey ? 4 : 0) | (ev.shiftKey ? 8 : 0),
      }),
    );
  }, [props.takeover]);

  return createElement(
    "div",
    { style: { display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: 1 } },
    createElement("canvas", {
      ref: canvasRef,
      width: 640,
      height: 360,
      tabIndex: 0,
      style: {
        width: "100%",
        height: "auto",
        background: "#111",
        borderRadius: 8,
        cursor: props.takeover ? "crosshair" : "default",
        outline: "none",
      },
      onMouseDown: sendMouse("mousePressed"),
      onMouseUp: sendMouse("mouseReleased"),
      onMouseMove: props.takeover ? sendMouse("mouseMoved") : undefined,
      onContextMenu: (e: MouseEvent) => e.preventDefault(),
      onKeyDown: props.takeover ? sendKey("keyDown") : undefined,
      onKeyUp: props.takeover ? sendKey("keyUp") : undefined,
      onWheel: props.takeover
        ? (e: WheelEvent) => {
            if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
            e.preventDefault();
            const canvas = canvasRef.current;
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            const x = Math.round(((e.clientX - rect.left) / rect.width) * canvas.width);
            const y = Math.round(((e.clientY - rect.top) / rect.height) * canvas.height);
            wsRef.current.send(
              JSON.stringify({
                type: "input_mouse",
                eventType: "mouseWheel",
                x,
                y,
                button: "none",
                clickCount: 0,
                deltaX: e.deltaX,
                deltaY: e.deltaY,
              }),
            );
          }
        : undefined,
    }),
    createElement(
      "div",
      { style: { fontSize: 11, opacity: 0.7 } },
      `${status}${freshness} · session: ${props.session ?? "default"}${props.takeover ? " · takeover ON" : ""}`,
    ),
    feed.length > 0
      ? createElement(
          "div",
          { style: { fontSize: 10, opacity: 0.6, maxHeight: 64, overflow: "hidden", whiteSpace: "pre-wrap" } },
          feed.join("\n"),
        )
      : null,
  );
}

/** The overlay panel: inventory chip, viewer, open/close/pin/pop-out controls. */
export function BrowserPanel() {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(true);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const inv = await fetchInventory();
      if (!alive || inv === null) return;
      setInventory(inv);
      setOpen((prev) => prev || (inv.autoOpenPanel && inv.sessions.length > 0));
      setPicked((prev) => prev ?? inv.sessions[0]?.name ?? null);
    };
    void poll();
    const timer = window.setInterval(poll, 2500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  const popOut = useCallback(() => {
    const q = picked ? `?session=${encodeURIComponent(picked)}` : "";
    window.open(`/browser/viewer${q}`, "_blank", "width=900,height=700");
  }, [picked]);

  const names = inventory?.sessions.map((s) => s.name ?? "(default)") ?? [];
  const activeRow = inventory?.sessions.find((s) => (s.name ?? null) === picked);
  const toggleTakeover = useCallback(async () => {
    const res = await fetch("/browser/takeover", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: picked, enabled: !(activeRow?.takeover ?? false) }),
    });
    if (res.ok) {
      const inv = await fetchInventory();
      if (inv) setInventory(inv);
    }
  }, [picked, activeRow?.takeover]);

  return createElement(
    "div",
    {
      "data-browser-panel": open ? "open" : "closed",
      style: {
        position: "absolute",
        right: 12,
        bottom: 12,
        zIndex: 30,
        maxWidth: pinned ? 420 : 320,
        pointerEvents: open ? "auto" : "none",
        background: "var(--dsw-alias-bg-base, #1b1b1f)",
        border: "1px solid var(--dsw-alias-border-l2, #333)",
        borderRadius: 12,
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        boxShadow: "0 8px 24px rgba(0,0,0,.25)",
      },
    },
    createElement(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 6 } },
      createElement(
        "button",
        {
          onClick: () => setOpen((v) => !v),
          style: { cursor: "pointer", fontSize: 12 },
          title: "Toggle the live browser panel",
        },
        `🖥 Browser ${names.length > 0 ? `(${names.length})` : ""}`,
      ),
      open && names.length > 0
        ? createElement(
            "select",
            {
              value: picked ?? "",
              onChange: (e: Event) => setPicked((e.target as HTMLSelectElement).value),
              style: { flex: 1, fontSize: 12 },
            },
            names.map((n) => createElement("option", { key: n, value: n }, n)),
          )
        : null,
      createElement("span", { style: { flex: 1 } }),
      open ? createElement("button", { onClick: () => setPinned((v) => !v), title: "Pin width", style: { cursor: "pointer", fontSize: 12 } }, pinned ? "📌" : "📍") : null,
      open ? createElement("button", { onClick: popOut, title: "Pop out to a tab", style: { cursor: "pointer", fontSize: 12 } }, "⧉") : null,
    ),
    open
      ? createElement(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 6 } },
          createElement("button", {
            onClick: toggleTakeover as unknown as React.MouseEventHandler,
            title: "Toggle human-takeover input forwarding",
            style: { cursor: "pointer", fontSize: 12 },
          }, (activeRow?.takeover ?? false) ? "🖱 takeover ON" : "🖱 takeover"),
        )
      : null,
    open ? createElement(Viewer, { session: picked, takeover: activeRow?.takeover === true }) : null,
  );
}

/** Client plugin body: contribute the overlay entry. */
export const inject: string[] = ["slots"];

export function apply(ctx: {
  slots: {
    inject: (key: string, callback: () => () => void) => () => void;
    register: (spec: Record<string, unknown>, component: unknown) => () => void;
  };
}): void {
  ctx.slots.inject("shell.overlay", () =>
    ctx.slots.register({ name: "shell.overlay", id: "browser-panel", order: 40 }, BrowserPanel),
  );
}
