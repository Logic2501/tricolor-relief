import { RELIEF_DEPTH, RELIEF_WIDTH } from './config';

export interface ImageCoordinate {
  u: number;
  v: number;
}

/**
 * Map a model coordinate onto a source image with "cover" semantics: the
 * image keeps its original aspect ratio and is centre-cropped rather than
 * stretched to the relief footprint.
 */
export function modelToImageCover(
  x: number,
  y: number,
  imageWidth: number,
  imageHeight: number,
): ImageCoordinate {
  const modelAspect = RELIEF_WIDTH / RELIEF_DEPTH;
  const imageAspect = imageWidth / imageHeight;

  let u = (x + RELIEF_WIDTH / 2) / RELIEF_WIDTH;
  let v = (RELIEF_DEPTH / 2 - y) / RELIEF_DEPTH;

  if (imageAspect > modelAspect) {
    const visibleWidth = modelAspect / imageAspect;
    u = 0.5 + (u - 0.5) * visibleWidth;
  } else if (imageAspect < modelAspect) {
    const visibleHeight = imageAspect / modelAspect;
    v = 0.5 + (v - 0.5) * visibleHeight;
  }

  return { u, v };
}

export function sampleImagePixel(
  imageData: ImageData,
  u: number,
  v: number,
): readonly [number, number, number] {
  const width = imageData.width;
  const height = imageData.height;
  const column = Math.max(0, Math.min(width - 1, Math.round(u * (width - 1))));
  const row = Math.max(0, Math.min(height - 1, Math.round(v * (height - 1))));
  const offset = (row * width + column) * 4;
  return [
    imageData.data[offset],
    imageData.data[offset + 1],
    imageData.data[offset + 2],
  ];
}
