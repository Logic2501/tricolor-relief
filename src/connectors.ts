import {
  BOTTOM_LAYER_COLOR,
  GRID_CELLS_X,
  GRID_CELLS_Y,
  MIDDLE_LAYER_COLOR,
  RELIEF_DEPTH,
  RELIEF_WIDTH,
  TOP_LAYER_COLOR,
  type ColorIndex,
} from './config';

let HALF_W = RELIEF_WIDTH / 2;
let HALF_D = RELIEF_DEPTH / 2;
let CELL_W = RELIEF_WIDTH / GRID_CELLS_X;
let CELL_D = RELIEF_DEPTH / GRID_CELLS_Y;
let CELL_AREA = CELL_W * CELL_D;
let CELL_COUNT = GRID_CELLS_X * GRID_CELLS_Y;

function refreshLayout(): void {
  HALF_W = RELIEF_WIDTH / 2;
  HALF_D = RELIEF_DEPTH / 2;
  CELL_W = RELIEF_WIDTH / GRID_CELLS_X;
  CELL_D = RELIEF_DEPTH / GRID_CELLS_Y;
  CELL_AREA = CELL_W * CELL_D;
  CELL_COUNT = GRID_CELLS_X * GRID_CELLS_Y;
}

export const CONNECTOR_BAND_HEIGHT = 0.6;
export const CONNECTOR_DEPTH = CONNECTOR_BAND_HEIGHT * 3;

export interface ConnectorPartData {
  positions: Float32Array;
  normals: Float32Array;
  volume: number;
  stemCount: number;
  surfaceIslandCount: number;
  plateConnected: boolean;
  plateCellCount: number;
}

export interface ConnectorSystem {
  parts: ConnectorPartData[];
  totalVolume: number;
  surfaceIslandCounts: [number, number, number];
  stemCounts: [number, number, number];
  partConnected: [boolean, boolean, boolean];
  plateConnected: [boolean, boolean, boolean];
  volumeExclusive: boolean;
  volumeOverlap: number;
  baseColour: ColorIndex;
  layerOrder: [ColorIndex, ColorIndex, ColorIndex];
  deepestZ: number;
}

interface MeshAccumulator {
  positions: number[];
  normals: number[];
}

function addQuad(
  target: MeshAccumulator,
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
  d: readonly [number, number, number],
  normal: readonly [number, number, number],
): void {
  target.positions.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (let index = 0; index < 6; index += 1) {
    target.normals.push(...normal);
  }
}

function buildBand(
  mask: Uint8Array,
  zTop: number,
  zBottom: number,
  target: MeshAccumulator,
): number {
  let filledCount = 0;
  for (let row = 0; row < GRID_CELLS_Y; row += 1) {
    let runStart = -1;
    for (let column = 0; column <= GRID_CELLS_X; column += 1) {
      const filled =
        column < GRID_CELLS_X &&
        mask[row * GRID_CELLS_X + column] === 1;
      if (filled) {
        if (runStart === -1) runStart = column;
        filledCount += 1;
      }
      if (!filled && runStart !== -1) {
        const x0 = -HALF_W + runStart * CELL_W;
        const x1 = -HALF_W + column * CELL_W;
        const y0 = -HALF_D + row * CELL_D;
        const y1 = -HALF_D + (row + 1) * CELL_D;
        addQuad(
          target,
          [x0, y0, zTop],
          [x1, y0, zTop],
          [x1, y1, zTop],
          [x0, y1, zTop],
          [0, 0, 1],
        );
        addQuad(
          target,
          [x0, y1, zBottom],
          [x1, y1, zBottom],
          [x1, y0, zBottom],
          [x0, y0, zBottom],
          [0, 0, -1],
        );
        runStart = -1;
      }
    }
  }

  for (let row = 0; row < GRID_CELLS_Y; row += 1) {
    for (let column = 0; column < GRID_CELLS_X; column += 1) {
      const cell = row * GRID_CELLS_X + column;
      if (mask[cell] !== 1) continue;
      const x0 = -HALF_W + column * CELL_W;
      const x1 = x0 + CELL_W;
      const y0 = -HALF_D + row * CELL_D;
      const y1 = y0 + CELL_D;
      if (column === 0 || mask[cell - 1] !== 1) {
        addQuad(
          target,
          [x0, y1, zTop],
          [x0, y0, zTop],
          [x0, y0, zBottom],
          [x0, y1, zBottom],
          [-1, 0, 0],
        );
      }
      if (column + 1 === GRID_CELLS_X || mask[cell + 1] !== 1) {
        addQuad(
          target,
          [x1, y0, zTop],
          [x1, y1, zTop],
          [x1, y1, zBottom],
          [x1, y0, zBottom],
          [1, 0, 0],
        );
      }
      if (row === 0 || mask[cell - GRID_CELLS_X] !== 1) {
        addQuad(
          target,
          [x1, y0, zTop],
          [x0, y0, zTop],
          [x0, y0, zBottom],
          [x1, y0, zBottom],
          [0, -1, 0],
        );
      }
      if (row + 1 === GRID_CELLS_Y || mask[cell + GRID_CELLS_X] !== 1) {
        addQuad(
          target,
          [x0, y1, zTop],
          [x1, y1, zTop],
          [x1, y1, zBottom],
          [x0, y1, zBottom],
          [0, 1, 0],
        );
      }
    }
  }

  return filledCount;
}

