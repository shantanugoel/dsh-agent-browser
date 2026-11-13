import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visibleInterval } from "../client/visible-interval.ts";

function fakeDoc(initial: "visible" | "hidden" = "visible") {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: initial as DocumentVisibilityState,
    addEventListener: (_t: string, l: () => void) => void listeners.add(l),
    removeEventListener: (_t: string, l: () => void) => void listeners.delete(l),
  };
  return {
    doc: doc as unknown as Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">,
    set(state: "visible" | "hidden") {
      doc.visibilityState = state;
      for (const l of [...listeners]) l();
    },
    listeners,
  };
}

describe("visibleInterval", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("runs immediately and then every baseMs while visible", async () => {
    const d = fakeDoc();
    const run = vi.fn(async () => {});
    const stop = visibleInterval({ baseMs: 1000, run, doc: d.doc });
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(run).toHaveBeenCalledTimes(4);
    stop();
  });

  it("arms no timer while hidden and refreshes immediately on return", async () => {
    const d = fakeDoc("hidden");
    const run = vi.fn(async () => {});
    const stop = visibleInterval({ baseMs: 1000, run, doc: d.doc });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    d.set("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    stop();
  });

  it("clears the pending timer when the page becomes hidden mid-loop", async () => {
    const d = fakeDoc();
    const run = vi.fn(async () => {});
    const stop = visibleInterval({ baseMs: 1000, run, doc: d.doc });
    await vi.advanceTimersByTimeAsync(1500);
    d.set("hidden");
    expect(vi.getTimerCount()).toBe(0);
    const calls = run.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(run.mock.calls.length).toBe(calls);
    stop();
  });

  it("backs off while nothing changes and snaps back on a change", async () => {
    const d = fakeDoc();
    let changed = false;
    const run = vi.fn(async () => changed);
    const stop = visibleInterval({ baseMs: 1000, maxMs: 4000, run, doc: d.doc });
    await vi.advanceTimersByTimeAsync(0); // run 1 (unchanged) -> next in 1600
    await vi.advanceTimersByTimeAsync(1600); // run 2 -> next in 2560
    await vi.advanceTimersByTimeAsync(2560); // run 3 -> next in 4000 (cap)
    expect(run).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(3999);
    expect(run).toHaveBeenCalledTimes(3);
    changed = true;
    await vi.advanceTimersByTimeAsync(1); // run 4 (changed) -> next in 1000
    expect(run).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(5);
    stop();
  });

  it("never overlaps runs and removes its listener on dispose", async () => {
    const d = fakeDoc();
    let release: () => void = () => {};
    const run = vi.fn(() => new Promise<void>((r) => { release = r; }));
    const stop = visibleInterval({ baseMs: 1000, run, doc: d.doc });
    await vi.advanceTimersByTimeAsync(0);
    d.set("hidden");
    d.set("visible");
    expect(run).toHaveBeenCalledTimes(1);
    release();
    stop();
    expect(d.listeners.size).toBe(0);
  });
});
