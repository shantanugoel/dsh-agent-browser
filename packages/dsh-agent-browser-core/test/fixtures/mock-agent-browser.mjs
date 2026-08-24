#!/usr/bin/env node
/**
 * Mock agent-browser CLI used by the driver's test-suite. Speaks the same
 * stdout JSON contract as agent-browser 0.34.0 for the subset of commands
 * the core driver issues, plus fault-injection switches via MOCK_* env vars.
 *
 * Usage (the driver spawns): node mock-agent-browser.mjs --json --session S <cmd…>
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const sessionIdx = args.indexOf("--session");
const session = sessionIdx >= 0 ? args[sessionIdx + 1] : undefined;
// Flags that take a value; everything else starting with -- is valueless.
const FLAGS_WITH_VALUE = new Set(["--session", "--args", "--idle-timeout", "--profile", "--state"]);
const positional = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--json") continue;
  if (FLAGS_WITH_VALUE.has(arg)) { i++; continue; }
  if (arg.startsWith("--")) continue;
  positional.push(arg);
}

const home = process.env["MOCK_HOME"] ?? process.env["HOME"] ?? "/tmp";
const stateDir = path.join(home, ".agent-browser");
mkdirSync(stateDir, { recursive: true });
const logFile = path.join(stateDir, `${session ?? "default"}.mocklog`);
appendFileSync(logFile, JSON.stringify({ argv: positional, ts: Date.now() }) + "\n");

// Fault injection knobs.
if (process.env["MOCK_PRINT_GARBAGE"] === "1") {
  process.stdout.write("<html>not json</html>");
  process.exit(0);
}
if (process.env["MOCK_DELAY_MS"]) {
  const ms = Number(process.env["MOCK_DELAY_MS"]);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
// Always publish a stream sidecar so port-discovery paths are exercised.
writeFileSync(path.join(stateDir, `${session ?? "default"}.stream`), String(54321));

function emit(data) {
  process.stdout.write(JSON.stringify({ success: true, data, error: null }));
}
const LIFECYCLE = { lifecycle: { launched: true, reused: false, browserLaunched: true } };

let stdin = "";
if (!process.stdin.isTTY) {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    stdin = Buffer.concat(chunks).toString("utf8");
  } catch { /* no stdin */ }
}

const [cmd, ...rest] = positional;
switch (cmd) {
  case undefined:
  case "open": {
    const url = rest[0];
    emit({
      ...LIFECYCLE,
      ...(url ? { title: `Mock page: ${url}`, url, targetId: "TARGET-1" } : {}),
    });
    break;
  }
  case "get": {
    const what = rest[0];
    if (what === "url") emit({ ...LIFECYCLE, url: "https://example.com/" });
    else if (what === "title") emit({ ...LIFECYCLE, title: "Example Domain" });
    else if (what === "text") emit({ text: "Learn more" });
    else emit({});
    break;
  }
  case "snapshot": {
    emit({
      origin: "https://example.com/",
      refs: {
        e1: { name: "Example Domain", role: "heading" },
        e2: { name: "Learn more", role: "link" },
        e3: { name: "Get Started", role: "button" },
      },
      snapshot: '- heading "Example Domain" [level=1, ref=e1]\n- link "Learn more" [ref=e2]\n- button "Get Started" [ref=e3]',
      ...LIFECYCLE,
    });
    break;
  }
  case "batch": {
    let steps;
    try {
      steps = JSON.parse(stdin);
    } catch {
      process.stdout.write(JSON.stringify({ success: false, data: null, error: "Invalid JSON input" }));
      break;
    }
    const out = steps.map((step) => {
      if (step[0] === "boom") return { command: step, success: false, error: "Element not found: @e99", result: null };
      if (step[0] === "click") return { command: step, success: true, error: null, result: { ok: true, ...LIFECYCLE } };
      return { command: step, success: true, error: null, result: { done: true, ...LIFECYCLE } };
    });
    process.stdout.write(JSON.stringify(out));
    break;
  }
  case "eval": {
    emit({ result: stdin.length > 0 ? `len:${stdin.trim().length}` : 42, origin: "https://example.com/" });
    break;
  }
  case "screenshot": {
    const target = rest[rest.length - 1];
    writeFileSync(target, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
    emit({ path: target });
    break;
  }
  case "tab": {
    if (rest[0] === "list") emit({ tabs: [{ active: true, label: null, tabId: "t1", targetId: "TARGET-1", title: "example.com", type: "page", url: "https://example.com/" }] });
    else emit({ switched: true });
    break;
  }
  case "stream": {
    emit({ enabled: true, connected: true, port: 54321, screencasting: false });
    break;
  }
  case "console": {
    emit({ messages: [{ type: "log", text: "hello from mock", time: 1 }] });
    break;
  }
  case "cookies": {
    emit([{ name: "session", value: "redacted-by-driver", domain: "example.com" }]);
    break;
  }
  case "wait": {
    emit({ waited: true });
    break;
  }
  case "close": {
    emit({ closed: true });
    break;
  }
  case "session": {
    if (rest[0] === "list") emit({ sessions: [{ name: session ?? "default", pid: process.pid }] });
    else emit({});
    break;
  }
  case "fail": {
    process.stdout.write(JSON.stringify({ success: false, data: null, error: rest.join(" ") || "generic failure" }));
    break;
  }
  default: {
    // Unknown command mirrors the CLI's teaching message shape.
    process.stdout.write(JSON.stringify({ success: false, data: null, error: `Unknown command: ${cmd}` }));
  }
}