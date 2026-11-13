import { PART_STYLES, type ColorIndex } from './config';


function nearestColor(
  red: number,
  green: number,
  blue: number,
): ColorIndex {
  let bestIndex: ColorIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < 3; index += 1) {
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

function boxBlur(
  source: Float32Array,
  width: number,
  height: number,
  radius: number,
): Float32Array {
  const horizontal = new Float32Array(source.length);
  const result = new Float32Array(source.length);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      let sum = 0;
      let count = 0;
      for (let dx = -radius; dx <= radius; dx += 1) {
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
      for (let dy = -radius; dy <= radius; dy += 1) {
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
 * Derive a smooth depth image from the CURRENT three-colour input.
 *
 * The three material roles are treated as three broad height bands:
 * top = low background, middle = raised, bottom = highest. A wide blur turns
 * the dot structure into a continuous relief while preserving the artwork's
 * large forms. No old/static depth asset is involved.
 */
export function deriveDepthFromColor(
  imageData: ImageData,
  layerColors: readonly [ColorIndex, ColorIndex, ColorIndex],
): ImageData {
  const width = imageData.width;
  const height = imageData.height;
  const values = new Float32Array(width * height);
  const [topColor, middleColor, bottomColor] = layerColors;
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    const color = nearestColor(
      imageData.data[offset],
      imageData.data[offset + 1],
      imageData.data[offset + 2],
    );
    values[index] =
      color === topColor
        ? 0.12
        : color === middleColor
          ? 0.58
          : color === bottomColor
            ? 0.96
            : 0.12;
  }

  const radius = Math.max(4, Math.round(Math.min(width, height) * 0.025));
  let blurred = boxBlur(values, width, height, radius);
  blurred = boxBlur(blurred, width, height, Math.max(2, Math.round(radius * 0.6)));
  blurred = boxBlur(blurred, width, height, Math.max(1, Math.round(radius * 0.35)));

  let minValue = Number.POSITIVE_INFINITY;
  let maxValue = Number.NEGATIVE_INFINITY;
  for (const value of blurred) {
    minValue = Math.min(minValue, value);
    maxValue = Math.max(maxValue, value);
  }
  const range = Math.max(1e-6, maxValue - minValue);
  const output = new ImageData(width, height);
  for (let index = 0; index < blurred.length; index += 1) {
    const normalized = (blurred[index] - minValue) / range;
    const byte = Math.max(0, Math.min(255, Math.round(normalized * 255)));
    const offset = index * 4;
    output.data[offset] = byte;
    output.data[offset + 1] = byte;
    output.data[offset + 2] = byte;
    output.data[offset + 3] = 255;
  }
  return output;
}
