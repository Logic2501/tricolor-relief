import {
  GRID_CELLS_X,
  GRID_CELLS_Y,
  RELIEF_DEPTH,
  RELIEF_WIDTH,
  type ColorIndex,
} from './config';
import type { TricolorPattern } from './pattern';
import { buildConnectors } from './connectors';
import { sampleReliefVolume, type ReliefField } from './relief';

let HALF_W = RELIEF_WIDTH / 2;
let HALF_D = RELIEF_DEPTH / 2;

function refreshLayout(): void {
  HALF_W = RELIEF_WIDTH / 2;
  HALF_D = RELIEF_DEPTH / 2;
}
const DOT_SEGMENTS = 16;
const DOT_HEIGHT_OFFSET = 0.045;
const LINE_HEIGHT_OFFSET = 0.025;

interface MeshAccumulator {
  positions: number[];
  normals: number[];
}

export interface PartBuildData {
  positions: Float32Array;
  normals: Float32Array;
  connectorPositions: Float32Array;
  connectorNormals: Float32Array;
  dotLinePositions: Float32Array;
  boundaryLinePositions: Float32Array;
  reliefVolume: number;
  connectorVolume: number;
  volume: number;
  planArea: number;
  boundaryEdgeCount: number;
  triangleCount: number;
}

export interface ValidationReport {
  originalVolume: number;
  volumeSum: number;
  volumeDifference: number;
  volumeDifferencePercent: number;
  analyticVolume: number;
  analyticDifference: number;
  overlapArea: number;
  uncoveredArea: number;
  totalPlanArea: number;
  topMaxDeviation: number;
  topRmsDeviation: number;
  minSurfaceHeight: number;
  maxSurfaceHeight: number;
  closed: boolean;
  bottomFlat: boolean;
  surfaceIslandCounts: [number, number, number];
  stemCounts: [number, number, number];
  partConnected: [boolean, boolean, boolean];
  plateConnected: [boolean, boolean, boolean];
  connectorVolume: number;
  totalPrintVolume: number;
  volumeExclusive: boolean;
  volumeOverlap: number;
  baseColour: ColorIndex;
  areaRatios: [number, number, number];
  targetRatios: [number, number, number];
  sampleCount: number;
}

export interface ReliefBuildData {
  parts: PartBuildData[];
  pattern: TricolorPattern;
  field: ReliefField;
  grid: {
    cellsX: number;
    cellsY: number;
    dx: number;
    dy: number;
    cellColors: Uint8Array;
  };
  validation: ValidationReport;
  layerOrder: [ColorIndex, ColorIndex, ColorIndex];
  stats: {
    cells: number;
    triangles: number;
    siteCount: number;
  };
}

export interface SectionPartData {
  positions: Float32Array;
  normals: Float32Array;
  linePositions: Float32Array;
}

export interface SectionCapsData {
  parts: SectionPartData[];
}

function addTriangle(
  target: MeshAccumulator,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  nax: number,
  nay: number,
  naz: number,
  nbx: number,
  nby: number,
  nbz: number,
  ncx: number,
  ncy: number,
  ncz: number,
): void {
  target.positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  target.normals.push(nax, nay, naz, nbx, nby, nbz, ncx, ncy, ncz);
}

function addWall(
  target: MeshAccumulator,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  za: number,
  zb: number,
  nx: number,
  ny: number,
): void {
  // nx / ny describe the outward-facing horizontal normal of this wall.
  const ox = nx;
  const oy = ny;
  addTriangle(
    target,
    ax, ay, 0,
    bx, by, 0,
    bx, by, zb,
    ox, oy, 0,
    ox, oy, 0,
    ox, oy, 0,
  );
  addTriangle(
    target,
    ax, ay, 0,
    bx, by, zb,
    ax, ay, za,
    ox, oy, 0,
    ox, oy, 0,
    ox, oy, 0,
  );
}

