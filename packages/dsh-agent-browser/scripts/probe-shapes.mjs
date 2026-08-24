process.env["HOME"] = process.env["MOCK_HOME"];
const core = await import("dsh-agent-browser-core");
const registry = new core.SessionRegistry({
  binaryPath: process.env["AB_BIN"],
  launchArgs: ["--no-sandbox", "--disable-crashpad"],
});
const s = registry.session(process.env["SESSION"] || "s2");
const raw = await s.get("cookies");
console.log("isArray:", Array.isArray(raw));
console.log("shape:", JSON.stringify(raw).slice(0, 300));
process.exit(0);
