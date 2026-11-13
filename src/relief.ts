import { RELIEF_DEPTH, RELIEF_WIDTH } from './config';
import { modelToImageCover } from './image-mapping';

let HALF_W = RELIEF_WIDTH / 2;
let HALF_D = RELIEF_DEPTH / 2;

function refreshLayout(): void {
  HALF_W = RELIEF_WIDTH / 2;
  HALF_D = RELIEF_DEPTH / 2;
}
const MIN_HEIGHT = 1;
const MAX_HEIGHT = 7;

export interface ReliefField {
  kind: 'builtin' | 'depth-map';
  name: string;
  height: (x: number, y: number) => number;
  normal: (
    x: number,
    y: number,
    epsilon?: number,
  ) => readonly [number, number, number];
  minHeight: number;
  maxHeight: number;
  sourceWidth?: number;
  sourceHeight?: number;
}

function normalFromHeight(
  height: (x: number, y: number) => number,
  x: number,
  y: number,
  epsilon = 0.08,
): readonly [number, number, number] {
  const dx =
    (height(x + epsilon, y) - height(x - epsilon, y)) / (2 * epsilon);
  const dy =
    (height(x, y + epsilon) - height(x, y - epsilon)) / (2 * epsilon);
  const inverseLength = 1 / Math.hypot(dx, dy, 1);
  return [-dx * inverseLength, -dy * inverseLength, inverseLength];
}

interface Blob {
  cx: number;
  cy: number;
  sx: number;
  sy: number;
  rotation: number;
  amplitude: number;
}

const BLOBS: Blob[] = [
  { cx: -18, cy: 5, sx: 23, sy: 25, rotation: -0.3, amplitude: 10.8 },
  { cx: 25, cy: -11, sx: 19, sy: 22, rotation: 0.55, amplitude: 8.2 },
  { cx: 1, cy: 25, sx: 12, sy: 12, rotation: 0.1, amplitude: 5.5 },
  { cx: -35, cy: -24, sx: 12, sy: 15, rotation: 0.2, amplitude: 4.8 },
  { cx: 42, cy: 21, sx: 15, sy: 11, rotation: -0.42, amplitude: 3.8 },
  { cx: 11, cy: 1, sx: 36, sy: 30, rotation: -0.12, amplitude: 3.2 },
];

const gaussian = (x: number, y: number, blob: Blob): number => {
  const dx = x - blob.cx;
  const dy = y - blob.cy;
  const cos = Math.cos(blob.rotation);
  const sin = Math.sin(blob.rotation);
  const rx = cos * dx + sin * dy;
  const ry = -sin * dx + cos * dy;
  return (
    blob.amplitude *
    Math.exp(-0.5 * ((rx / blob.sx) ** 2 + (ry / blob.sy) ** 2))
  );
};

/** Smooth analytic relief height in millimetres. */
export function reliefHeight(x: number, y: number): number {
  const u = x / HALF_W;
  const v = y / HALF_D;

  let height = 2.15;
  for (const blob of BLOBS) height += gaussian(x, y, blob);

  const ridgeY = 12 * Math.sin(u * 2.1 + 0.55) + 4 * Math.cos(u * 4.2 - 0.4);
  height +=
    4.15 *
    Math.exp(-0.5 * ((y - ridgeY) / 8.2) ** 2) *
    (0.55 + 0.45 * Math.cos(u * 2.6 + 0.8));

  height += 0.85 * Math.sin(u * 5.4 + 0.8) * Math.cos(v * 4.6 - 0.3);
  height += 0.35 * Math.sin(u * 11.3 - v * 7.1);

  return Math.max(1.6, height);
}

export function createBuiltinRelief(): ReliefField {
  refreshLayout();
  return {
    kind: 'builtin',
    name: '内置起伏',
    height: reliefHeight,
    normal: (x, y, epsilon = 0.08) =>
      normalFromHeight(reliefHeight, x, y, epsilon),
    minHeight: 1.6,
    maxHeight: 23.5,
  };
}

function bilinear(
  data: Float32Array,
  width: number,
  height: number,
  u: number,
  v: number,
): number {
  const x = Math.max(0, Math.min(width - 1, u * (width - 1)));
  const y = Math.max(0, Math.min(height - 1, v * (height - 1)));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = data[y0 * width + x0];
  const b = data[y0 * width + x1];
  const c = data[y1 * width + x0];
  const d = data[y1 * width + x1];
  return (
    a * (1 - fx) * (1 - fy) +
    b * fx * (1 - fy) +
    c * (1 - fx) * fy +
    d * fx * fy
  );
}

