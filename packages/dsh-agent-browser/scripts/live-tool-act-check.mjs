// End-to-end through the ACTUAL registered tool: browser_act incl. mini-snapshot.
process.env["HOME"] = process.env["MOCK_HOME"];
const { apply } = await import("../lib/index.js");
const toolsMap = {};
apply(
  { tools: { register: (d) => (toolsMap[d.name] = d) }, systemPrompt: { section: () => {} }, effect: () => {} },
  {
    binaryPath: process.env["AB_BIN"],
    launchArgs: "--no-sandbox,--disable-crashpad",
  },
);
const act = toolsMap["browser_act"];
if (!act) throw new Error("browser_act missing");
await toolsMap["browser_open"].execute({ url: "https://example.com" }, { signal: undefined });
// Fresh refs: @eN are reassigned per snapshot.
const snapTool = toolsMap["browser_snapshot"];
const snapValue = await snapTool.execute({ interactiveOnly: true, maxChars: 400 }, { signal: undefined });
const m = String(snapValue.tree).match(/\[ref=(e\d+)\]/);
if (!m) throw new Error("no ref in tree: " + String(snapValue.tree).slice(0, 200));
const firstRef = m[1];
console.log("using ref:", firstRef);
const value = await act.execute(
  { steps: [{ action: "click", ref: "@" + firstRef }] },
  { signal: undefined },
);
console.log("summary:", value.summary);
console.log("failedCount:", value.failedCount);
console.log("page present:", typeof value.page === "string", "| page head:", String(value.page ?? "").slice(0, 80));
process.exit(0);
