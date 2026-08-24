
process.env["HOME"] = process.env["MOCK_HOME"];
const { SessionRegistry } = await import("dsh-agent-browser-core");
const registry = new SessionRegistry({
  binaryPath: process.env["AB_BIN"],
  launchArgs: ["--no-sandbox", "--disable-crashpad"],
});
const s = registry.session(process.env["SESSION"]);
await s.open("https://example.com");
// One batch: click a link-ish element then read the compact snapshot behavior.
const snap0 = await s.snapshot({ interactiveOnly: true, maxChars: 600 });
const ref = Object.keys(snap0.refs)[0];
const res = await s.act([
  { kind: "click", target: { ref } },
], { bail: false });
console.log(JSON.stringify(res).slice(0, 300));
console.log(JSON.stringify(res).slice(0, 400));
