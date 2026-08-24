import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
process.env["HOME"] = mkdtempSync(tmpdir() + "/dbg-", { recursive: true });
const { apply } = await import("../lib/index.js");
const tools = new Map();
apply(
  { tools: { register: (d) => tools.set(d.name, d) }, systemPrompt: { section: () => {} }, effect: () => {} },
  { binaryPath: new URL("../../dsh-agent-browser-core/test/fixtures/mock-agent-browser.mjs", import.meta.url).pathname },
);
const get = tools.get("browser_get");
for (let i = 0; i < 3; i++) {
  const res = await get.execute({ what: "cookies" }, {});
  console.log(i, JSON.stringify(res).slice(0, 160));
}
process.exit(0);
