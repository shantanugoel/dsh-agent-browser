// Definitive live sweep: every registered browser_* tool against real Chrome.
process.env["HOME"] = process.env["MOCK_HOME"];
import { existsSync, readFileSync } from "node:fs";
const core = await import("dsh-agent-browser-core");
const { apply } = await import("../lib/index.js");

const toolsMap = new Map();
const effects = [];
apply(
  {
    tools: { register: (d) => toolsMap.set(d.name, d) },
    systemPrompt: { section: () => undefined },
    effect: (factory, label) => effects.push([factory, label]),
  },
  { binaryPath: process.env["AB_BIN"], launchArgs: "--no-sandbox,--disable-crashpad", allowEval: true },
);

const exec = { signal: undefined };
const results = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    results.push(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (err) {
    results.push(`FAIL ${name} — ${err.message?.slice(0, 120)}`);
  }
}

await check("browser_open", async () => {
  const v = await toolsMap.get("browser_open").execute({ url: "https://example.com" }, exec);
  return `title=${v.title}`;
});

let firstRef = null;
await check("browser_snapshot", async () => {
  const v = await toolsMap.get("browser_snapshot").execute({ interactiveOnly: true }, exec);
  const m = String(v.tree).match(/\[ref=(e\d+)\]/);
  if (!m) throw new Error("no refs in tree");
  firstRef = m[1];
  return `refCount=${v.refCount} first=${firstRef}`;
});

await check("browser_find", async () => {
  const v = await toolsMap.get("browser_find").execute({ pattern: "Learn more" }, exec);
  if (!v.matches || v.matches.length === 0) throw new Error("no matches");
  return `ref=${v.matches[0].ref}`;
});

await check("browser_act", async () => {
  const v = await toolsMap.get("browser_act").execute(
    { steps: [{ action: "click", ref: "@" + firstRef }] },
    exec,
  );
  if (v.failedCount !== 0) throw new Error(v.summary);
  if (typeof v.page !== "string") throw new Error("no mini-snapshot");
  return `steps=1 pageChars=${v.page.length}`;
});

await check("browser_get", async () => {
  const t = await toolsMap.get("browser_get").execute({ what: "title" }, exec);
  const c = await toolsMap.get("browser_get").execute({ what: "cookies" }, exec);
  // Accept both observed shapes; every present value must be redacted.
  const list = Array.isArray(c.data) ? c.data : c.data?.cookies;
  if (!Array.isArray(list)) throw new Error("unrecognized payload");
  const leaked = list.filter((k) => k.value !== undefined && k.value !== "[redacted]");
  if (leaked.length > 0) throw new Error("leaked " + leaked.length + " values");
  return `title=${t.data} cookiesRedacted=true`;
});

await check("browser_eval", async () => {
  const v = await toolsMap.get("browser_eval").execute({ js: "navigator.userAgent.length > 0 ? 41+1 : 0" }, exec);
  if (v.result !== 42) throw new Error("unexpected result " + JSON.stringify(v.result));
  return "result=42";
});

await check("browser_screenshot", async () => {
  const v = await toolsMap.get("browser_screenshot").execute({ outPath: process.env["SHOT"] }, exec);
  if (!existsSync(v.path)) throw new Error("file missing");
  const bytes = readFileSync(v.path).length;
  if (bytes < 500) throw new Error("suspiciously small png");
  return `${bytes} bytes`;
});

await check("browser_tabs", async () => {
  const v = await toolsMap.get("browser_tabs").execute({ action: "list" }, exec);
  const tabs = Array.isArray(v.tabs) ? v.tabs : v;
  if (!Array.isArray(tabs) || tabs.length < 1) throw new Error("no tabs");
  return `${tabs.length} tab(s)`;
});

await check("browser_session", async () => {
  const v = await toolsMap.get("browser_session").execute({ action: "list" }, exec);
  const rows = v.sessions ?? v;
  if (!Array.isArray(rows)) throw new Error("bad shape");
  return `${rows.length} tracked`;
});

console.log(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.log(failed === 0 ? "ALL 9 TOOLS LIVE-PASS" : failed + " FAILURES");
// teardown like the host does
for (const [factory] of effects) factory();
process.exit(failed === 0 ? 0 : 1);
