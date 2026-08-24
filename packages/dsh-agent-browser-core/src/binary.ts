/**
 * Module-relative resolution of the `agent-browser` binary. The driver never
 * consults $PATH: the package is declared as a pinned dependency of this
 * module, and every host installer (pnpm profile, pi extensions dir) creates
 * node_modules links we resolve through createRequire.
 *
 * @module dsh-agent-browser-core/binary
 */

import { createRequire } from "node:module";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { BinaryUnavailableError } from "./errors.ts";

export interface ResolvedBinary {
  /** Executable to spawn (absolute path). */
  command: string;
  /** Version string reported by `--version` when cheaply known; absent otherwise. */
  version?: string;
  /** How the binary was found (diagnostics only). */
  via: "package-bin" | "explicit";
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the agent-browser CLI from this module's dependency graph.
 * Prefers the manifest's bin entry (works under pnpm's symlinked stores),
 * falling back to the platform-native binary shipped inside the package.
 *
 * @param explicit - caller-provided absolute path; used verbatim when given.
 * @param require - injectable require for tests; defaults to this module's.
 * @returns the resolved executable description.
 * @throws {BinaryUnavailableError} when nothing executable can be located.
 */
export function resolveAgentBrowserBinary(
  explicit?: string,
  require: NodeRequire = createRequire(import.meta.url),
): ResolvedBinary {
  if (explicit) {
    // Script launchers (.js/.mjs/.cjs) run via node and need no +x bit.
    if (!isExecutable(explicit) && !/\.[cm]?js$/.test(explicit)) {
      throw new BinaryUnavailableError(`agent-browser binary not executable at ${explicit}`);
    }
    return { command: explicit, via: "explicit" };
  }

  let pkgDir: string | undefined;
  try {
    const pkgJsonPath = require.resolve("agent-browser/package.json");
    pkgDir = path.dirname(pkgJsonPath);
    const manifest = require("agent-browser/package.json") as {
      bin?: Record<string, string>;
      version?: string;
    };
    const binRel = manifest.bin?.["agent-browser"];
    if (binRel) {
      const launcher = path.join(pkgDir, binRel);
      // The launcher is a .js file executed by node — executability of the
      // file itself does not matter, node runs it.
      return { command: launcher, version: manifest.version, via: "package-bin" };
    }
  } catch {
    // fall through to native-binary probing
  }

  // Direct probe of the platform binary layout (bin/agent-browser-<platform>-<arch>).
  if (pkgDir) {
    const plat = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : process.platform === "linux" ? "linux" : undefined;
    const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined;
    if (plat && arch) {
      const ext = plat === "win32" ? ".exe" : "";
      const native = path.join(pkgDir, "bin", `agent-browser-${plat}-${arch}${ext}`);
      if (isExecutable(native)) return { command: native, via: "package-bin" };
    }
  }

  throw new BinaryUnavailableError(
    'could not resolve the "agent-browser" package from dsh-agent-browser-core; install it alongside this module or pass binaryPath explicitly',
  );
}