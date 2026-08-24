/**
 * dsh-agent-browser client half: the live viewport surface contributed to the
 * web shell's 'shell.overlay' slot (additive list — floats over the app,
 * click-through until opted in). Plain createElement React: no JSX transform
 * in the build pipeline, so the shipped bundle is a tiny CJS factory wrap.
 *
 * Three display modes (persisted per browser in localStorage):
 *   chip    — collapsed launcher button, bottom-right (panel closed).
 *   float   — the original small floating card.
 *   sidebar — Codex-style right sidebar: docked full-height on the right,
 *             drag-resizable, with a SESSION tab strip (one tab per live
 *             session) and, beneath it, a BROWSER tab strip (the active
 *             session's own tabs, switchable by the human through
 *             /browser/tabs).
 *
 * The panel talks ONLY to its own origin: GET /browser/sessions for the
 * inventory, WS /browser/stream?session=… for frames, GET/POST /browser/tabs
 * for the tab strip. No raw daemon ports.
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

/** One browser tab inside the active session (normalized across shapes). */
interface BrowserTab {
  id: string;
  title: string;
  url: string;
  active: boolean;
}

type PanelMode = "chip" | "float" | "sidebar";

const MODE_KEY = "dsh-agent-browser.mode";
const WIDTH_KEY = "dsh-agent-browser.sidebar-width";

function loadMode(): PanelMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === "float" || v === "sidebar" || v === "chip" ? v : "chip";
  } catch {
    return "chip";
  }
}

function saveMode(mode: PanelMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* storage unavailable: session-only persistence */
  }
}

function loadWidth(): number {
  try {
    const v = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(v)) return Math.min(Math.max(v, 320), 760);
  } catch {
    /* fall through */
  }
  return 480;
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

/** Normalize whatever the daemon puts in a tabs payload into BrowserTab[]. */
function normalizeTabs(raw: unknown): BrowserTab[] {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw !== null && typeof raw === "object" && Array.isArray((raw as { tabs?: unknown }).tabs)
      ? (raw as { tabs: unknown[] }).tabs
      : [];
  return list.slice(0, 16).map((entry, i) => {
    const t = (entry ?? {}) as Record<string, unknown>;
    return {
      id: String(t.tabId ?? t.id ?? t.targetId ?? "t" + (i + 1)),
      title: typeof t.title === "string" ? t.title : "",
      url: typeof t.url === "string" ? t.url : "",
      active: t.active === true,
    };
  });
}

/** GET the active session's browser tabs through our own origin. */
async function fetchTabs(session: string | null): Promise<BrowserTab[]> {
  try {
    const q = session ? "?session=" + encodeURIComponent(session) : "";
    const res = await fetch("/browser/tabs" + q, { headers: { accept: "application/json" } });
    if (!res.ok) return [];
    const body = (await res.json()) as { ok?: boolean; tabs?: unknown };
    return body.ok === true ? normalizeTabs(body.tabs) : [];
  } catch {
    return [];
  }
}

