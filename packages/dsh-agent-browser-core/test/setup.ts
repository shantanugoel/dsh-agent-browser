import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Every fork gets its own fake agent-browser home so fixture writes never
// touch the developer's real ~/.agent-browser.
process.env["MOCK_HOME"] ??= mkdtempSync(path.join(os.tmpdir(), "abc-worker-"));
