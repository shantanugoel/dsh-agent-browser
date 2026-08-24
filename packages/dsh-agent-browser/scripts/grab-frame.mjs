// Pull ONE real frame through the stream API and save it as a JPEG file.
process.env["HOME"] = process.env["MOCK_HOME"];
const core = await import("dsh-agent-browser-core");
const { writeFileSync } = await import("node:fs");

const registry = new core.SessionRegistry({
  binaryPath: process.env["AB_BIN"],
  launchArgs: ["--no-sandbox", "--disable-crashpad"],
});
const session = process.env["SESSION"] || "s2";
registry.session(session);
const client = registry.client;

const page = "data:text/html,<body style='background:%23184e77'><h1 style='color:white;font-family:monospace'>LIVE FRAME OK</h1></body>";
await client.call(["open", page], { session });

const port = await core.resolveStreamPort(client, session);
if (!port) throw new Error("no stream port");
console.log("stream port:", port);
const stream = new core.SessionStream(port, { maxFps: 24 });
stream.on("frame", (f) => {
  writeFileSync(process.env["OUT"] || "/tmp/frame.jpg", f.jpeg);
  console.log("frame", f.seq, "bytes:", f.jpeg.length);
  stream.close();
  process.exit(0);
});
await stream.connect();
setTimeout(() => { console.error("no frame in 15s"); process.exit(1); }, 15000);