function boxBlur(
  source: Float32Array,
  width: number,
  height: number,
): Float32Array {
  const horizontal = new Float32Array(source.length);
  const result = new Float32Array(source.length);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      let sum = 0;
      let count = 0;
      for (let dx = -1; dx <= 1; dx += 1) {
        const x = column + dx;
        if (x < 0 || x >= width) continue;
        sum += source[row * width + x];
        count += 1;
      }
      horizontal[row * width + column] = sum / count;
    }
  }
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        const y = row + dy;
        if (y < 0 || y >= height) continue;
        sum += horizontal[y * width + column];
        count += 1;
      }
      result[row * width + column] = sum / count;
    }
  }
  return result;
}

/**
 * Turns a flattened luminance map (row 0 = image top) into a height field.
 * The map is stretched to the 120 × 80 mm relief footprint. Black is the
 * lowest point and white is the highest.
 */
export function createDepthMapRelief(
  imageData: ImageData,
  name: string,
  options: {
    smoothingPasses?: number;
    depthRange?: number;
    invert?: boolean;
  } = {},
): ReliefField {
  refreshLayout();
  const width = imageData.width;
  const height = imageData.height;
  const pixels = imageData.data;
  const values = new Float32Array(width * height);
  let minValue = Number.POSITIVE_INFINITY;
  let maxValue = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    const alpha = pixels[offset + 3] / 255;
    const luminance =
      (0.2126 * pixels[offset] +
        0.7152 * pixels[offset + 1] +
        0.0722 * pixels[offset + 2]) /
      255;
    const value = luminance * alpha;
    values[index] = value;
    minValue = Math.min(minValue, value);
    maxValue = Math.max(maxValue, value);
  }

  let range = Math.max(1e-5, maxValue - minValue);
  for (let index = 0; index < values.length; index += 1) {
    values[index] = (values[index] - minValue) / range;
  }

  // A configurable blur suppresses shading noise. Set the UI control to 0 to
  // preserve sharp object edges for edge-heavy references.
  const passes = Math.max(
    0,
    Math.min(8, Math.round(options.smoothingPasses ?? 2)),
  );
  let blurred = new Float32Array(values);
  for (let pass = 0; pass < passes; pass += 1) {
    blurred = new Float32Array(boxBlur(blurred, width, height));
  }
  if (passes > 0) values.set(blurred);
  minValue = 1;
  maxValue = 0;
  for (const value of values) {
    minValue = Math.min(minValue, value);
    maxValue = Math.max(maxValue, value);
  }
  range = Math.max(1e-5, maxValue - minValue);
  for (let index = 0; index < values.length; index += 1) {
    values[index] = (values[index] - minValue) / range;
  }

  const depthRange = Math.max(
    0.5,
    Math.min(20, options.depthRange ?? MAX_HEIGHT),
  );
  const invert = options.invert === true;
  const heightAt = (x: number, y: number): number => {
    const { u, v } = modelToImageCover(x, y, width, height);
    const raw = bilinear(values, width, height, u, v);
    const value = invert ? 1 - raw : raw;
    return MIN_HEIGHT + value * (depthRange - MIN_HEIGHT);
  };

  return {
    kind: 'depth-map',
    name,
    height: heightAt,
    normal: (x, y, epsilon = 0.1) =>
      normalFromHeight(heightAt, x, y, epsilon),
    minHeight: MIN_HEIGHT,
    maxHeight: depthRange,
    sourceWidth: width,
    sourceHeight: height,
  };
}

/** Approximate integrated volume (mm³) using a dense regular sample grid. */
export function sampleReliefVolume(field: ReliefField, samples = 360): number {
  refreshLayout();
  const rows = Math.round((samples * RELIEF_DEPTH) / RELIEF_WIDTH);
  const dx = RELIEF_WIDTH / samples;
  const dy = RELIEF_DEPTH / rows;
  let volume = 0;
  for (let j = 0; j < rows; j += 1) {
    const y = -HALF_D + (j + 0.5) * dy;
    for (let i = 0; i < samples; i += 1) {
      const x = -HALF_W + (i + 0.5) * dx;
      volume += field.height(x, y) * dx * dy;
    }
  }
  return volume;
}
