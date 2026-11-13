type RGB = [number, number, number];

interface ColorCount {
  rgb: RGB;
  count: number;
}

function luminance(rgb: RGB): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function sortByLight(rgb: RGB[]): [RGB, RGB, RGB] {
  return [...rgb].sort((a, b) => luminance(b) - luminance(a)) as [
    RGB,
    RGB,
    RGB,
  ];
}

function kmeans3(pixels: RGB[]): [RGB, RGB, RGB] {
  // Deterministic k-means++ initialisation from the sampled original pixels.
  const sorted = [...pixels].sort((a, b) => luminance(a) - luminance(b));
  const centers: RGB[] = [
    sorted[Math.floor(sorted.length * 0.2)],
    sorted[Math.floor(sorted.length * 0.55)],
    sorted[Math.floor(sorted.length * 0.85)],
  ];
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const sums = [
      [0, 0, 0, 0],
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ];
    for (const pixel of pixels) {
      let best = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < 3; index += 1) {
        const dr = pixel[0] - centers[index][0];
        const dg = pixel[1] - centers[index][1];
        const db = pixel[2] - centers[index][2];
        const distance = dr * dr + dg * dg + db * db;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = index;
        }
      }
      sums[best][0] += pixel[0];
      sums[best][1] += pixel[1];
      sums[best][2] += pixel[2];
      sums[best][3] += 1;
    }
    for (let index = 0; index < 3; index += 1) {
      if (sums[index][3] > 0) {
        centers[index] = [
          Math.round(sums[index][0] / sums[index][3]),
          Math.round(sums[index][1] / sums[index][3]),
          Math.round(sums[index][2] / sums[index][3]),
        ];
      }
    }
  }
  return sortByLight(centers);
}

/**
 * Sample three representative RGB colours from the CURRENT image.
 *
 * A strict three-colour source (like the packaged reference2-threecolor.png)
 * is read exactly. A many-colour source is clustered with k=3; no fixed ink
 * names/channels are assumed. Result is ordered light -> dark so index 0 is
 * the natural top/background ink.
 */
export function extractPalette(
  imageData: ImageData,
): [RGB, RGB, RGB] | null {
  const data = imageData.data;
  const pixelCount = imageData.width * imageData.height;
  const exact = new Map<number, ColorCount>();
  const samples: RGB[] = [];
  const step = Math.max(1, Math.round(Math.sqrt(pixelCount / 24000)));

  for (let index = 0; index < pixelCount; index += step) {
    const offset = index * 4;
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    const key = (red << 16) | (green << 8) | blue;
    const entry = exact.get(key);
    if (entry) entry.count += 1;
    else exact.set(key, { rgb: [red, green, blue], count: 1 });
    samples.push([red, green, blue]);
  }

  if (exact.size <= 12) {
    const top = [...exact.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
    if (top.length === 3) {
      return sortByLight(top.map((item) => item.rgb));
    }
  }

  if (samples.length < 3) return null;
  return kmeans3(samples);
}

export function colorNameForRgb(rgb: RGB): string {
  const [red, green, blue] = rgb;
  const max = Math.max(red, green, blue) / 255;
  const min = Math.min(red, green, blue) / 255;
  const delta = max - min;
  const saturation = max <= 1e-6 ? 0 : delta / max;
  let hue = 0;
  if (delta > 1e-6) {
    const r = red / 255;
    const g = green / 255;
    const b = blue / 255;
    if (max === r) hue = 60 * (((g - b) / delta) % 6);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
  }
  if (hue < 0) hue += 360;

  if (saturation < 0.2 && max > 0.55) return '奶油';
  if (hue >= 35 && hue < 70) return '黄';
  if (hue >= 70 && hue < 155) return '绿';
  if (hue >= 155 && hue < 220) return '蓝';
  if (hue >= 285 || hue < 8) return '品红';
  if (hue >= 8 && hue < 35) return '橙';
  return '浅色';
}
