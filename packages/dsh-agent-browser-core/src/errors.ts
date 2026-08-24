/**
 * Error taxonomy of the driver. Every failure surfaces as a
 * {@link BrowserDriverError} subclass so hosts (DSH, pi) can render precise
 * cards and decide retry/approval policy without string matching.
 *
 * @module dsh-agent-browser-core/errors
 */

/** Well-known machine codes agent-browser embeds in JSON error payloads. */
export type KnownFailureCode =
  /** The pinned/active tab disappeared; recovery data names the targetId. */
  | "tab_gone"
  /** A snapshot ref (or selector) no longer resolves on the current page. */
  | "ref_not_found"
  /** Navigation target was rejected by the daemon's allowlist. */
  | "domain_not_allowed";

/** Base class: carries the raw CLI failure text and any structured payload. */
export class BrowserDriverError extends Error {
  override readonly name: string = "BrowserDriverError";
  /** Machine code when one could be identified, else undefined. */
  readonly code?: KnownFailureCode;
  /** Structured recovery data from the envelope (e.g. tab_gone's targetId). */
  readonly data?: unknown;

  constructor(message: string, opts?: { code?: KnownFailureCode; data?: unknown; cause?: unknown }) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.code = opts?.code;
    this.data = opts?.data;
  }
}

/** The binary could not be located or spawned at all. */
export class BinaryUnavailableError extends BrowserDriverError {
  override readonly name: string = "BinaryUnavailableError";
}

/** The daemon answered with a command failure (success:false envelope). */
export class CommandFailedError extends BrowserDriverError {
  override readonly name: string = "CommandFailedError";
  constructor(
    message: string,
    opts?: { code?: KnownFailureCode; data?: unknown; cause?: unknown },
  ) {
    super(message, opts);
  }
}

/** stdout was not parseable as the expected JSON shape. */
export class ProtocolViolationError extends BrowserDriverError {
  override readonly name: string = "ProtocolViolationError";
  /** First bytes of the offending output for diagnostics. */
  readonly rawTail: string;
  constructor(message: string, rawTail: string, cause?: unknown) {
    super(message, { cause });
    this.rawTail = rawTail;
  }
}

/** A step inside a batch failed. Carries the per-step index and reason. */
export class BatchStepError extends BrowserDriverError {
  override readonly name: string = "BatchStepError";
  readonly index: number;
  readonly stepCommand: string[];
  constructor(index: number, stepCommand: string[], message: string, opts?: { code?: KnownFailureCode; data?: unknown }) {
    super(message, opts);
    this.index = index;
    this.stepCommand = stepCommand;
  }
}

/** The call exceeded its cooperative timeout and was killed. */
export class CallTimeoutError extends BrowserDriverError {
  override readonly name: string = "CallTimeoutError";
  readonly timeoutMs: number;
  constructor(argv: string[], timeoutMs: number) {
    super(`agent-browser call timed out after ${timeoutMs}ms: ${argv.join(" ")}`);
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Best-effort classifier for known failure strings in envelope errors.
 * Returns undefined for unrecognized text.
 */
export function classifyFailure(errorText: string): KnownFailureCode | undefined {
  if (/tab_gone/.test(errorText)) return "tab_gone";
  if (/ref not found|element not found/i.test(errorText)) return "ref_not_found";
  if (/not (?:in|on) the allowed(?:-| )domains?|allowed_domains/i.test(errorText)) return "domain_not_allowed";
  return undefined;
}