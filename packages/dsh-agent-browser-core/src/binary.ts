/**
 * Module-relative resolution of the `agent-browser` binary. The driver never
 * consults $PATH: the package is declared as a pinned dependency of this
 * module, and every host installer (pnpm profile, pi extensions dir) creates
 * node_modules links we resolve through createRequire.
 *
 * Resolution prefers the host-platform native executable materialized in the
 * package's `bin/` directory and falls back to the package's JS launcher.
 * Since agent-browser 0.43 the native binary ships in a per-platform
 * `@agent-browser/cli-*` optional dependency, and the launcher links it into
 * `bin/` on install (or on its first run when install scripts are blocked).
 * Preferring the native file skips a Node process (~0.12s) on every CLI call.
 *
 * @module dsh-agent-browser-core/binary
 */

import { createRequire } from "node:module";
import { accessSync, constants, existsSync } from "node:fs";
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

/** Whether this Node process is running against the musl libc (Linux only). */
function linuxUsesMusl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const report = process.report?.getReport() as
      | { header?: { glibcVersionRuntime?: string }; sharedObjects?: string[] }
      | undefined;
    if (report?.header?.glibcVersionRuntime) return false;
    if (report?.sharedObjects?.some((lib) => /(?:^|\/)ld-musl-|libc\.musl-/.test(lib))) return true;
  } catch {
    /* fall through to the loader probe */
  }
  // A statically linked Node has no loaded libc in its process report.
  const loaderArch = process.arch === "arm64" ? "aarch64" : "x86_64";
  return existsSync(`/lib/ld-musl-${loaderArch}.so.1`);
}

/**
 * Host-platform native binary names to probe inside the agent-browser
 * package's `bin/` directory, in preference order.
 *
 * Mirrors what agent-browser's postinstall/launcher materialize: 0.42 bundled
 * every platform binary in the tarball, 0.43 hardlinks/copies only the host
 * one from the matching `@agent-browser/cli-*` optional dependency.
 */
export function nativeBinaryNames(): string[] {
  const plat =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "win32"
        ? "win32"
        : process.platform === "linux"
          ? "linux"
          : undefined;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined;
  if (!plat || !arch) return [];
  const ext = plat === "win32" ? ".exe" : "";
  if (plat === "linux") {
    // 0.42 shipped both libc flavours, so probe the one this host can run;
    // 0.43 only materializes the matching one anyway.
    return [`agent-browser-linux-${linuxUsesMusl() ? "musl-" : ""}${arch}${ext}`];
  }
  if (plat === "win32" && arch === "arm64") {
    // A source-built ARM64 binary is preferred; the published x64 one runs
    // through Windows' built-in emulation when that is all there is.
    return ["agent-browser-win32-arm64.exe", "agent-browser-win32-x64.exe"];
  }
  return [`agent-browser-${plat}-${arch}${ext}`];
}

/**
 * Resolve the agent-browser CLI from this module's dependency graph.
 *
 * Prefers the host-platform native executable materialized in the package's
 * `bin/` (fast path: no Node launcher process per call), falling back to the
 * manifest's `bin` entry — a JS launcher that resolves the per-platform
 * optional package in agent-browser 0.43+.
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
  let version: string | undefined;
  let launcher: string | undefined;
  try {
    const pkgJsonPath = require.resolve("agent-browser/package.json");
    pkgDir = path.dirname(pkgJsonPath);
    const manifest = require("agent-browser/package.json") as {
      bin?: Record<string, string>;
      version?: string;
    };
    version = manifest.version;
    const binRel = manifest.bin?.["agent-browser"];
    if (binRel) launcher = path.join(pkgDir, binRel);
  } catch {
    // Not resolvable: fall through with whatever was learned (nothing).
  }

  // Native first: it skips the JS launcher's Node process on every spawn. The
  // launcher stays the fallback when no native file has been materialized yet
  // (blocked install scripts, read-only store, or an older layout).
  if (pkgDir) {
    for (const name of nativeBinaryNames()) {
      const native = path.join(pkgDir, "bin", name);
      if (isExecutable(native)) {
        return { command: native, version, via: "package-bin" };
      }
    }
  }
  if (launcher) {
    // The launcher is a .js file executed by node — executability of the file
    // itself does not matter.
    return { command: launcher, version, via: "package-bin" };
  }

  throw new BinaryUnavailableError(
    'could not resolve the "agent-browser" package from dsh-agent-browser-core; install it alongside this module or pass binaryPath explicitly',
  );
}
