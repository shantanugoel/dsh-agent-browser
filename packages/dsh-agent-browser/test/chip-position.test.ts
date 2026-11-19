import { describe, expect, it } from "vitest";
import {
  CHIP_KEY,
  CHIP_SIZE,
  CHIP_SIZE_COARSE,
  DEFAULT_PLACEMENT,
  EDGE_MARGIN,
  NARROW_WIDTH,
  PANEL_GAP,
  PANEL_MAX_WIDTH,
  TAP_SLOP,
  TOP_INSET,
  chipSize,
  clampFree,
  clampTop,
  exceedsTapSlop,
  loadPlacement,
  panelLayout,
  parsePlacement,
  placementToRect,
  savePlacement,
  snapPlacement,
  type Viewport,
} from "../client/chip-position.ts";

const phone: Viewport = { left: 0, top: 0, width: 393, height: 851 };
/** The same phone with the on-screen keyboard up: the visual viewport is much shorter than the layout one. */
const keyboard: Viewport = { left: 0, top: 0, width: 393, height: 400 };
const desktop: Viewport = { left: 0, top: 0, width: 1440, height: 900 };

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

describe("tap vs drag", () => {
  it("treats movement below the slop as a tap and at/above it as a drag", () => {
    expect(exceedsTapSlop(0, 0)).toBe(false);
    expect(exceedsTapSlop(3, 4)).toBe(false); // distance 5
    expect(exceedsTapSlop(TAP_SLOP - 0.1, 0)).toBe(false);
    expect(exceedsTapSlop(TAP_SLOP, 0)).toBe(true);
    expect(exceedsTapSlop(-4, -5)).toBe(true); // distance ~6.4
    expect(exceedsTapSlop(0, 20)).toBe(true);
  });

  it("honours a custom slop", () => {
    expect(exceedsTapSlop(8, 0, 10)).toBe(false);
    expect(exceedsTapSlop(10, 0, 10)).toBe(true);
  });
});

describe("chip size", () => {
  it("is 36 on fine pointers and 40 on coarse ones", () => {
    expect(chipSize(false)).toBe(CHIP_SIZE);
    expect(chipSize(true)).toBe(CHIP_SIZE_COARSE);
    expect(CHIP_SIZE).toBe(36);
    expect(CHIP_SIZE_COARSE).toBe(40);
  });
});

describe("clamping", () => {
  it("keeps the chip below the header bar and above the bottom margin", () => {
    expect(clampTop(-100, 36, phone)).toBe(TOP_INSET);
    expect(clampTop(0, 36, phone)).toBe(TOP_INSET);
    expect(clampTop(10_000, 36, phone)).toBe(851 - 36 - EDGE_MARGIN);
    expect(clampTop(300, 36, phone)).toBe(300);
  });

  it("clamps freely on both axes while dragging", () => {
    expect(clampFree(-50, -50, 40, phone)).toEqual({ left: EDGE_MARGIN, top: TOP_INSET });
    expect(clampFree(9999, 9999, 40, phone)).toEqual({ left: 393 - 40 - EDGE_MARGIN, top: 851 - 40 - EDGE_MARGIN });
  });

  it("respects a visual viewport that is offset (pinch-zoom / scrolled keyboard viewport)", () => {
    const vp: Viewport = { left: 20, top: 100, width: 300, height: 400 };
    expect(clampFree(0, 0, 36, vp)).toEqual({ left: 20 + EDGE_MARGIN, top: 100 + EDGE_MARGIN });
    expect(clampFree(9999, 9999, 36, vp)).toEqual({ left: 20 + 300 - 36 - EDGE_MARGIN, top: 100 + 400 - 36 - EDGE_MARGIN });
  });

  it("falls back to the lowest allowed top when the viewport is too short for the chip", () => {
    const tiny: Viewport = { left: 0, top: 0, width: 300, height: 60 };
    expect(clampTop(30, 40, tiny)).toBe(TOP_INSET);
  });
});

describe("placement maths", () => {
  it("defaults to the right edge, vertically centred (away from the composer's send button)", () => {
    expect(DEFAULT_PLACEMENT).toEqual({ side: "right", y: 0.5 });
    const r = placementToRect(DEFAULT_PLACEMENT, 40, phone, 851);
    expect(r.left).toBe(393 - 40 - EDGE_MARGIN);
    expect(r.top).toBe(425.5 - 20);
    expect(r.top + 20).toBe(851 / 2);
  });

  it("snaps to the nearest edge by the chip's centre and keeps the vertical position", () => {
    expect(snapPlacement(100, 200, 40, phone, 851)).toEqual({ side: "left", y: 220 / 851 });
    expect(snapPlacement(300, 200, 40, phone, 851)).toEqual({ side: "right", y: 220 / 851 });
    // centre exactly on the midline goes right
    expect(snapPlacement(393 / 2 - 20, 200, 40, phone, 851).side).toBe("right");
  });

  it("clamps the vertical position when snapping a chip released under the header or off the bottom", () => {
    expect(snapPlacement(10, -40, 40, phone, 851).y).toBe((TOP_INSET + 20) / 851);
    expect(snapPlacement(10, 5000, 40, phone, 851).y).toBe((851 - EDGE_MARGIN - 20) / 851);
  });

  it("round-trips: a snapped placement lands on the edge at the released height", () => {
    const placement = snapPlacement(20, 120, 36, desktop, 900);
    const rect = placementToRect(placement, 36, desktop, 900);
    expect(rect).toEqual({ left: EDGE_MARGIN, top: 120 });
  });

  it("keeps the chip inside the visible area when the on-screen keyboard shrinks the viewport", () => {
    const rect = placementToRect({ side: "right", y: 0.8 }, 40, keyboard, 851); // 680 on a 400px-tall viewport
    expect(rect.top).toBe(400 - 40 - EDGE_MARGIN);
    expect(rect.top + 40).toBeLessThanOrEqual(keyboard.height);
    // and the saved fraction is untouched, so it returns when the keyboard goes away
    expect(placementToRect({ side: "right", y: 0.8 }, 40, phone, 851).top).toBeCloseTo(660.8, 5);
  });

  it("re-clamps after an orientation change to a short, wide viewport", () => {
    const landscape: Viewport = { left: 0, top: 0, width: 851, height: 393 };
    const rect = placementToRect({ side: "left", y: 1 }, 40, landscape, 393);
    expect(rect.left).toBe(EDGE_MARGIN);
    expect(rect.top).toBe(393 - 40 - EDGE_MARGIN);
  });
});

