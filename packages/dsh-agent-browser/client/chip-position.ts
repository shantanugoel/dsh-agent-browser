/**
 * Pure placement logic for the collapsed launcher chip and the floating panel anchored to it.
 *
 * Everything here works in layout-viewport coordinates (what `position: fixed` uses) and takes the
 * *visible* viewport as input, so the chip and panel stay clear of the phone's on-screen keyboard
 * when the caller derives that viewport from `window.visualViewport`. No DOM access except the
 * optional `Storage` the persistence helpers receive.
 */

export type ChipSide = "left" | "right";

/** Saved chip position: which edge it sits on and its vertical centre as a fraction of the layout viewport height. */
export interface ChipPlacement {
  side: ChipSide;
  y: number;
}

/** The visible area, in layout-viewport coordinates. */
export interface Viewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Rect {
  left: number;
  top: number;
}

export const CHIP_SIZE = 36;
export const CHIP_SIZE_COARSE = 40;
/** Gap kept between the chip/panel and the viewport edges. */
export const EDGE_MARGIN = 8;
/** Space reserved for the app's top header bar; the chip never goes above it. */
export const TOP_INSET = 56;
/** A press that moves less than this many CSS px is a tap, not a drag. */
export const TAP_SLOP = 6;
/** Below this viewport width the float panel spans the full width. */
export const NARROW_WIDTH = 640;
export const PANEL_MAX_WIDTH = 420;
export const PANEL_MIN_HEIGHT = 160;

export const CHIP_KEY = "dsh-agent-browser.chip";
/** Right edge, vertically centred: well away from the composer's send button at the bottom-right. */
export const DEFAULT_PLACEMENT: ChipPlacement = { side: "right", y: 0.5 };

export function chipSize(coarsePointer: boolean): number {
  return coarsePointer ? CHIP_SIZE_COARSE : CHIP_SIZE;
}

/** True once a press has moved far enough to count as a drag. */
export function exceedsTapSlop(dx: number, dy: number, slop: number = TAP_SLOP): boolean {
  return Math.hypot(dx, dy) >= slop;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(Math.max(lo, hi), value));
}

/** Lowest allowed top edge: below the header bar and inside the visible area. */
function minTop(vp: Viewport): number {
  return Math.max(vp.top + EDGE_MARGIN, TOP_INSET);
}

/** Clamp a chip's top edge so it stays inside the visible area and below the header bar. */
export function clampTop(top: number, size: number, vp: Viewport): number {
  return clamp(top, minTop(vp), vp.top + vp.height - size - EDGE_MARGIN);
}

/** Clamp a chip position freely on both axes (used while dragging). */
export function clampFree(left: number, top: number, size: number, vp: Viewport): Rect {
  return {
    left: clamp(left, vp.left + EDGE_MARGIN, vp.left + vp.width - size - EDGE_MARGIN),
    top: clampTop(top, size, vp),
  };
}

/**
 * Where a saved placement lands in the visible viewport. The fraction is of the *layout* height, so a
 * shrunk visual viewport (on-screen keyboard) clamps the chip into view instead of rescaling it.
 */
export function placementToRect(placement: ChipPlacement, size: number, vp: Viewport, layoutHeight: number): Rect {
  const left =
    placement.side === "left" ? vp.left + EDGE_MARGIN : vp.left + vp.width - size - EDGE_MARGIN;
  return {
    left: Math.max(vp.left + EDGE_MARGIN, left),
    top: clampTop(placement.y * layoutHeight - size / 2, size, vp),
  };
}

/** Snap a released chip to the nearer left/right edge, keeping its (clamped) vertical position. */
export function snapPlacement(
  left: number,
  top: number,
  size: number,
  vp: Viewport,
  layoutHeight: number,
): ChipPlacement {
  const side: ChipSide = left + size / 2 < vp.left + vp.width / 2 ? "left" : "right";
  const fraction =
    layoutHeight > 0 ? (clampTop(top, size, vp) + size / 2) / layoutHeight : DEFAULT_PLACEMENT.y;
  return { side, y: clamp(fraction, 0, 1) };
}

/** Validate a stored value; anything malformed yields `null`. Out-of-range fractions are clamped. */
export function parsePlacement(raw: string | null | undefined): ChipPlacement | null {
  if (typeof raw !== "string" || raw === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object") return null;
  const { side, y } = value as { side?: unknown; y?: unknown };
  if (side !== "left" && side !== "right") return null;
  if (typeof y !== "number" || !Number.isFinite(y)) return null;
  return { side, y: clamp(y, 0, 1) };
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Read the saved placement, falling back to the default when absent, malformed, or storage is blocked. */
export function loadPlacement(storage: StorageLike | null = defaultStorage()): ChipPlacement {
  try {
    return parsePlacement(storage?.getItem(CHIP_KEY)) ?? { ...DEFAULT_PLACEMENT };
  } catch {
    return { ...DEFAULT_PLACEMENT };
  }
}

export function savePlacement(placement: ChipPlacement, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(CHIP_KEY, JSON.stringify(placement));
  } catch {
    /* storage unavailable: the placement lasts for this page load only */
  }
}

/** Geometry for the open float panel, as `position: fixed` offsets (`bottom` is from the layout viewport's bottom). */
export interface PanelLayout {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

/** Gap between the chip and the float panel next to it. */
export const PANEL_GAP = 6;

/**
 * Anchor the float panel to the chip without covering it: same edge as the chip, opening downward
 * when the chip is in the upper half of the visible area and upward otherwise. Below
 * {@link NARROW_WIDTH} it spans the visible width.
 */
export function panelLayout(
  placement: ChipPlacement,
  size: number,
  vp: Viewport,
  layoutHeight: number,
): PanelLayout {
  const narrow = vp.width < NARROW_WIDTH;
  const width = narrow ? vp.width - 2 * EDGE_MARGIN : Math.min(PANEL_MAX_WIDTH, vp.width - 2 * EDGE_MARGIN);
  const left =
    narrow || placement.side === "left" ? vp.left + EDGE_MARGIN : vp.left + vp.width - width - EDGE_MARGIN;
  const chip = placementToRect(placement, size, vp, layoutHeight);
  const upper = chip.top + size / 2 < vp.top + vp.height / 2;
  if (upper) {
    const top = chip.top + size + PANEL_GAP;
    return { left, width, top, maxHeight: Math.max(PANEL_MIN_HEIGHT, vp.top + vp.height - EDGE_MARGIN - top) };
  }
  return {
    left,
    width,
    bottom: Math.max(0, layoutHeight - chip.top + PANEL_GAP),
    maxHeight: Math.max(PANEL_MIN_HEIGHT, chip.top - PANEL_GAP - minTop(vp)),
  };
}
