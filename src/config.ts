export let RELIEF_WIDTH = 90;
export let RELIEF_DEPTH = 105;
export let GRID_CELLS_X = 450;
export let GRID_CELLS_Y = 525;
export let GRID_CELL_SIZE = 0.2;

export interface GeometrySnapshot {
  width: number;
  depth: number;
  cellSize: number;
  columns: number;
  rows: number;
}

export function setGeometry(
  width: number,
  depth: number,
  cellSize: number,
): GeometrySnapshot {
  const safeCell = Math.max(0.04, cellSize);
  const columns = Math.max(32, Math.round(width / safeCell));
  const rows = Math.max(32, Math.round(depth / safeCell));
  GRID_CELLS_X = columns;
  GRID_CELLS_Y = rows;
  RELIEF_WIDTH = columns * safeCell;
  RELIEF_DEPTH = rows * safeCell;
  GRID_CELL_SIZE = safeCell;
  return {
    width: RELIEF_WIDTH,
    depth: RELIEF_DEPTH,
    cellSize: GRID_CELL_SIZE,
    columns,
    rows,
  };
}

export function footprintForAspect(
  aspect: number,
  longSide = 105,
): { width: number; depth: number } {
  const safeAspect = Math.max(0.2, Math.min(5, aspect));
  if (safeAspect >= 1) {
    return { width: longSide, depth: longSide / safeAspect };
  }
  return { width: longSide * safeAspect, depth: longSide };
}
export const DEFAULT_EXPLODE_DISTANCE = 26;
export const TOP_LAYER_COLOR: ColorIndex = 0;
export const MIDDLE_LAYER_COLOR: ColorIndex = 1;
export const BOTTOM_LAYER_COLOR: ColorIndex = 2;

export interface PartStyle {
  key: string;
  name: string;
  english: string;
  material: string;
  color: string;
  colorHex: number;
  dark: string;
  darkHex: number;
  rgb: [number, number, number];
}

export const PART_STYLES: PartStyle[] = [
  {
    key: 'yellow',
    name: '黄',
    english: 'YELLOW',
    material: 'PLA · 黄',
    color: '#f5c542',
    colorHex: 0xf5c542,
    dark: '#9a7416',
    darkHex: 0x8f6b11,
    rgb: [245, 197, 66],
  },
  {
    key: 'magenta',
    name: '品红',
    english: 'MAGENTA',
    material: 'PLA · 品红',
    color: '#ed3b91',
    colorHex: 0xed3b91,
    dark: '#941754',
    darkHex: 0x8c154f,
    rgb: [237, 59, 145],
  },
  {
    key: 'cyan',
    name: '青蓝',
    english: 'CYAN BLUE',
    material: 'PLA · 青蓝',
    color: '#20b9cf',
    colorHex: 0x20b9cf,
    dark: '#0b7283',
    darkHex: 0x096b7c,
    rgb: [32, 185, 207],
  },
];

export type ColorIndex = 0 | 1 | 2;

export const INK_HEX = 0x0a0d14;

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
