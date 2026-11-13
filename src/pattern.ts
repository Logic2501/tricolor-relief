import {
  GRID_CELLS_X,
  GRID_CELLS_Y,
  RELIEF_DEPTH,
  RELIEF_WIDTH,
  type ColorIndex,
} from './config';

export type LatticeArrangement = 'grid' | 'staggered';

export interface PatternParams {
  pitch: number;
  unitRatio: number;
  ratios: readonly [number, number, number];
  arrangement: LatticeArrangement;
  rotationDeg: number;
  jitter: number;
  seed: number;
}

export interface LatticeSite {
  x: number;
  y: number;
  color: ColorIndex;
}

export interface TricolorPattern {
  sites: LatticeSite[];
  params: PatternParams;
  /** Colour index for every geometry raster cell, row-major. */
  cellColors: Uint8Array;
  /** Number of lattice sites that own at least one raster cell. */
  visibleSiteCount: number;
  /** Returns the colour owning this XY coordinate. */
  classify: (x: number, y: number) => ColorIndex;
}

let HALF_W = RELIEF_WIDTH / 2;
let HALF_D = RELIEF_DEPTH / 2;
let CELL_COUNT = GRID_CELLS_X * GRID_CELLS_Y;

function refreshLayout(): void {
  HALF_W = RELIEF_WIDTH / 2;
  HALF_D = RELIEF_DEPTH / 2;
  CELL_COUNT = GRID_CELLS_X * GRID_CELLS_Y;
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normalizeRatios(
  ratios: readonly [number, number, number],
): [number, number, number] {
  const safe = ratios.map((ratio) => Math.max(0.001, ratio));
  const sum = safe[0] + safe[1] + safe[2];
  return [safe[0] / sum, safe[1] / sum, safe[2] / sum];
}

interface RasterData {
  cellSiteIndex: Uint32Array;
  siteCellCounts: Uint32Array;
  visibleSites: number[];
}

function buildRasterData(
  sites: Array<{ x: number; y: number }>,
): RasterData {
  const cellSiteIndex = new Uint32Array(CELL_COUNT);
  const siteCellCounts = new Uint32Array(sites.length);
  const dx = RELIEF_WIDTH / GRID_CELLS_X;
  const dy = RELIEF_DEPTH / GRID_CELLS_Y;

  for (let row = 0; row < GRID_CELLS_Y; row += 1) {
    const y = -HALF_D + (row + 0.5) * dy;
    for (let column = 0; column < GRID_CELLS_X; column += 1) {
      const x = -HALF_W + (column + 0.5) * dx;
      let bestIndex = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < sites.length; index += 1) {
        const site = sites[index];
        const siteDx = x - site.x;
        const siteDy = y - site.y;
        const distance = siteDx * siteDx + siteDy * siteDy;
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      }
      cellSiteIndex[row * GRID_CELLS_X + column] = bestIndex;
      siteCellCounts[bestIndex] += 1;
    }
  }

  const visibleSites: number[] = [];
  for (let index = 0; index < sites.length; index += 1) {
    if (siteCellCounts[index] > 0) visibleSites.push(index);
  }

  return { cellSiteIndex, siteCellCounts, visibleSites };
}

/**
 * Assign a colour to every lattice site using visible raster area rather than
 * site count. Sites are visited in a shuffled order, which deliberately keeps
 * the surface in the requested archipelago / mosaic style.
 */
function assignArchipelagoColours(
  sites: Array<{ x: number; y: number }>,
  raster: RasterData,
  ratios: readonly [number, number, number],
  seed: number,
): { labels: Int16Array; cellColors: Uint8Array } {
  const { cellSiteIndex, siteCellCounts, visibleSites } = raster;
  const labels = new Int16Array(sites.length).fill(0);
  const targetCounts = ratios.map((ratio) => ratio * CELL_COUNT);
  const colouredCounts = [0, 0, 0];
  const random = mulberry32(seed ^ 0x85ebca6b);

  const order = [...visibleSites];
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  for (const siteIndex of order) {
    const cellCount = siteCellCounts[siteIndex];
    let bestColour: ColorIndex = 0;
    let bestRatio = Number.POSITIVE_INFINITY;
    for (let colour = 0; colour < 3; colour += 1) {
      const ratioAfter =
        (colouredCounts[colour] + cellCount) / targetCounts[colour];
      if (ratioAfter < bestRatio) {
        bestRatio = ratioAfter;
        bestColour = colour as ColorIndex;
      }
    }
    labels[siteIndex] = bestColour;
    colouredCounts[bestColour] += cellCount;
  }

  for (let index = 0; index < sites.length; index += 1) {
    if (siteCellCounts[index] === 0) labels[index] = 0;
  }

  const cellColors = new Uint8Array(CELL_COUNT);
  for (let index = 0; index < CELL_COUNT; index += 1) {
    cellColors[index] = labels[cellSiteIndex[index]] as ColorIndex;
  }

  return { labels, cellColors };
}