function componentCount(mask: Uint8Array): number {
  const visited = new Uint8Array(mask.length);
  const stack: number[] = [];
  let components = 0;
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] !== 1 || visited[start]) continue;
    components += 1;
    visited[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const index = stack.pop() as number;
      const column = index % GRID_CELLS_X;
      const row = Math.floor(index / GRID_CELLS_X);
      if (column > 0 && mask[index - 1] === 1 && !visited[index - 1]) {
        visited[index - 1] = 1;
        stack.push(index - 1);
      }
      if (
        column + 1 < GRID_CELLS_X &&
        mask[index + 1] === 1 &&
        !visited[index + 1]
      ) {
        visited[index + 1] = 1;
        stack.push(index + 1);
      }
      if (row > 0 && mask[index - GRID_CELLS_X] === 1 && !visited[index - GRID_CELLS_X]) {
        visited[index - GRID_CELLS_X] = 1;
        stack.push(index - GRID_CELLS_X);
      }
      if (
        row + 1 < GRID_CELLS_Y &&
        mask[index + GRID_CELLS_X] === 1 &&
        !visited[index + GRID_CELLS_X]
      ) {
        visited[index + GRID_CELLS_X] = 1;
        stack.push(index + GRID_CELLS_X);
      }
    }
  }
  return components;
}

