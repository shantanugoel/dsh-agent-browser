/**
 * Build the client half into the lazy-CJS factory form the DSH web shell's
 * module loader consumes:
 *
 *   window.__ModuleLoader__.load({ id, factory: (require) => { …; return module.exports } })
 *
 * react stays external (shell-seeded); everything else is bundled.
 *
 * Usage: node scripts/build-client.mjs
 */
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const outfileDir = path.join(pkgRoot, "client", "dist");
mkdirSync(outfileDir, { recursive: true });

const raw = path.join(outfileDir, "raw.cjs");
await build({
  entryPoints: [path.join(pkgRoot, "client", "index.ts")],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  outfile: raw,
  external: ["react", "react/jsx-runtime", "react-dom"],
  legalComments: "none",
  logLevel: "info",
});

const body = readFileSync(raw, "utf8");
const wrapped = `window.__ModuleLoader__.load({
	id: "dsh-agent-browser",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body}
		return module.exports;
	}
});
`;
writeFileSync(path.join(outfileDir, "client.js"), wrapped);
console.log("client.js written:", wrapped.length, "bytes");
