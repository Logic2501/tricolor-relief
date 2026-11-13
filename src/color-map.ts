import {
  GRID_CELLS_X,
  GRID_CELLS_Y,
  PART_STYLES,
  RELIEF_DEPTH,
  RELIEF_WIDTH,
  type ColorIndex,
} from './config';
import { modelToImageCover } from './image-mapping';


export interface LatticeSettings {
  /** Desired distance between sampled points, in millimetres. */
  pitchMm: number;
  /** Colour of the top negative; source samples of this colour become gaps. */
  topColor: ColorIndex;
}

export interface LatticeResult {
  cellColors: Uint8Array;
  actualPitchMm: number;
  dotRadiusMm: number;
  dotCounts: [number, number, number];
}

function nearestPaletteColour(
  red: number,
  green: number,
  blue: number,
): ColorIndex {
  let bestIndex: ColorIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < PART_STYLES.length; index += 1) {
    const palette = PART_STYLES[index].rgb;
    const dr = red - palette[0];
    const dg = green - palette[1];
    const db = blue - palette[2];
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index as ColorIndex;
    }
  }
  return bestIndex;
}

function sampleLatticeColour(
  imageData: ImageData,
  u: number,
  v: number,
): ColorIndex {
  const width = imageData.width;
  const height = imageData.height;
  const centerColumn = Math.max(0, Math.min(width - 1, Math.round(u * (width - 1))));
  const centerRow = Math.max(0, Math.min(height - 1, Math.round(v * (height - 1))));
  const counts = [0, 0, 0];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const column = Math.max(0, Math.min(width - 1, centerColumn + dx));
      const row = Math.max(0, Math.min(height - 1, centerRow + dy));
      const offset = (row * width + column) * 4;
      counts[
        nearestPaletteColour(
          imageData.data[offset],
          imageData.data[offset + 1],
          imageData.data[offset + 2],
        )
      ] += 1;
    }
  }
  let bestIndex: ColorIndex = 0;
  let bestCount = counts[0];
  for (let index = 1; index < 3; index += 1) {
    if (counts[index] > bestCount) {
      bestCount = counts[index];
      bestIndex = index as ColorIndex;
    }
  }
  return bestIndex;
}

/**
 * Convert the source artwork into a coordinate lattice of round dots.
 *
 * A dot is rasterised with a circular test, not as a square block. The radius
 * is chosen so that adjacent dots always keep a one-cell top-colour gap.
 */
export function colorImageToLattice(
  imageData: ImageData,
  settings: LatticeSettings,
): LatticeResult {
  const cellW = RELIEF_WIDTH / GRID_CELLS_X;
  const cellD = RELIEF_DEPTH / GRID_CELLS_Y;
  const halfW = RELIEF_WIDTH / 2;
  const halfD = RELIEF_DEPTH / 2;
  const stepCells = Math.max(
    1,
    Math.round(settings.pitchMm / Math.min(cellW, cellD)),
  );
  const actualPitchMm = stepCells * Math.min(cellW, cellD);
  // At least one raster cell of top-colour gap between neighbouring dots.
  const dotRadiusMm = Math.min(
    actualPitchMm / 2 - Math.min(cellW, cellD) * 0.5,
    actualPitchMm * 0.36,
  );
  const radiusSquared = dotRadiusMm * dotRadiusMm;
  const cellColors = new Uint8Array(GRID_CELLS_X * GRID_CELLS_Y).fill(
    settings.topColor,
  );
  const dotCounts: [number, number, number] = [0, 0, 0];
  const seenDots = new Uint8Array(GRID_CELLS_X * GRID_CELLS_Y);

  for (let row = 0; row < GRID_CELLS_Y; row += stepCells) {
    for (let column = 0; column < GRID_CELLS_X; column += stepCells) {
      const x = -halfW + (column + 0.5) * cellW;
      const y = -halfD + (row + 0.5) * cellD;
      const { u, v } = modelToImageCover(
        x,
        y,
        imageData.width,
        imageData.height,
      );
      const colour = sampleLatticeColour(imageData, u, v);
      if (colour === settings.topColor) continue;

      let painted = false;
      const cellRadius = Math.ceil(dotRadiusMm / Math.min(cellW, cellD));
      for (let dy = -cellRadius; dy <= cellRadius; dy += 1) {
        const targetRow = row + dy;
        if (targetRow < 0 || targetRow >= GRID_CELLS_Y) continue;
        for (let dx = -cellRadius; dx <= cellRadius; dx += 1) {
          const targetColumn = column + dx;
          if (targetColumn < 0 || targetColumn >= GRID_CELLS_X) continue;
          const px = dx * cellW;
          const py = dy * cellD;
          if (px * px + py * py > radiusSquared) continue;
          cellColors[targetRow * GRID_CELLS_X + targetColumn] = colour;
          painted = true;
        }
      }
      // The sample cell is always part of the dot.
      if (!painted) {
        cellColors[row * GRID_CELLS_X + column] = colour;
      }
      const sampleIndex = row * GRID_CELLS_X + column;
      if (!seenDots[sampleIndex]) {
        // Count lattice dots once; cells are not counted per raster cell.
        seenDots[sampleIndex] = 1;
        dotCounts[colour] += 1;
      }
    }
  }

  return {
    cellColors,
    actualPitchMm,
    dotRadiusMm,
    dotCounts,
  };
}

