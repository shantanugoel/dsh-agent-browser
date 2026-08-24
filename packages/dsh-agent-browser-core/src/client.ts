/**
 * Typed call layer over the agent-browser CLI. Every call spawns the binary
 * (which multiplexes to the session daemon over its unix socket), passes
 * arguments as argv tokens — never through a shell — and parses the JSON
 * envelope from stdout. Batch calls collapse many steps into ONE spawn via
 * stdin, which is the token-efficient path model tools should prefer.
 *
 * @module dsh-agent-browser-core/client
 */

import { spawn } from "node:child_process";
import { buildChildEnv, type EnvOverrides } from "./env.ts";
import {
  BatchStepError,
  BinaryUnavailableError,
  CallTimeoutError,
  CommandFailedError,
  ProtocolViolationError,
  classifyFailure,
} from "./errors.ts";
import type { BatchStepResult, CliEnvelope } from "./types.ts";
import { stripLifecycle } from "./types.ts";
import { resolveAgentBrowserBinary, type ResolvedBinary } from "./binary.ts";

/** Driver configuration shared by all sessions of one client. */
export interface AgentBrowserClientConfig extends EnvOverrides {
  /** Explicit path to the agent-browser launcher; default resolves the npm dependency. */
  binaryPath?: string;
  /**
   * Extra browser launch args passed on first-launching commands
   * (e.g. ["--no-sandbox"] inside hardened sandboxes).
   */
  launchArgs?: readonly string[];
  /** Default per-call cooperative timeout in milliseconds. Default 60_000. */
  defaultTimeoutMs?: number;
  /** Injectable spawn for tests. */
  spawnImpl?: typeof spawn;
}

export interface CallOptions {
  /** Cooperative timeout for this call; kills the CLI process when exceeded. */
  timeoutMs?: number;
  /** Stdin payload (batch steps, eval scripts). */
  stdin?: string;
  /**
   * Launch args are only meaningful on the command that boots the daemon;
   * callers that know the daemon is already up may skip assembling them.
   */
  includeLaunchArgs?: boolean;
  /** Abort signal observed cooperatively; aborting kills the child process. */
  signal?: AbortSignal;
}

export interface CallResult<T = Record<string, unknown>> {
  /** Payload with lifecycle bookkeeping stripped. */
  data: T;
  /** Raw envelope (lifecycle retained) for callers that need relaunch facts. */
  envelope: CliEnvelope<T & { lifecycle?: unknown }>;
}

interface SpawnOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

function parseEnvelope(raw: string, argv: string[]): CliEnvelope<never> {
  const text = raw.trim();
  if (text.length === 0) {
    throw new ProtocolViolationError(`empty stdout from agent-browser (${argv.join(" ")})`, "");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ProtocolViolationError(
      `agent-browser printed non-JSON output for ${argv.join(" ")}`,
      text.slice(-400),
      err,
    );
  }
  const env = parsed as CliEnvelope<never>;
  if (typeof env !== "object" || env === null || typeof env.success !== "boolean") {
    throw new ProtocolViolationError(
      `agent-browser output did not match the {success,data,error} envelope for ${argv.join(" ")}`,
      text.slice(-400),
    );
  }
  return env;
}

/**
 * One client owns driver-level configuration and fans out to any number of
 * named sessions. Instances are cheap; hosts typically hold one per profile.
 */
export class AgentBrowserClient {
  private resolved: ResolvedBinary | undefined;
  private readonly cfg: Required<Pick<AgentBrowserClientConfig, "defaultTimeoutMs">> &
    AgentBrowserClientConfig;

  constructor(config: AgentBrowserClientConfig = {}) {
    this.cfg = { defaultTimeoutMs: 60_000, ...config };
  }

  /** Resolve (and memoize) the backing executable. */
  binary(): ResolvedBinary {
    this.resolved ??= resolveAgentBrowserBinary(this.cfg.binaryPath);
    return this.resolved;
  }

  private spawnFn(): typeof spawn {
    return this.cfg.spawnImpl ?? spawn;
  }

  private childEnv(): NodeJS.ProcessEnv {
    return buildChildEnv(process.env, this.cfg);
  }

  /**
   * Assemble global flags + command argv. Global flags go BEFORE the command:
   * `agent-browser --json --session S <cmd…>`.
   */
  private assembleArgv(command: readonly string[], session: string | undefined, opts: CallOptions): string[] {
    const argv: string[] = [];
    // The npm launcher is a JS script; run it via process.execPath so a
    // missing shebang or non-executable bit never breaks us. Native binaries
    // are executed directly. Tests inject .mjs fixtures the same way.
    const isScript = /\.[cm]?js$/.test(this.binary().command);
    if (isScript) argv.push(process.execPath);
    argv.push(this.binary().command);
    if (opts.includeLaunchArgs !== false && this.cfg.launchArgs && this.cfg.launchArgs.length > 0) {
      argv.push("--args", this.cfg.launchArgs.join(","));
    }
    if (session) argv.push("--session", session);
    argv.push("--json");
    argv.push(...command);
    return argv;
  }