function addBottomCell(
  target: MeshAccumulator,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  const normal = [0, 0, -1] as const;
  addTriangle(
    target,
    x0, y0, 0,
    x1, y1, 0,
    x1, y0, 0,
    ...normal,
    ...normal,
    ...normal,
  );
  addTriangle(
    target,
    x0, y0, 0,
    x0, y1, 0,
    x1, y1, 0,
    ...normal,
    ...normal,
    ...normal,
  );
}

function addBoundarySegment(
  positions: number[],
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): void {
  positions.push(ax, ay, az + LINE_HEIGHT_OFFSET, bx, by, bz + LINE_HEIGHT_OFFSET);
}

function buildDotRings(
  pattern: TricolorPattern,
  field: ReliefField,
): Float32Array[] {
  const rings: number[][] = [[], [], []];
  const radius = Math.max(
    0.15 * pattern.params.pitch,
    Math.min(
      pattern.params.pitch * 0.72,
      (pattern.params.pitch * pattern.params.unitRatio) / 2,
    ),
  );

  for (const site of pattern.sites) {
    if (
      site.x < -HALF_W + 0.4 ||
      site.x > HALF_W - 0.4 ||
      site.y < -HALF_D + 0.4 ||
      site.y > HALF_D - 0.4
    ) {
      continue;
    }

    const target = rings[pattern.classify(site.x, site.y)];
    let previous: { x: number; y: number; z: number } | null = null;
    let first: { x: number; y: number; z: number } | null = null;

    for (let segment = 0; segment <= DOT_SEGMENTS; segment += 1) {
      const angle = (segment / DOT_SEGMENTS) * Math.PI * 2;
      const x = site.x + Math.cos(angle) * radius;
      const y = site.y + Math.sin(angle) * radius;
      if (x < -HALF_W || x > HALF_W || y < -HALF_D || y > HALF_D) {
        previous = null;
        continue;
      }
      const point = { x, y, z: field.height(x, y) + DOT_HEIGHT_OFFSET };
      if (!first) first = point;
      if (previous) {
        target.push(
          previous.x,
          previous.y,
          previous.z,
          point.x,
          point.y,
          point.z,
        );
      }
      previous = point;
    }

    if (previous && first && previous !== first) {
      if (
        Math.hypot(previous.x - first.x, previous.y - first.y) < radius * 0.3
      ) {
        target.push(
          previous.x,
          previous.y,
          previous.z,
          first.x,
          first.y,
          first.z,
        );
      }
    }
  }

  return rings.map((positions) => new Float32Array(positions));
}

function bilinearTop(
  localX: number,
  localY: number,
  z00: number,
  z10: number,
  z11: number,
  z01: number,
): number {
  if (localY <= localX) {
    return z00 + localX * (z10 - z00) + localY * (z11 - z10);
  }
  return z00 + localX * (z11 - z01) + localY * (z01 - z00);
}