// Kept for callers that use the plain map; the default top colour is yellow.
export function colorImageToCellMap(imageData: ImageData): Uint8Array {
  return colorImageToLattice(imageData, {
    pitchMm: 1.5,
    topColor: 0,
  }).cellColors;
}

function componentLabels(
  predicate: (index: number) => boolean,
): { labels: Int32Array; components: number[][] } {
  const labels = new Int32Array(GRID_CELLS_X * GRID_CELLS_Y).fill(-1);
  const components: number[][] = [];
  const stack: number[] = [];
  for (let start = 0; start < labels.length; start += 1) {
    if (labels[start] !== -1 || !predicate(start)) continue;
    const id = components.length;
    const component: number[] = [];
    labels[start] = id;
    stack.push(start);
    while (stack.length > 0) {
      const index = stack.pop() as number;
      component.push(index);
      const column = index % GRID_CELLS_X;
      const row = Math.floor(index / GRID_CELLS_X);
      const visit = (neighbour: number): void => {
        if (labels[neighbour] === -1 && predicate(neighbour)) {
          labels[neighbour] = id;
          stack.push(neighbour);
        }
      };
      if (column > 0) visit(index - 1);
      if (column + 1 < GRID_CELLS_X) visit(index + 1);
      if (row > 0) visit(index - GRID_CELLS_X);
      if (row + 1 < GRID_CELLS_Y) visit(index + GRID_CELLS_X);
    }
    components.push(component);
  }
  return { labels, components };
}

/** Bridge disconnected support/negative components with the shortest cell
 * path. This is the experimental alternative to dotting every colour block. */
function bridgeComponents(
  cellColors: Uint8Array,
  predicate: (index: number) => boolean,
  paintColor: ColorIndex,
): number {
  let painted = 0;
  for (let pass = 0; pass < 8; pass += 1) {
    const { components } = componentLabels(predicate);
    if (components.length <= 1) break;
    components.sort((a, b) => b.length - a.length);
    const main = new Set(components[0]);
    for (let componentIndex = 1; componentIndex < components.length; componentIndex += 1) {
      const startCells = components[componentIndex];
      const previous = new Int32Array(cellColors.length).fill(-1);
      const seen = new Uint8Array(cellColors.length);
      const queue = [...startCells];
      for (const cell of startCells) seen[cell] = 1;
      let target = -1;
      let cursor = 0;
      while (cursor < queue.length && target === -1) {
        const index = queue[cursor];
        cursor += 1;
        if (main.has(index) && !startCells.includes(index)) {
          target = index;
          break;
        }
        const column = index % GRID_CELLS_X;
        const row = Math.floor(index / GRID_CELLS_X);
        const neighbours = [
          column > 0 ? index - 1 : -1,
          column + 1 < GRID_CELLS_X ? index + 1 : -1,
          row > 0 ? index - GRID_CELLS_X : -1,
          row + 1 < GRID_CELLS_Y ? index + GRID_CELLS_X : -1,
        ];
        for (const neighbour of neighbours) {
          if (neighbour < 0 || seen[neighbour]) continue;
          seen[neighbour] = 1;
          previous[neighbour] = index;
          if (main.has(neighbour)) {
            target = neighbour;
            break;
          }
          queue.push(neighbour);
        }
      }
      if (target === -1) continue;
      let cursorCell = target;
      while (cursorCell !== -1) {
        if (!main.has(cursorCell)) {
          cellColors[cursorCell] = paintColor;
          painted += 1;
        }
        cursorCell = previous[cursorCell];
      }
    }
  }
  return painted;
}

/**
 * Experimental continuous-block map: every geometry cell takes the nearest
 * sampled source colour. Large colour blocks stay connected. If the top
 * negative or the middle support becomes disconnected, the shortest paths are
 * filled with that layer colour so the parts remain printable.
 */
export function colorImageToContinuousMap(
  imageData: ImageData,
  layerColors: readonly [ColorIndex, ColorIndex, ColorIndex],
): { cellColors: Uint8Array; bridges: number } {
  const [topColor, middleColor, bottomColor] = layerColors;
  const cellColors = new Uint8Array(GRID_CELLS_X * GRID_CELLS_Y);
  const cellW = RELIEF_WIDTH / GRID_CELLS_X;
  const cellD = RELIEF_DEPTH / GRID_CELLS_Y;
  const halfW = RELIEF_WIDTH / 2;
  const halfD = RELIEF_DEPTH / 2;
  for (let row = 0; row < GRID_CELLS_Y; row += 1) {
    for (let column = 0; column < GRID_CELLS_X; column += 1) {
      const x = -halfW + (column + 0.5) * cellW;
      const y = -halfD + (row + 0.5) * cellD;
      const { u, v } = modelToImageCover(x, y, imageData.width, imageData.height);
      cellColors[row * GRID_CELLS_X + column] = sampleLatticeColour(imageData, u, v);
    }
  }

  let bridges = bridgeComponents(
    cellColors,
    (index) => cellColors[index] === topColor,
    topColor,
  );
  bridges += bridgeComponents(
    cellColors,
    (index) => cellColors[index] !== bottomColor,
    middleColor,
  );
  return { cellColors, bridges };
}
