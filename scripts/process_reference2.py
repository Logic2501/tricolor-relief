#!/usr/bin/env python3
"""Crop 参考2.jpeg, sample three colours from the cropped RGB data, and make
a full-resolution strict three-colour image plus a luminance-derived depth."""
from __future__ import annotations

import json
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "参考2.jpeg"
OUT = ROOT / "reference2"
OUT.mkdir(exist_ok=True)

# Non-white print bounds measured from the 1600 x 1600 source. This removes the
# outer white paper border and keeps the complete printed artwork.
CROP = (367, 231, 1208, 1413)


def kmeans(x: np.ndarray, k: int = 3, seeds: int = 8) -> tuple[np.ndarray, float]:
    rng = np.random.default_rng(20261113)
    best_centers: np.ndarray | None = None
    best_inertia = float("inf")
    for _ in range(seeds):
        centers = [x[rng.integers(0, len(x))]]
        for _ in range(1, k):
            d = ((x[:, None, :] - np.asarray(centers)[None, :, :]) ** 2).sum(axis=2)
            nearest = d.min(axis=1)
            if nearest.sum() <= 0:
                centers.append(x[rng.integers(0, len(x))])
            else:
                centers.append(
                    x[rng.choice(len(x), p=nearest / nearest.sum())]
                )
        c = np.asarray(centers, dtype=np.float32)
        labels = np.zeros(len(x), dtype=np.int32)
        for _ in range(50):
            d = ((x[:, None, :] - c[None, :, :]) ** 2).sum(axis=2)
            labels = d.argmin(axis=1)
            new = np.array(
                [
                    x[labels == i].mean(axis=0) if np.any(labels == i) else c[i]
                    for i in range(k)
                ],
                dtype=np.float32,
            )
            if np.allclose(new, c, atol=1e-3):
                break
            c = new
        inertia = float(((x - c[labels]) ** 2).sum())
        if inertia < best_inertia:
            best_inertia = inertia
            best_centers = c
    assert best_centers is not None
    return best_centers, best_inertia


def main() -> None:
    original = Image.open(SOURCE).convert("RGB")
    original.save(OUT / "reference2-original.jpeg", quality=95)

    crop = original.crop(CROP)
    filtered = crop.filter(ImageFilter.MedianFilter(3))
    crop.save(OUT / "reference2-cropped.png")
    filtered.save(OUT / "reference2-cropped-filtered.png")

    full = np.asarray(filtered).reshape(-1, 3).astype(np.float32)
    sample = full[::3]
    centers, inertia = kmeans(sample)
    # Stable ordering: warm/light, blue, yellow? Keep k-means order but report.
    distance = ((full[:, None, :] - centers[None, :, :]) ** 2).sum(axis=2)
    labels = distance.argmin(axis=1)
    indexed = labels.reshape(crop.height, crop.width).astype(np.uint8)
    quantized = centers[labels].reshape(crop.height, crop.width, 3).astype(np.uint8)
    Image.fromarray(quantized).save(OUT / "reference2-threecolor-flat.png")

    # Edge-aware pass guided by the grayscale/depth image. Pixels on strong
    # luminance edges are painted with the darkest palette ink, restoring the
    # contours that a flat 3-colour posterisation loses (pale object on pale
    # paper, bottle outline, thin stems, fruit segment lines, ...).
    gray = np.asarray(crop.convert("L"), dtype=np.float32)
    grad_x = np.abs(np.diff(gray, axis=1, prepend=gray[:, :1]))
    grad_y = np.abs(np.diff(gray, axis=0, prepend=gray[:1, :]))
    gradient = grad_x + grad_y
    edge_threshold = 40.0
    edge_mask = gradient > edge_threshold
    darkest = int(np.argmin(centers.sum(axis=1)))
    quantized = quantized.copy()
    quantized[edge_mask] = centers[darkest].astype(np.uint8)
    Image.fromarray(quantized).save(OUT / "reference2-threecolor.png")
    np.save(OUT / "reference2-threecolor-index.npy", indexed)

    # Full-resolution luminance depth map. This is a relief proxy, not a real
    # geometric depth: bright ink/paper is high, dark blue is low.
    gray = np.asarray(crop.convert("L"), dtype=np.float32)
    gray = np.asarray(
        Image.fromarray(gray.astype(np.uint8)).filter(ImageFilter.MedianFilter(3)),
        dtype=np.float32,
    )
    lo, hi = np.percentile(gray, (1.0, 99.0))
    depth = np.clip((gray - lo) / max(1.0, hi - lo), 0.0, 1.0)
    depth = (depth * 255.0).round().astype(np.uint8)
    Image.fromarray(depth).save(OUT / "reference2-depth.png")

    palette = [
        {
            "rgb": [int(round(v)) for v in c],
            "hex": "#" + "".join(f"{int(round(v)):02x}" for v in c),
            "pixels": int((labels == i).sum()),
        }
        for i, c in enumerate(centers)
    ]
    unique = np.unique(quantized.reshape(-1, 3), axis=0)
    assert len(unique) == 3, f"expected exactly 3 colours, got {len(unique)}"
    meta = {
        "source": SOURCE.name,
        "source_size": list(original.size),
        "crop_bbox_ltrb": list(CROP),
        "cropped_size": list(crop.size),
        "threecolor_size": list(crop.size),
        "palette": palette,
        "unique_rgb_count": int(len(unique)),
        "kmeans_inertia": inertia,
        "edge_aware": {
            "source": "cropped luminance / depth",
            "threshold": edge_threshold,
            "edge_fraction": float(edge_mask.mean()),
            "edge_ink": "darkest palette colour",
        },
        "depth": {
            "file": "reference2-depth.png",
            "kind": "luminance-derived pseudo depth",
            "size": list(crop.size),
            "range": "0..255",
        },
    }
    (OUT / "metadata.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2) + "\n"
    )
    readme = f"""# 参考2 处理包

- 原图：`reference2-original.jpeg`（1600 × 1600）
- 裁白边：`reference2-cropped.png`（{crop.width} × {crop.height}）
- 裁切框（左/上/右/下）：{CROP}
- 严格三色：`reference2-threecolor.png`，原裁切分辨率 {crop.width} × {crop.height}
  - 唯一 RGB 数：只有 3 个，已校验
  - 三种颜色由裁切图 RGB 直接做 k-means（k=3）采样得到：
    {json.dumps(palette, ensure_ascii=False)}
- 派生深度：`reference2-depth.png`，{crop.width} × {crop.height}
  - 由裁切图亮度生成（中值滤波 + 1–99% 归一化），是浅浮雕代理，不是真实几何深度。

三色图不是从原有品红/青色通道推导，而是直接对裁切图 RGB 聚类后再逐像素映射。
"""
    (OUT / "README.md").write_text(readme)

    zip_path = OUT / "reference2-package.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in [
            "reference2-original.jpeg",
            "reference2-cropped.png",
            "reference2-cropped-filtered.png",
            "reference2-threecolor.png",
            "reference2-threecolor-flat.png",
            "reference2-threecolor-index.npy",
            "reference2-depth.png",
            "metadata.json",
            "README.md",
        ]:
            zf.write(OUT / name, arcname=name)
    print(json.dumps(meta, ensure_ascii=False, indent=2))
    print(f"wrote {zip_path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
