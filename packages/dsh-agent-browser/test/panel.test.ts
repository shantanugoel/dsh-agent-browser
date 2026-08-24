import { describe, expect, it } from "vitest";
import { IncomingMessage, ServerResponse } from "node:http";
import { mountPanel, type PanelConfig } from "../src/panel.ts";
import { SessionRegistry } from "dsh-agent-browser-core";

/** Minimal request/response doubles for route-level tests (no sockets). */
function fakeReq(url: string, headers: Record<string, string> = {}): IncomingMessage {
  return { url, headers } as unknown as IncomingMessage;
}

function captureRes(): { res: ServerResponse; status: () => number; body: () => string; type: () => string } {
  let statusCode = 0;
  let contentType = "";
  const chunks: string[] = [];
  const resObj: unknown = {
    writeHead(code: number, headers?: Record<string, string>) {
      statusCode = code;
      if (headers?.["content-type"]) contentType = headers["content-type"];
      return resObj;
    },
    end(payload?: string) {
      if (payload) chunks.push(payload);
    },
  };
  const res = resObj as ServerResponse;
  return {
    res,
    status: () => statusCode,
    body: () => chunks.join(""),
    type: () => contentType,
  };
}

interface RegisteredRoute {
  kind?: string;
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

function fakeWebServer() {
  const routes: RegisteredRoute[] = [];
  const upgrades: RegisteredRoute[] = [];
  return {
    routes,
    upgrades,
    register(route: RegisteredRoute) {
      routes.push(route);
      return () => undefined;
    },
    registerUpgrade(route: RegisteredRoute) {
      upgrades.push(route);
      return () => undefined;
    },
  };
}

const CONFIG: PanelConfig = { autoOpenPanel: true, takeoverEnabled: false, maxFps: 12 };

describe("panel server half", () => {
  it("registers the inventory, viewer, and upgrade routes", () => {
    const ws = fakeWebServer();
    const registry = new SessionRegistry();
    const dispose = mountPanel({}, ws as never, registry, CONFIG);
    expect(ws.routes.map((r) => r.path).sort()).toEqual([
      "/browser/sessions",
      "/browser/takeover",
      "/browser/viewer",
    ]);
    expect(ws.upgrades.map((r) => r.path)).toEqual(["/browser/stream"]);
    dispose();
  });

  it("serves an empty session inventory as JSON", async () => {
    const ws = fakeWebServer();
    const registry = new SessionRegistry();
    mountPanel({}, ws as never, registry, CONFIG);
    const route = ws.routes.find((r) => r.path === "/browser/sessions")!;
    const captured = captureRes();
    await route.handler(fakeReq("/browser/sessions"), captured.res);
    expect(captured.status()).toBe(200);
    expect(captured.type()).toBe("application/json");
    expect(JSON.parse(captured.body())).toEqual({ sessions: [], autoOpenPanel: true });
  });

  it("lists tracked registry sessions with stream ports when discoverable", async () => {
    const ws = fakeWebServer();
    const registry = new SessionRegistry({
      binaryPath: new URL("../../dsh-agent-browser-core/test/fixtures/mock-agent-browser.mjs", import.meta.url).pathname,
    });
    // Create a handle so the inventory has a row; no daemon needed for shape.
    registry.session("panel-test");
    mountPanel({}, ws as never, registry, CONFIG);
    const route = ws.routes.find((r) => r.path === "/browser/sessions")!;
    const captured = captureRes();
    await route.handler(fakeReq("/browser/sessions"), captured.res);
    const payload = JSON.parse(captured.body()) as { sessions: Array<{ name: string | null }> };
    expect(payload.sessions).toHaveLength(1);
    expect(payload.sessions[0]!.name).toBe("panel-test");
    registry.forget("panel-test");
  });

  it("takeover route rejects GET and honors the config gate", async () => {
    const ws = fakeWebServer();
    mountPanel({}, ws as never, new SessionRegistry(), CONFIG);
    const route = ws.routes.find((r) => r.path === "/browser/takeover")!;
    const got = captureRes();
    await route.handler(fakeReq("/browser/takeover"), got.res);
    expect(got.status()).toBe(405);

    // Disabled config: POST enabled:true → 403.
    const ws2 = fakeWebServer();
    mountPanel({}, ws2 as never, new SessionRegistry(), { ...CONFIG, takeoverEnabled: false });
    const route2 = ws2.routes.find((r) => r.path === "/browser/takeover")!;
    const req2 = fakeReq("/browser/takeover") as IncomingMessage & { method?: string };
    req2.method = "POST";
    (req2 as unknown as { [Symbol.asyncIterator](): AsyncIterableIterator<string> })[Symbol.asyncIterator] =
      async function* () {
        yield JSON.stringify({ session: "s9", enabled: true });
      } as never;
    const res2 = captureRes();
    await route2.handler(req2, res2.res);
    expect(res2.status()).toBe(403);

    // Enabled config: POST toggles held state; second POST releases it.
    const ws3 = fakeWebServer();
    mountPanel({}, ws3 as never, new SessionRegistry(), { ...CONFIG, takeoverEnabled: true });
    const route3 = ws3.routes.find((r) => r.path === "/browser/takeover")!;
    const post = (body: string): IncomingMessage => {
      const rq = fakeReq("/browser/takeover") as IncomingMessage & { method?: string };
      rq.method = "POST";
      (rq as unknown as { [Symbol.asyncIterator](): AsyncIterableIterator<string> })[Symbol.asyncIterator] =
        async function* () {
          yield body;
        } as never;
      return rq;
    };
    const on = captureRes();
    await route3.handler(post(JSON.stringify({ session: "s9", enabled: true })), on.res);
    expect(JSON.parse(on.body())).toEqual({ ok: true, held: true });
    const off = captureRes();
    await route3.handler(post(JSON.stringify({ session: "s9", enabled: false })), off.res);
    expect(JSON.parse(off.body())).toEqual({ ok: true, held: false });
  });

  it("inventory rows carry the takeover flag", async () => {
    const ws = fakeWebServer();
    const registry = new SessionRegistry({
      binaryPath: new URL("../../dsh-agent-browser-core/test/fixtures/mock-agent-browser.mjs", import.meta.url).pathname,
    });
    registry.session("t1");
    mountPanel({}, ws as never, registry, { ...CONFIG, takeoverEnabled: true });
    const route = ws.routes.find((r) => r.path === "/browser/sessions")!;
    const captured = captureRes();
    await route.handler(fakeReq("/browser/sessions"), captured.res);
    const payload = JSON.parse(captured.body()) as { sessions: Array<{ name: string | null; takeover?: boolean }> };
    expect(payload.sessions[0]).toMatchObject({ name: "t1", takeover: false });
    registry.forget("t1");
  });

  it("serves the pop-out viewer page with same-origin-only markup", async () => {
    const ws = fakeWebServer();
    mountPanel({}, ws as never, new SessionRegistry(), CONFIG);
    const route = ws.routes.find((r) => r.path === "/browser/viewer")!;
    const captured = captureRes();
    await route.handler(fakeReq("/browser/viewer?session=s2"), captured.res);
    expect(captured.status()).toBe(200);
    expect(captured.type()).toContain("text/html");
    const html = captured.body();
    expect(html).toContain("/browser/stream");
    // No external origins in the page.
    expect(html).not.toMatch(/https?:\/\//);
  });
});