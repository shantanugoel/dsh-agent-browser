process.env["HOME"] = process.env["MOCK_HOME"];
const core = await import("dsh-agent-browser-core");
const registry = new core.SessionRegistry({
  binaryPath: process.env["AB_BIN"],
  launchArgs: ["--no-sandbox", "--disable-crashpad"],
});
const s = registry.session(process.env["SESSION"] || "s2");
const hit = await s.find("Learn more");
console.log("learn-more:", JSON.stringify(hit.matches));
const rx = await s.find(/^learn/i);
console.log("regex-anchor:", rx.matches.length);
const miss = await s.find("More information");
console.log("stale-copy-matches:", miss.matches.length);
process.exit(0);