export function buildRelief(
  pattern: TricolorPattern,
  field: ReliefField,
  options: {
    sampleValidation?: boolean;
    layerColors?: [ColorIndex, ColorIndex, ColorIndex];
  } = {},
): ReliefBuildData {
  refreshLayout();
  const nx = GRID_CELLS_X;
  const ny = GRID_CELLS_Y;
  const dx = RELIEF_WIDTH / nx;
  const dy = RELIEF_DEPTH / ny;

  const vertexHeights = new Float32Array((nx + 1) * (ny + 1));
  const vertexNormals = new Float32Array((nx + 1) * (ny + 1) * 3);
  let minSurfaceHeight = Number.POSITIVE_INFINITY;
  let maxSurfaceHeight = Number.NEGATIVE_INFINITY;

  for (let j = 0; j <= ny; j += 1) {
    for (let i = 0; i <= nx; i += 1) {
      const x = -HALF_W + i * dx;
      const y = -HALF_D + j * dy;
      const height = field.height(x, y);
      const normal = field.normal(x, y);
      const vertexIndex = j * (nx + 1) + i;
      vertexHeights[vertexIndex] = height;
      vertexNormals[vertexIndex * 3] = normal[0];
      vertexNormals[vertexIndex * 3 + 1] = normal[1];
      vertexNormals[vertexIndex * 3 + 2] = normal[2];
      minSurfaceHeight = Math.min(minSurfaceHeight, height);
      maxSurfaceHeight = Math.max(maxSurfaceHeight, height);
    }
  }

  const cells = nx * ny;
  const cellColors = pattern.cellColors;
  const cellCounts = [0, 0, 0];
  for (let index = 0; index < cellColors.length; index += 1) {
    cellCounts[cellColors[index]] += 1;
  }

  const accumulators: MeshAccumulator[] = [0, 1, 2].map(() => ({
    positions: [],
    normals: [],
  }));
  const boundaryLines: number[][] = [[], [], []];
  const partVolumes = [0, 0, 0];
  const boundaryEdgeCounts = [0, 0, 0];
  let originalVolume = 0;

  for (let j = 0; j < ny; j += 1) {
    const y0 = -HALF_D + j * dy;
    const y1 = y0 + dy;
    for (let i = 0; i < nx; i += 1) {
      const x0 = -HALF_W + i * dx;
      const x1 = x0 + dx;
      const cellIndex = j * nx + i;
      const color = cellColors[cellIndex];
      const accumulator = accumulators[color];

      const i00 = j * (nx + 1) + i;
      const i10 = i00 + 1;
      const i01 = i00 + nx + 1;
      const i11 = i01 + 1;
      const z00 = vertexHeights[i00];
      const z10 = vertexHeights[i10];
      const z01 = vertexHeights[i01];
      const z11 = vertexHeights[i11];

      const n00x = vertexNormals[i00 * 3];
      const n00y = vertexNormals[i00 * 3 + 1];
      const n00z = vertexNormals[i00 * 3 + 2];
      const n10x = vertexNormals[i10 * 3];
      const n10y = vertexNormals[i10 * 3 + 1];
      const n10z = vertexNormals[i10 * 3 + 2];
      const n01x = vertexNormals[i01 * 3];
      const n01y = vertexNormals[i01 * 3 + 1];
      const n01z = vertexNormals[i01 * 3 + 2];
      const n11x = vertexNormals[i11 * 3];
      const n11y = vertexNormals[i11 * 3 + 1];
      const n11z = vertexNormals[i11 * 3 + 2];

      addTriangle(
        accumulator,
        x0, y0, z00,
        x1, y0, z10,
        x1, y1, z11,
        n00x, n00y, n00z,
        n10x, n10y, n10z,
        n11x, n11y, n11z,
      );
      addTriangle(
        accumulator,
        x0, y0, z00,
        x1, y1, z11,
        x0, y1, z01,
        n00x, n00y, n00z,
        n11x, n11y, n11z,
        n01x, n01y, n01z,
      );

      const triangleArea = (dx * dy) / 2;
      const cellVolume =
        triangleArea * (z00 + z10 + z11) / 3 +
        triangleArea * (z00 + z11 + z01) / 3;
      partVolumes[color] += cellVolume;
      originalVolume += cellVolume;

      addBottomCell(accumulator, x0, y0, x1, y1);

      const southDifference =
        j === 0 || cellColors[(j - 1) * nx + i] !== color;
      if (southDifference) {
        addWall(accumulator, x0, y0, x1, y0, z00, z10, 0, -1);
        addBoundarySegment(boundaryLines[color], x0, y0, z00, x1, y0, z10);
        boundaryEdgeCounts[color] += 1;
      }

      const eastDifference =
        i === nx - 1 || cellColors[j * nx + i + 1] !== color;
      if (eastDifference) {
        addWall(accumulator, x1, y0, x1, y1, z10, z11, 1, 0);
        addBoundarySegment(boundaryLines[color], x1, y0, z10, x1, y1, z11);
        boundaryEdgeCounts[color] += 1;
      }

      const northDifference =
        j === ny - 1 || cellColors[(j + 1) * nx + i] !== color;
      if (northDifference) {
        addWall(accumulator, x1, y1, x0, y1, z11, z01, 0, 1);
        addBoundarySegment(boundaryLines[color], x1, y1, z11, x0, y1, z01);
        boundaryEdgeCounts[color] += 1;
      }

      const westDifference =
        i === 0 || cellColors[j * nx + i - 1] !== color;
      if (westDifference) {
        addWall(accumulator, x0, y1, x0, y0, z01, z00, -1, 0);
        addBoundarySegment(boundaryLines[color], x0, y1, z01, x0, y0, z00);
        boundaryEdgeCounts[color] += 1;
      }
    }
  }

  const dotRings = buildDotRings(pattern, field);
  const connectorSystem = buildConnectors(
    cellColors,
    options.layerColors ?? [0, 1, 2],
  );
  const partData: PartBuildData[] = accumulators.map((accumulator, color) => {
    const connectorVolume = connectorSystem.parts[color].volume;
    return {
      positions: new Float32Array(accumulator.positions),
      normals: new Float32Array(accumulator.normals),
      connectorPositions: connectorSystem.parts[color].positions,
      connectorNormals: connectorSystem.parts[color].normals,
      dotLinePositions: dotRings[color],
      boundaryLinePositions: new Float32Array(boundaryLines[color]),
      reliefVolume: partVolumes[color],
      connectorVolume,
      volume: partVolumes[color] + connectorVolume,
      planArea: cellCounts[color] * dx * dy,
      boundaryEdgeCount: boundaryEdgeCounts[color],
      triangleCount: accumulator.positions.length / 9,
    };
  });

  const volumeSum = partVolumes[0] + partVolumes[1] + partVolumes[2];
  const totalPlanArea = RELIEF_WIDTH * RELIEF_DEPTH;

  let topMaxDeviation = 0;
  let topSquaredDeviation = 0;
  let sampleCount = 0;
  if (options.sampleValidation !== false) {
    const desiredSamples = 9000;
    let randomState = 0x51f15e;
    const random = (): number => {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      return randomState / 4294967296;
    };
    for (let sample = 0; sample < desiredSamples; sample += 1) {
      const x = -HALF_W + random() * RELIEF_WIDTH;
      const y = -HALF_D + random() * RELIEF_DEPTH;
      const i = Math.min(nx - 1, Math.floor((x + HALF_W) / dx));
      const j = Math.min(ny - 1, Math.floor((y + HALF_D) / dy));
      const localX = (x + HALF_W) / dx - i;
      const localY = (y + HALF_D) / dy - j;
      const i00 = j * (nx + 1) + i;
      const i10 = i00 + 1;
      const i01 = i00 + nx + 1;
      const i11 = i01 + 1;
      const approximation = bilinearTop(
        localX,
        localY,
        vertexHeights[i00],
        vertexHeights[i10],
        vertexHeights[i11],
        vertexHeights[i01],
      );
      const deviation = Math.abs(approximation - field.height(x, y));
      topMaxDeviation = Math.max(topMaxDeviation, deviation);
      topSquaredDeviation += deviation * deviation;
      sampleCount += 1;
    }
  }

  const analyticVolume = sampleReliefVolume(field, 360);
  const areaRatios = partData.map((part) => part.planArea / totalPlanArea) as [
    number,
    number,
    number,
  ];
  const validation: ValidationReport = {
    originalVolume,
    volumeSum,
    volumeDifference: volumeSum - originalVolume,
    volumeDifferencePercent:
      Math.abs(originalVolume) > 1e-9
        ? ((volumeSum - originalVolume) / originalVolume) * 100
        : 0,
    analyticVolume,
    analyticDifference: originalVolume - analyticVolume,
    overlapArea: 0,
    uncoveredArea: 0,
    totalPlanArea,
    topMaxDeviation,
    topRmsDeviation:
      sampleCount > 0 ? Math.sqrt(topSquaredDeviation / sampleCount) : 0,
    minSurfaceHeight,
    maxSurfaceHeight,
    closed: boundaryEdgeCounts.every((count) => count > 0),
    bottomFlat: minSurfaceHeight > 0,
    surfaceIslandCounts: connectorSystem.surfaceIslandCounts,
    stemCounts: connectorSystem.stemCounts,
    partConnected: connectorSystem.partConnected,
    plateConnected: connectorSystem.parts.map((part) => part.plateConnected) as [
      boolean,
      boolean,
      boolean,
    ],
    connectorVolume: connectorSystem.totalVolume,
    totalPrintVolume: volumeSum + connectorSystem.totalVolume,
    volumeExclusive: connectorSystem.volumeExclusive,
    volumeOverlap: connectorSystem.volumeOverlap,
    baseColour: connectorSystem.baseColour,
    areaRatios,
    targetRatios: pattern.params.ratios as [number, number, number],
    sampleCount,
  };

  return {
    parts: partData,
    pattern,
    field,
    grid: {
      cellsX: nx,
      cellsY: ny,
      dx,
      dy,
      cellColors,
    },
    validation,
    layerOrder: connectorSystem.layerOrder,
    stats: {
      cells,
      triangles:
        partData.reduce((sum, part) => sum + part.triangleCount, 0) +
        connectorSystem.parts.reduce(
          (sum, part) => sum + part.positions.length / 9,
          0,
        ),
      siteCount: pattern.sites.length,
    },
  };
}