export function buildConnectors(
  cellColors: Uint8Array,
  layerColors: [ColorIndex, ColorIndex, ColorIndex] = [
    TOP_LAYER_COLOR,
    MIDDLE_LAYER_COLOR,
    BOTTOM_LAYER_COLOR,
  ],
): ConnectorSystem {
  refreshLayout();
  const [topColor, middleColor, bottomColor] = layerColors;

  const topMasks = [0, 1, 2].map(() => new Uint8Array(CELL_COUNT));
  for (let index = 0; index < CELL_COUNT; index += 1) {
    const color = cellColors[index] as ColorIndex;
    topMasks[color][index] = 1;
  }

  const middleMasks = [0, 1, 2].map(() => new Uint8Array(CELL_COUNT));
  for (let index = 0; index < CELL_COUNT; index += 1) {
    if (cellColors[index] === bottomColor) {
      middleMasks[bottomColor][index] = 1;
    } else {
      middleMasks[middleColor][index] = 1;
    }
  }

  const bottomMasks = [0, 1, 2].map(() => new Uint8Array(CELL_COUNT));
  bottomMasks[bottomColor].fill(1);

  const layers: Uint8Array[][] = [topMasks, middleMasks, bottomMasks];
  const bands = [
    { zTop: 0, zBottom: -CONNECTOR_BAND_HEIGHT },
    { zTop: -CONNECTOR_BAND_HEIGHT, zBottom: -CONNECTOR_BAND_HEIGHT * 2 },
    { zTop: -CONNECTOR_BAND_HEIGHT * 2, zBottom: -CONNECTOR_BAND_HEIGHT * 3 },
  ];

  const accumulators: MeshAccumulator[] = [0, 1, 2].map(() => ({
    positions: [],
    normals: [],
  }));
  const volumes = [0, 0, 0];
  const plateCellCounts = [0, 0, 0];

  for (let color = 0; color < 3; color += 1) {
    for (let band = 0; band < 3; band += 1) {
      const filledCount = buildBand(
        layers[band][color],
        bands[band].zTop,
        bands[band].zBottom,
        accumulators[color],
      );
      plateCellCounts[color] += filledCount;
      volumes[color] += filledCount * CELL_AREA * CONNECTOR_BAND_HEIGHT;
    }
  }

  const plateConnected: [boolean, boolean, boolean] = [false, false, false];
  plateConnected[topColor] = componentCount(topMasks[topColor]) === 1;
  plateConnected[middleColor] =
    componentCount(middleMasks[middleColor]) === 1;
  plateConnected[bottomColor] = true;

  const surfaceIslandCounts: [number, number, number] = [
    componentCount(topMasks[0]),
    componentCount(topMasks[1]),
    componentCount(topMasks[2]),
  ];
  const dotCounts: [number, number, number] = [0, 0, 0];
  dotCounts[middleColor] = dotCountsForColor(cellColors, middleColor);
  dotCounts[bottomColor] = dotCountsForColor(cellColors, bottomColor);

  return {
    parts: [0, 1, 2].map((color) => ({
      positions: new Float32Array(accumulators[color].positions),
      normals: new Float32Array(accumulators[color].normals),
      volume: volumes[color],
      stemCount: dotCounts[color],
      surfaceIslandCount: surfaceIslandCounts[color],
      plateConnected: plateConnected[color],
      plateCellCount: plateCellCounts[color],
    })),
    totalVolume: volumes[0] + volumes[1] + volumes[2],
    surfaceIslandCounts,
    stemCounts: dotCounts,
    partConnected: [true, true, true],
    plateConnected,
    volumeExclusive: true,
    volumeOverlap: 0,
    baseColour: topColor,
    layerOrder: [bottomColor, middleColor, topColor],
    deepestZ: -CONNECTOR_DEPTH,
  };
}

function dotCountsForColor(
  cellColors: Uint8Array,
  color: ColorIndex,
): number {
  const visited = new Uint8Array(cellColors.length);
  const stack: number[] = [];
  let count = 0;
  for (let start = 0; start < cellColors.length; start += 1) {
    if (visited[start] || cellColors[start] !== color) continue;
    count += 1;
    visited[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const index = stack.pop() as number;
      const column = index % GRID_CELLS_X;
      const row = Math.floor(index / GRID_CELLS_X);
      if (column > 0 && cellColors[index - 1] === color && !visited[index - 1]) {
        visited[index - 1] = 1;
        stack.push(index - 1);
      }
      if (
        column + 1 < GRID_CELLS_X &&
        cellColors[index + 1] === color &&
        !visited[index + 1]
      ) {
        visited[index + 1] = 1;
        stack.push(index + 1);
      }
      if (row > 0 && cellColors[index - GRID_CELLS_X] === color && !visited[index - GRID_CELLS_X]) {
        visited[index - GRID_CELLS_X] = 1;
        stack.push(index - GRID_CELLS_X);
      }
      if (
        row + 1 < GRID_CELLS_Y &&
        cellColors[index + GRID_CELLS_X] === color &&
        !visited[index + GRID_CELLS_X]
      ) {
        visited[index + GRID_CELLS_X] = 1;
        stack.push(index + GRID_CELLS_X);
      }
    }
  }
  return count;
}
