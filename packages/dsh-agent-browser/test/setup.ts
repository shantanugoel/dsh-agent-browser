// Per-fork scratch HOME so the mock CLI's state dir stays inside the sandbox.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["HOME"] = mkdtempSync(join(tmpdir(), "dsh-ab-adapter-"));
