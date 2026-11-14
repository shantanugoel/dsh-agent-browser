/**
 * A repeating task that only runs while the page is visible.
 *
 * While the page is hidden no timer is armed (a plain `setInterval` that returns early still wakes the
 * main thread every tick). On becoming visible the task runs immediately instead of waiting out the
 * remainder of an interval, then repeats. When `maxMs` exceeds `baseMs` the delay grows while the task
 * reports "nothing changed" (exponential backoff up to `maxMs`) and snaps back to `baseMs` on any change.
 */
export interface VisibleIntervalOptions {
  /** Delay between runs while something is changing. */
  baseMs: number;
  /** Upper bound for the backoff delay; defaults to `baseMs` (no backoff). */
  maxMs?: number;
  /** Task. Return `false` when nothing changed since the last run (enables backoff); anything else counts as a change. */
  run: () => Promise<boolean | void> | boolean | void;
  /** Visibility source, injectable for tests. Defaults to `document`. */
  doc?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
}

/** @returns a disposer that stops the task and removes the listener. */
export function visibleInterval(options: VisibleIntervalOptions): () => void {
  const { baseMs, run } = options;
  const maxMs = options.maxMs ?? baseMs;
  const doc = options.doc ?? document;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = baseMs;
  let disposed = false;
  let running = false;

  const clear = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const schedule = (): void => {
    clear();
    if (disposed || doc.visibilityState === "hidden") return;
    timer = setTimeout(() => void tick(), delay);
  };
  const tick = async (): Promise<void> => {
    clear();
    if (disposed || running || doc.visibilityState === "hidden") return;
    running = true;
    try {
      const changed = await run();
      delay = changed === false ? Math.min(maxMs, Math.round(delay * 1.6)) : baseMs;
    } catch {
      delay = Math.min(maxMs, Math.round(delay * 1.6));
    } finally {
      running = false;
    }
    schedule();
  };
  const onVisibility = (): void => {
    if (doc.visibilityState === "hidden") {
      clear();
    } else if (!running) {
      delay = baseMs;
      void tick();
    }
  };

  doc.addEventListener("visibilitychange", onVisibility);
  void tick();
  return () => {
    disposed = true;
    clear();
    doc.removeEventListener("visibilitychange", onVisibility);
  };
}
