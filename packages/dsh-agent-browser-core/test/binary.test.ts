import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { nativeBinaryNames, resolveAgentBrowserBinary } from "../src/binary.ts";
import { BinaryUnavailableError } from "../src/errors.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Build a fake `agent-browser` package layout and an injectable require for it. */
function makeFakePackage(): { pkgDir: string; fakeRequire: NodeRequire } {
  const pkgDir = mkdtempSync(path.join(os.tmpdir(), "ab-binary-test-"));
  tempDirs.push(pkgDir);
  mkdirSync(path.join(pkgDir, "bin"), { recursive: true });
  const pkgJsonPath = path.join(pkgDir, "package.json");
  writeFileSync(
    pkgJsonPath,
    JSON.stringify({
      name: "agent-browser",
      version: "9.9.9",
      bin: { "agent-browser": "./bin/agent-browser.js" },
    }),
  );
  writeFileSync(path.join(pkgDir, "bin", "agent-browser.js"), "#!/usr/bin/env node\n");

  const requireFn = ((id: string) => {
    if (id === "agent-browser/package.json") return JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    throw new Error(`unexpected require: ${id}`);
  }) as unknown as NodeRequire;
  (requireFn as unknown as { resolve: (id: string) => string }).resolve = (id: string) => {
    if (id === "agent-browser/package.json") return pkgJsonPath;
    throw new Error(`unexpected resolve: ${id}`);
  };
  return { pkgDir, fakeRequire: requireFn };
}

describe("resolveAgentBrowserBinary", () => {
  it("prefers the materialized platform-native binary over the JS launcher", () => {
    const names = nativeBinaryNames();
    expect(names.length).toBeGreaterThan(0);
    const { pkgDir, fakeRequire } = makeFakePackage();
    const native = path.join(pkgDir, "bin", names[0]!);
    writeFileSync(native, "");
    if (process.platform !== "win32") chmodSync(native, 0o755);

    const resolved = resolveAgentBrowserBinary(undefined, fakeRequire);
    expect(resolved).toMatchObject({ command: native, version: "9.9.9", via: "package-bin" });
  });

  it("falls back to the package launcher when no native binary was materialized", () => {
    const { pkgDir, fakeRequire } = makeFakePackage();
    const resolved = resolveAgentBrowserBinary(undefined, fakeRequire);
    expect(resolved).toMatchObject({
      command: path.join(pkgDir, "bin", "agent-browser.js"),
      version: "9.9.9",
      via: "package-bin",
    });
  });

  it("falls back to the launcher when the native file is not executable", () => {
    if (process.platform === "win32") return; // X_OK is a no-op on Windows.
    const names = nativeBinaryNames();
    expect(names.length).toBeGreaterThan(0);
    const { pkgDir, fakeRequire } = makeFakePackage();
    const native = path.join(pkgDir, "bin", names[0]!);
    writeFileSync(native, "");
    chmodSync(native, 0o644);

    const resolved = resolveAgentBrowserBinary(undefined, fakeRequire);
    expect(resolved.command).toBe(path.join(pkgDir, "bin", "agent-browser.js"));
  });

  it("throws BinaryUnavailableError when the package cannot be resolved", () => {
    const requireFn = (() => {
      throw new Error("not found");
    }) as unknown as NodeRequire;
    (requireFn as unknown as { resolve: (id: string) => string }).resolve = () => {
      throw new Error("not found");
    };
    expect(() => resolveAgentBrowserBinary(undefined, requireFn)).toThrow(BinaryUnavailableError);
  });

  it("still honours an explicit binary path", () => {
    // A .js path needs no +x bit: it is spawned through process.execPath.
    const explicit = path.join(os.tmpdir(), "agent-browser-explicit.js");
    expect(resolveAgentBrowserBinary(explicit)).toMatchObject({ command: explicit, via: "explicit" });
  });
});