  private runProcess(argv: string[], opts: CallOptions): Promise<SpawnOutcome> {
    const [command, ...args] = argv;
    const timeoutMs = opts.timeoutMs ?? this.cfg.defaultTimeoutMs;
    return new Promise((resolve, reject) => {
      let settled = false;
      const child = this.spawnFn()(command!, args!, {
        stdio: opts.stdin === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
        env: this.childEnv(),
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              timedOut = true;
              try {
                child.kill("SIGKILL");
              } catch {
                /* already gone */
              }
            }, timeoutMs)
          : undefined;
      const onAbort = () => {
        if (settled) return;
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      if (opts.stdin !== undefined) {
        child.stdin?.end(opts.stdin);
      }
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        reject(err);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        if (timedOut) {
          reject(new CallTimeoutError(argv, timeoutMs));
          return;
        }
        if (opts.signal?.aborted) {
          reject(new Error("call aborted"));
          return;
        }
        resolve({ code, stdout, stderr });
      });
    });
  }

  /**
   * Run one agent-browser command with `--json` and return the stripped
   * payload plus the raw envelope.
   *
   * @typeParam T - expected payload shape.
   * @throws {CommandFailedError} on a success:false envelope.
   * @throws {CallTimeoutError} when the deadline is exceeded.
   */

  /**
   * Grant extra allowed domains at RUNTIME (e.g. after a host-side approval).
   * Merged into the existing allowlist; takes effect on the next daemon spawn
   * because the allowlist rides the child environment.
   */
  grantAllowedDomains(domains: readonly string[]): void {
    const current = new Set(this.cfg.allowedDomains ?? []);
    for (const d of domains) {
      const trimmed = String(d).trim().toLowerCase();
      if (trimmed.length > 0) current.add(trimmed);
    }
    this.cfg.allowedDomains = [...current];
  }

  /** Current effective allowlist (config + runtime grants). */
  get allowedDomains(): readonly string[] {
    return this.cfg.allowedDomains ?? [];
  }

  async call<T = Record<string, unknown>>(
    command: readonly string[],
    options: CallOptions & { session?: string } = {},
  ): Promise<CallResult<T>> {
    const argv = this.assembleArgv(command, options.session, options);
    let outcome: SpawnOutcome;
    try {
      outcome = await this.runProcess(argv, options);
    } catch (err) {
      if (err instanceof CallTimeoutError) throw err;
      throw new BinaryUnavailableError(
        `failed to spawn ${this.binary().command}: ${err instanceof Error ? err.message : String(err)}` +
          ` (if a pnpm install skipped this package's build scripts, see the dsh-agent-browser README's install note)`,
        { cause: err },
      );
    }
    if (outcome.stdout.trim().length === 0 && outcome.stderr.trim().length > 0) {
      // The CLI died before printing an envelope; surface why.
      throw new BinaryUnavailableError(
        `agent-browser exited (code ${outcome.code}) without output: ${outcome.stderr.trim().slice(-400)}`,
      );
    }
    const envelope = parseEnvelope(outcome.stdout, command as string[]) as CliEnvelope<
      T & { lifecycle?: unknown }
    >;
    if (!envelope.success) {
      const message = envelope.error ?? "unknown agent-browser failure";
      throw new CommandFailedError(message, {
        code: classifyFailure(message),
        data: envelope.data ?? undefined,
      });
    }
    // stripLifecycle preserves arrays (cookies/console/tabs payloads).
    const data = stripLifecycle((envelope.data ?? {}) as T);
    return { data: data as T, envelope };
  }

  /**
   * Run multiple commands in ONE daemon round-trip by piping an array of argv
   * arrays to `batch --json`.
   *
   * @param bail - stop at the first failing step (default false: every step runs).
   * @returns per-step outcomes in submission order.
   * @throws {BatchStepError} immediately when bail is true and a step fails.
   */
  async batch(
    steps: ReadonlyArray<readonly string[]>,
    options: CallOptions & { session?: string; bail?: boolean } = {},
  ): Promise<{ results: Array<Omit<BatchStepResult, "result"> & { result?: Record<string, unknown> }> }> {
    if (steps.length === 0) return { results: [] };
    const payload = JSON.stringify(steps.map((step) => [...step]));
    const argv = this.assembleArgv(["batch", ...(options.bail ? ["--bail"] : [])], options.session, options);
    const outcome = await this.runProcess(argv, { ...options, stdin: payload });
    let parsed: unknown;
    try {
      parsed = JSON.parse(outcome.stdout.trim());
    } catch (err) {
      throw new ProtocolViolationError(
        "agent-browser batch produced non-JSON output",
        outcome.stdout.slice(-400),
        err,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new ProtocolViolationError(
        "agent-browser batch output was not a JSON array",
        outcome.stdout.slice(-400),
      );
    }
    const results = parsed as BatchStepResult[];
    const cleaned = results.map((entry, index) => {
      if (!entry.success && options.bail) {
        throw new BatchStepError(index, entry.command ?? [], entry.error ?? "batch step failed", {
          code: classifyFailure(entry.error ?? ""),
        });
      }
      const resultRest = stripLifecycle(entry.result ?? {});
      return {
        command: entry.command ?? [],
        success: entry.success,
        error: entry.error ?? null,
        ...(entry.success ? { result: resultRest } : {}),
      };
    });
    return { results: cleaned };
  }

  /** True when at least one step failed. */
  static hasFailures(results: Array<{ success: boolean }>): boolean {
    return results.some((r) => !r.success);
  }

  /** Human-readable one-line summary of a batch outcome (for cards/logs). */
  static summarize(results: Array<{ command: string[]; success: boolean; error?: string | null }>): string {
    if (results.length === 0) return "no steps";
    const failed = results.filter((r) => !r.success);
    if (failed.length === 0) return `${results.length} step(s) ok`;
    const first = failed[0]!;
    return `${failed.length}/${results.length} step(s) failed; first: [${first.command.join(" ")}] ${first.error ?? ""}`;
  }
}