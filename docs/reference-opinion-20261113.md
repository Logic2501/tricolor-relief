# 参考意见存档 · 2026-11-13

> 用户提供，暂时只存档，不按此执行。当前管线仍保持“三色索引图 + 深度图”
> 与现有圆点阵实现。

## 三色 Risograph / 空间网点参考意见

这个纠正很重要。你需要的不是传统意义上的三色抽象构成，而是**具有明显空间网点结构、在较低采样分辨率下仍能辨认主体和细节的三色图像**。

我撤回前面推荐的《Firebird》：它的色带结构不适合作为我们的主要参考。

### 1. 更合适的真实作品

- Still Life Breakfast Print | Independent Gift Shop Edinburgh
  - https://images.openai.com/static-rsc-4/XA5Zh72_8noEMcsXZ9hQTuBqcqMmQqIow-VjvPVfICEmoh9wW8ls8u5Bi0KyuhKuNQfsuapEdnrTrMsS-1cLBxs1Anc4wGXNZXlVbUPQMsGqvgeg6wGHoa8FJGkJu_f7ESHySbQejzKeuRisp5nac3cXcznm-AVIMvYqtTySIFM
- Three-Colour Risograph Printed Posters 2020 — Caro Negret
  - https://www.behance.net/gallery/96119225/Three-Colour-Risograph-Printed-Posters-2020

这组作品更接近目标：

- 真实的三色 Risograph 印刷作品。
- 水果、花卉等具象主体。
- 使用三种油墨，通过叠印、纹理和渐变网点增加表现力。
- 有明确的颜色限制，而不是普通 RGB 彩色插画。

说明：Risograph 允许油墨叠印，实际印刷结果可能出现综合色；它不是严格意义上每个像素只能取三个颜色之一。可以借鉴其构图和网点表达，但不能直接把它的综合色结果当作目标数据。

### 2. 图像转换工具（建议优先试）

- Orvlyn/Halftone — Spectrolite
  - https://spectrolite.app/how-to
  - https://github.com/Orvlyn/Halftone
  - 三个独立 Tri-ink 颜色通道；点、线、方形、六边形、噪声等 13 种网点风格；
    方形、对角线、六边形、径向网格；可控制色彩、网点尺寸和低分辨率预览。
  - 需要确认导出结果是否存在通道叠印和混色，以及能否得到互斥的三色标签图。
- ditherto
  - https://github.com/vexlin/ditherto
  - 可指定固定调色板；支持 Bayer 有序抖动、误差扩散、Halftone；支持图像缩放；
    TypeScript，可集成进现有浏览器管线。
  - 更适合严格量化到指定三个 RGB 颜色；但它是图像处理库，不是完整设计软件。
    当前 README 说明扩展算法尚未全部进入已发布 npm 版本。

### 3. 建议固定的数据契约

A. 三色索引图：8-bit indexed PNG，每个像素只允许索引 0、1、2。

B. RGB 预览图：由索引图映射得到，严格只有三种 RGB 颜色，不允许渐变、抗锯齿混色。

C. 灰度深度图：独立的 8-bit 或 16-bit 高度数据，与索引图尺寸和坐标严格一致。

关键选择：优先测试**有序网点（Ordered Dithering）和误差扩散（Error Diffusion）**，而不是只测试传统 AM 网点。

- 有序网点：低分辨率下图案规律清晰，适合规则采样。
- 误差扩散：能保留轮廓和局部色彩比例，但可能产生碎点。
- 聚簇网点：更接近传统印刷的圆点结构。

建议先用 `Orvlyn/Halftone` 找到好看的空间图案，再用 `ditherto` 生成严格三色索引图。
前者负责视觉探索，后者负责数据正确性。

最终验收条件：导出的索引图统计唯一值，必须恰好只有 0、1、2；
不能出现第四种颜色。这样才能和深度图独立配准，进入后续浮雕管线。