/**
 * Builds flat, per-colour cap surfaces at a Y section. The solid meshes are
 * clipped with a plane at the same location so the section reads as a real cut.
 */
export function buildSectionCaps(
  pattern: TricolorPattern,
  sectionY: number,
  field: ReliefField,
  resolution = 0.32,
): SectionCapsData {
  const positions: number[][] = [[], [], []];
  const normals: number[][] = [[], [], []];
  const lines: number[][] = [[], [], []];
  const capY = sectionY + 0.012;
  const normalY = -1;
  const capZOffset = 0.01;

  const xStart = -HALF_W;
  let previousColor = pattern.classify(xStart + resolution * 0.5, sectionY);
  let previousX = xStart;

  const addCapQuad = (
    color: ColorIndex,
    x0: number,
    x1: number,
    z0: number,
    z1: number,
  ): void => {
    const pos = positions[color];
    const nor = normals[color];
    pos.push(
      x0, capY, 0,
      x1, capY, 0,
      x1, capY, z1,
      x0, capY, 0,
      x1, capY, z1,
      x0, capY, z0,
    );
    for (let index = 0; index < 6; index += 1) nor.push(0, normalY, 0);
    const line = lines[color];
    line.push(
      x0, capY - 0.005, z0 + capZOffset,
      x1, capY - 0.005, z1 + capZOffset,
    );
  };

  for (let x = xStart + resolution; x <= HALF_W + 1e-6; x += resolution) {
    const clampedX = Math.min(HALF_W, x);
    const midX = (previousX + clampedX) / 2;
    const color = pattern.classify(midX, sectionY);
    const z0 = field.height(previousX, sectionY);
    const z1 = field.height(clampedX, sectionY);
    addCapQuad(color, previousX, clampedX, z0, z1);

    if (color !== previousColor) {
      lines[color].push(
        previousX,
        capY - 0.005,
        0,
        previousX,
        capY - 0.005,
        z0 + capZOffset,
      );
      lines[previousColor].push(
        previousX,
        capY - 0.005,
        0,
        previousX,
        capY - 0.005,
        z0 + capZOffset,
      );
    }
    previousColor = color;
    previousX = clampedX;
  }

  const endColor = pattern.classify(HALF_W - 0.001, sectionY);
  const lastZ = field.height(HALF_W, sectionY);
  lines[endColor].push(
    HALF_W,
    capY - 0.005,
    0,
    HALF_W,
    capY - 0.005,
    lastZ + capZOffset,
  );

  return {
    parts: [0, 1, 2].map((color) => ({
      positions: new Float32Array(positions[color]),
      normals: new Float32Array(normals[color]),
      linePositions: new Float32Array(lines[color]),
    })),
  };
}