describe("persistence", () => {
  it("parses a valid stored value", () => {
    expect(parsePlacement('{"side":"left","y":0.25}')).toEqual({ side: "left", y: 0.25 });
  });

  it("clamps an out-of-range fraction instead of discarding it", () => {
    expect(parsePlacement('{"side":"right","y":7}')).toEqual({ side: "right", y: 1 });
    expect(parsePlacement('{"side":"right","y":-2}')).toEqual({ side: "right", y: 0 });
  });

  it.each([
    [null],
    [undefined],
    [""],
    ["not json"],
    ["null"],
    ["42"],
    ['"left"'],
    ["[]"],
    ['{"side":"middle","y":0.5}'],
    ['{"side":"left"}'],
    ['{"side":"left","y":"0.5"}'],
    ['{"side":"left","y":null}'],
    ["{\"side\":\"left\",\"y\":1e999}"],
  ])("rejects bad stored value %j", (raw) => {
    expect(parsePlacement(raw as string | null | undefined)).toBeNull();
  });

  it("loads the default when nothing or garbage is stored", () => {
    expect(loadPlacement(memoryStorage())).toEqual(DEFAULT_PLACEMENT);
    expect(loadPlacement(memoryStorage({ [CHIP_KEY]: "{oops" }))).toEqual(DEFAULT_PLACEMENT);
    expect(loadPlacement(null)).toEqual(DEFAULT_PLACEMENT);
  });

  it("returns a fresh default object each time", () => {
    const a = loadPlacement(null);
    a.y = 0.1;
    expect(loadPlacement(null).y).toBe(0.5);
  });

  it("writes and reads back", () => {
    const storage = memoryStorage();
    savePlacement({ side: "left", y: 0.1 }, storage);
    expect(storage.data.get(CHIP_KEY)).toBe('{"side":"left","y":0.1}');
    expect(loadPlacement(storage)).toEqual({ side: "left", y: 0.1 });
  });

  it("survives storage that throws", () => {
    const hostile = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(loadPlacement(hostile)).toEqual(DEFAULT_PLACEMENT);
    expect(() => savePlacement({ side: "right", y: 0.3 }, hostile)).not.toThrow();
  });
});

describe("float panel layout", () => {
  it("is full-width with a margin below 640 px", () => {
    const p = panelLayout({ side: "right", y: 0.2 }, 40, phone, 851);
    expect(p.left).toBe(EDGE_MARGIN);
    expect(p.width).toBe(393 - 2 * EDGE_MARGIN);
  });

  it("opens downward from a chip in the upper half, upward from one in the lower half", () => {
    const upper = panelLayout({ side: "right", y: 0.2 }, 40, phone, 851);
    expect(upper.bottom).toBeUndefined();
    expect(upper.top).toBeCloseTo(0.2 * 851 - 20 + 40 + PANEL_GAP, 5);
    const lower = panelLayout({ side: "right", y: 0.8 }, 40, phone, 851);
    expect(lower.top).toBeUndefined();
    expect(lower.bottom).toBeCloseTo(851 - 0.8 * 851 + 20 + PANEL_GAP, 5);
  });

  it("stays inside the visible viewport", () => {
    for (const top of [0, 0.1, 0.3, 0.49, 0.5, 0.7, 1]) {
      for (const vp of [phone, keyboard, desktop]) {
        const h = vp === desktop ? 900 : 851;
        const p = panelLayout({ side: "left", y: top }, 40, vp, h);
        expect(p.left).toBeGreaterThanOrEqual(vp.left);
        expect(p.left + p.width).toBeLessThanOrEqual(vp.left + vp.width);
        if (p.top !== undefined) {
          expect(p.top).toBeGreaterThanOrEqual(vp.top);
          expect(p.top + Math.min(p.maxHeight, 160)).toBeLessThanOrEqual(vp.top + vp.height);
        } else {
          const bottomEdge = h - (p.bottom ?? 0);
          expect(bottomEdge).toBeLessThanOrEqual(vp.top + vp.height);
        }
      }
    }
  });

  it("is capped at 420 px and hugs the chip's side on wide screens", () => {
    const right = panelLayout({ side: "right", y: 0.3 }, 36, desktop, 900);
    expect(right.width).toBe(PANEL_MAX_WIDTH);
    expect(right.left).toBe(1440 - PANEL_MAX_WIDTH - EDGE_MARGIN);
    const left = panelLayout({ side: "left", y: 0.3 }, 36, desktop, 900);
    expect(left.left).toBe(EDGE_MARGIN);
    expect(NARROW_WIDTH).toBe(640);
  });
});