/**
 * Replaces the procedural colour field with a quantised image-derived map.
 * The lattice is kept for diagnostics / optional dot markers, while all solid
 * geometry and validation use the image colours.
 */
export function overridePatternColors(
  pattern: TricolorPattern,
  cellColors: Uint8Array,
): TricolorPattern {
  if (cellColors.length !== CELL_COUNT) {
    throw new Error('Colour map dimensions do not match the relief raster');
  }
  const counts = [0, 0, 0];
  for (const color of cellColors) counts[color] += 1;
  const classify = (x: number, y: number): ColorIndex => {
    const column = Math.max(
      0,
      Math.min(
        GRID_CELLS_X - 1,
        Math.floor(((x + HALF_W) * GRID_CELLS_X) / RELIEF_WIDTH),
      ),
    );
    const row = Math.max(
      0,
      Math.min(
        GRID_CELLS_Y - 1,
        Math.floor(((y + HALF_D) * GRID_CELLS_Y) / RELIEF_DEPTH),
      ),
    );
    return cellColors[row * GRID_CELLS_X + column] as ColorIndex;
  };
  const sites = pattern.sites.map((site) => ({
    ...site,
    color: classify(site.x, site.y),
  }));
  return {
    ...pattern,
    sites,
    cellColors: new Uint8Array(cellColors),
    params: {
      ...pattern.params,
      ratios: [
        counts[0] / CELL_COUNT,
        counts[1] / CELL_COUNT,
        counts[2] / CELL_COUNT,
      ],
    },
    classify,
  };
}

export function createPattern(params: PatternParams): TricolorPattern {
  refreshLayout();
  const pitch = Math.max(2.5, params.pitch);
  const ratios = normalizeRatios(params.ratios);
  const angle = (params.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  const e1 = { x: cos, y: sin };
  const e2 = { x: -sin, y: cos };
  const rowPitch =
    params.arrangement === 'staggered' ? pitch * Math.sqrt(3) * 0.5 : pitch;
  const margin = pitch * 2.4;

  const corners = [
    [-HALF_W, -HALF_D],
    [HALF_W, -HALF_D],
    [HALF_W, HALF_D],
    [-HALF_W, HALF_D],
  ].map(([x, y]) => ({
    u: x * cos + y * sin,
    v: -x * sin + y * cos,
  }));

  const minU = Math.min(...corners.map((corner) => corner.u)) - margin;
  const maxU = Math.max(...corners.map((corner) => corner.u)) + margin;
  const minV = Math.min(...corners.map((corner) => corner.v)) - margin;
  const maxV = Math.max(...corners.map((corner) => corner.v)) + margin;

  const rows = Math.ceil((maxV - minV) / rowPitch) + 1;
  const jStart = Math.floor(minV / rowPitch) - 1;
  const random = mulberry32(params.seed);
  const jitter = Math.max(0, Math.min(1, params.jitter)) * pitch * 0.32;

  const rawSites: Array<{ x: number; y: number }> = [];
  const columns = Math.ceil((maxU - minU) / pitch) + 3;

  for (let row = 0; row <= rows; row += 1) {
    const j = jStart + row;
    const stagger = params.arrangement === 'staggered' && Math.abs(j % 2) === 1;
    const offset = stagger ? pitch * 0.5 : 0;
    const iStart = Math.floor((minU - offset) / pitch) - 1;

    for (let column = 0; column < columns; column += 1) {
      const i = iStart + column;
      const u = i * pitch + offset + (random() * 2 - 1) * jitter;
      const v = j * rowPitch + (random() * 2 - 1) * jitter;
      const x = u * e1.x + v * e2.x;
      const y = u * e1.y + v * e2.y;
      rawSites.push({ x, y });
    }
  }

  const raster = buildRasterData(rawSites);
  const { labels, cellColors } = assignArchipelagoColours(
    rawSites,
    raster,
    ratios,
    params.seed,
  );
  const sites = rawSites.map((site, index) => ({
    ...site,
    color: labels[index] as ColorIndex,
  }));

  const classify = (x: number, y: number): ColorIndex => {
    const column = Math.max(
      0,
      Math.min(
        GRID_CELLS_X - 1,
        Math.floor(((x + HALF_W) * GRID_CELLS_X) / RELIEF_WIDTH),
      ),
    );
    const row = Math.max(
      0,
      Math.min(
        GRID_CELLS_Y - 1,
        Math.floor(((y + HALF_D) * GRID_CELLS_Y) / RELIEF_DEPTH),
      ),
    );
    return cellColors[row * GRID_CELLS_X + column] as ColorIndex;
  };

  return {
    sites,
    params: { ...params, ratios },
    cellColors,
    visibleSiteCount: raster.visibleSites.length,
    classify,
  };
}