/** POST one tab operation; resolves with the fresh tab list. */
async function postTab(
  session: string | null,
  action: "switch" | "new" | "close",
  payload: { tab?: string; url?: string } = {},
): Promise<BrowserTab[]> {
  try {
    const res = await fetch("/browser/tabs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session, action, ...payload }),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { ok?: boolean; tabs?: unknown };
    return body.ok === true ? normalizeTabs(body.tabs) : [];
  } catch {
    return [];
  }
}

const btnStyle = {
  cursor: "pointer",
  fontSize: 12,
  lineHeight: 1,
  padding: "3px 6px",
  borderRadius: 6,
  border: "1px solid transparent",
  background: "transparent",
  color: "inherit",
};

/** One live canvas fed by the session's JPEG stream; optional input takeover. */
function Viewer(props: {
  session: string | null;
  fps?: number;
  takeover?: boolean;
  /** Fill the parent box (sidebar) instead of sizing to the frame ratio. */
  fill?: boolean;
  /** Live tab-list updates pushed by the daemon over the stream. */
  onTabs?: (tabs: BrowserTab[]) => void;
}) {
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
      ws = new WebSocket(proto + "//" + location.host + "/browser/stream?" + params.toString());
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
            tabs?: unknown;
          };
          if (msg.type === "console") {
            const line = typeof msg.text === "string" ? msg.text : JSON.stringify(msg);
            setFeed((prev) => [...prev.slice(-4), line.slice(0, 160)]);
            return;
          }
          if (msg.type === "url" && typeof msg.url === "string") {
            setFeed((prev) => [...prev.slice(-4), "→ " + msg.url]);
            return;
          }
          if (msg.type === "tabs") {
            props.onTabs?.(normalizeTabs(msg.tabs));
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
    status === "live" && ageMs === null
      ? ""
      : ageMs !== null && ageMs > 3000
        ? " (" + Math.round(ageMs / 1000) + "s stale)"
        : "";
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
  const sendKey = useCallback(
    (eventType: "keyDown" | "keyUp") => (ev: KeyboardEvent) => {
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
    },
    [props.takeover],
  );

  const canvasStyle: React.CSSProperties = props.fill
    ? {
        width: "100%",
        height: "100%",
        objectFit: "contain",
        background: "#111",
        borderRadius: 8,
        cursor: props.takeover ? "crosshair" : "default",
        outline: "none",
      }
    : {
        width: "100%",
        height: "auto",
        background: "#111",
        borderRadius: 8,
        cursor: props.takeover ? "crosshair" : "default",
        outline: "none",
      };

  return createElement(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minWidth: 0,
        flex: 1,
        ...(props.fill ? { minHeight: 0 } : {}),
      },
    },
    createElement("canvas", {
      ref: canvasRef,
      width: 640,
      height: 360,
      tabIndex: 0,
      style: canvasStyle,
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
      status +
        freshness +
        " · session: " +
        (props.session ?? "default") +
        (props.takeover ? " · takeover ON" : ""),
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

/** Session tab strip: one tab per live registry session (Codex-style). */
function SessionTabs(props: { names: string[]; picked: string | null; onPick: (name: string) => void }) {
  return createElement(
    "div",
    { style: { display: "flex", gap: 2, overflowX: "auto", flex: 1, minWidth: 0, scrollbarWidth: "thin" } },
    props.names.map((n) =>
      createElement(
        "button",
        {
          key: n,
          "data-session-tab": n,
          "data-active": n === props.picked ? "1" : "0",
          onClick: () => props.onPick(n),
          title: "Show session " + n,
          style: {
            ...btnStyle,
            whiteSpace: "nowrap",
            maxWidth: 140,
            overflow: "hidden",
            textOverflow: "ellipsis",
            borderColor: n === props.picked ? "var(--dsw-alias-border-l2, #444)" : "transparent",
            background: n === props.picked ? "var(--dsw-alias-bg-raised, #26262b)" : "transparent",
          },
        },
        n,
      ),
    ),
  );
}

/** Browser tab strip: the ACTIVE session's own tabs; human can switch/close/open. */
function BrowserTabStrip(props: {
  tabs: BrowserTab[];
  onSwitch: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}) {
  if (props.tabs.length === 0) return null;
  return createElement(
    "div",
    {
      "data-browser-tabs": "",
      style: {
        display: "flex",
        alignItems: "center",
        gap: 2,
        overflowX: "auto",
        paddingBottom: 2,
        borderBottom: "1px solid var(--dsw-alias-border-l1, #2a2a2e)",
        scrollbarWidth: "thin",
        pointerEvents: "auto",
      },
    },
    ...props.tabs.map((t) =>
      createElement(
        "span",
        {
          key: t.id,
          "data-browser-tab": t.id,
          "data-active": t.active ? "1" : "0",
          title: t.title ? t.title + "\n" + t.url : t.url,
          style: {
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontSize: 11,
            whiteSpace: "nowrap",
            maxWidth: 150,
            padding: "2px 4px 2px 8px",
            borderRadius: 6,
            cursor: "pointer",
            background: t.active ? "var(--dsw-alias-bg-raised, #26262b)" : "transparent",
            border: "1px solid " + (t.active ? "var(--dsw-alias-border-l2, #444)" : "transparent"),
          },
          onClick: () => {
            if (!t.active) props.onSwitch(t.id);
          },
        },
        createElement("span", { style: { overflow: "hidden", textOverflow: "ellipsis" } }, t.title || t.url || t.id),
        createElement("button", {
          title: "Close tab " + t.id,
          onClick: (ev: MouseEvent) => {
            ev.stopPropagation();
            props.onClose(t.id);
          },
          style: { ...btnStyle, fontSize: 10, opacity: 0.6, padding: "0 3px" },
        }, "×"),
      ),
    ),
    createElement("button", {
      title: "New tab (about:blank)",
      onClick: props.onNew,
      style: { ...btnStyle, fontSize: 13, padding: "0 6px" },
    }, "+"),
  );
}

/** The panel: launcher chip, floating card, or docked right sidebar. */
export function BrowserPanel() {
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [mode, setMode] = useState<PanelMode>(() => loadMode());
  const [picked, setPicked] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => loadWidth());
  const [bTabs, setBTabs] = useState<BrowserTab[]>([]);
  const open = mode !== "chip";
  const autoOpenedRef = useRef(false);

  const applyMode = useCallback((next: PanelMode) => {
    setMode(next);
    saveMode(next);
  }, []);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const inv = await fetchInventory();
      if (!alive || inv === null) return;
      setInventory(inv);
      // Auto-open ONCE per page load when a session goes live; an explicit
      // close afterwards sticks (unlike re-forcing open on every poll).
      if (
        !autoOpenedRef.current &&
        inv.autoOpenPanel &&
        inv.sessions.length > 0 &&
        loadMode() === "chip"
      ) {
        autoOpenedRef.current = true;
        applyMode("float");
      }
      setPicked((prev) => prev ?? inv.sessions[0]?.name ?? null);
    };
    void poll();
    const timer = window.setInterval(poll, 2500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [applyMode]);

  // Refresh the active session's browser tabs when the session changes.
  useEffect(() => {
    setBTabs([]);
    if (!open) return;
    void fetchTabs(picked).then(setBTabs);
  }, [picked, open]);

  const popOut = useCallback(() => {
    const q = picked ? "?session=" + encodeURIComponent(picked) : "";
    window.open("/browser/viewer" + q, "_blank", "width=900,height=700");
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
  }, [picked, activeRow]);

  // Sidebar drag-resize: left-edge handle, clamped, persisted.
  const startResize = useCallback(
    (down: React.MouseEvent) => {
      down.preventDefault();
      const startX = down.clientX;
      const startW = sidebarWidth;
      const clamp = (rawX: number) =>
        Math.min(Math.max(startW + (startX - rawX), 320), Math.min(760, window.innerWidth - 80));
      const move = (ev: MouseEvent) => setSidebarWidth(clamp(ev.clientX));
      const up = (ev: MouseEvent) => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        const w = clamp(ev.clientX);
        setSidebarWidth(w);
        try {
          localStorage.setItem(WIDTH_KEY, String(w));
        } catch {
          /* ignore */
        }
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [sidebarWidth],
  );

  // Reserve real layout space for the sidebar: pad the AppFrame's right edge so
  // the grid (sidebar | center | details) reflows instead of being covered.
  //
  // Finding the frame: the slot renderer wraps every entry in a
  // display:contents anchor (<div data-slot>), so a naive parentElement chain
  // lands on the overlay LAYER — an out-of-flow element whose padding cannot
  // reflow anything. Climb to the layer's stable data attribute instead, then
  // step out one level to the frame grid. If the attribute ever moves, fall
  // back to a document query; worst case degrades to plain overlay behavior.
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let layer: HTMLElement | null = rootRef.current?.parentElement ?? null;
    while (layer && !layer.hasAttribute("data-shell-overlay")) layer = layer.parentElement;
    const frame =
      layer?.parentElement ??
      document.querySelector<HTMLElement>("[data-shell-overlay]")?.parentElement ??
      null;
    if (!frame || frame.hasAttribute("data-shell-overlay")) return;
    if (mode === "sidebar") frame.style.paddingRight = `${effWidth}px`;
    else frame.style.paddingRight = "";
    return () => {
      frame.style.paddingRight = "";
    };
  }, [mode, sidebarWidth]);

  // Effective width: never wider than the viewport allows (a width saved from
  // a larger window must not overflow after a window resize).
  const effWidth = Math.min(Math.max(sidebarWidth, 280), Math.max(280, window.innerWidth - 60));

  const containerBase = {
    pointerEvents: open ? ("auto" as const) : ("none" as const),
    background: "var(--dsw-alias-bg-base, #1b1b1f)",
    color: "var(--dsw-alias-text-primary, #ddd)",
    display: "flex",
    flexDirection: "column" as const,
    gap: 8,
  };

  const containerStyle: React.CSSProperties =
    mode === "sidebar"
      ? {
          ...containerBase,
          // Absolute within the shell's overlay layer (which spans the frame):
          // sits exactly over the gutter reserved via the frame's padding.
          position: "absolute",
          top: 0,
          bottom: 0,
          right: 0,
          width: effWidth,
          zIndex: 40,
          padding: 10,
          borderLeft: "1px solid var(--dsw-alias-border-l2, #333)",
          boxShadow: "-8px 0 24px rgba(0,0,0,.25)",
        }
      : {
          ...containerBase,
          position: "absolute",
          right: 12,
          bottom: 12,
          zIndex: 30,
          maxWidth: 420,
          maxHeight: "70vh",
          border: "1px solid var(--dsw-alias-border-l2, #333)",
          borderRadius: 12,
          padding: 10,
          boxShadow: "0 8px 24px rgba(0,0,0,.25)",
        };

  const header = createElement(
    "div",
    {
      // Explicitly opt back into hit-testing: the root is pointer-events:none
      // while collapsed (so the chip doesn't block the app), and none would
      // otherwise inherit into every control — the pill included.
      style: { display: "flex", alignItems: "center", gap: 6, minHeight: 24, pointerEvents: "auto" },
    },
    mode === "sidebar"
      ? createElement("strong", { style: { fontSize: 12, whiteSpace: "nowrap" } }, "🖥 Browser")
      : createElement(
          "button",
          {
            onClick: () => applyMode(open ? "chip" : "float"),
            style: { cursor: "pointer", fontSize: 12, whiteSpace: "nowrap" },
            title: open ? "Collapse the browser panel" : "Toggle the live browser panel",
          },
          "🖥 Browser" + (names.length > 0 ? " (" + names.length + ")" : ""),
        ),
    open && names.length > 0
      ? createElement(SessionTabs, {
          names,
          picked: picked ?? "",
          onPick: (n: string) => setPicked(n === "(default)" ? null : n),
        })
      : createElement("span", { style: { flex: 1 } }),
    open
      ? createElement(
          "span",
          { style: { display: "inline-flex", gap: 2 } },
          createElement("button", {
            onClick: toggleTakeover as unknown as React.MouseEventHandler,
            title: "Toggle human-takeover input forwarding",
            style: { ...btnStyle, whiteSpace: "nowrap" },
          }, (activeRow?.takeover ?? false) ? "🖱 ON" : "🖱"),
          mode === "float"
            ? createElement("button", { onClick: () => applyMode("sidebar"), title: "Dock as right sidebar", style: btnStyle }, "▤")
            : createElement("button", { onClick: () => applyMode("float"), title: "Undock to floating panel", style: btnStyle }, "❐"),
          createElement("button", { onClick: popOut, title: "Pop out to a separate window", style: btnStyle }, "⧉"),
          createElement("button", { onClick: () => applyMode("chip"), title: "Close the browser panel", style: btnStyle }, "✕"),
        )
      : null,
  );

  return createElement(
    "div",
    {
      ref: rootRef,
      "data-browser-panel": open ? "open" : "closed",
      "data-browser-mode": mode,
      style: containerStyle,
    },
    mode === "sidebar"
      ? createElement("div", {
          onMouseDown: startResize as unknown as React.MouseEventHandler,
          title: "Drag to resize the sidebar",
          style: { position: "absolute", left: 0, top: 0, bottom: 0, width: 6, cursor: "col-resize", pointerEvents: "auto" },
        })
      : null,
    header,
    open
      ? createElement(BrowserTabStrip, {
          tabs: bTabs,
          onSwitch: (id: string) => void postTab(picked, "switch", { tab: id }).then(setBTabs),
          onClose: (id: string) => void postTab(picked, "close", { tab: id }).then(setBTabs),
          onNew: () => void postTab(picked, "new").then(setBTabs),
        })
      : null,
    open
      ? names.length === 0
        ? createElement(
            "div",
            { style: { fontSize: 11, opacity: 0.65, padding: "8px 2px" } },
            "No live browser sessions yet. Ask the agent to open a page.",
          )
        : createElement(Viewer, {
            session: picked,
            takeover: activeRow?.takeover === true,
            fill: mode === "sidebar",
            onTabs: setBTabs,
          })
      : null,
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
