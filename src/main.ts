import './style.css';
import {
  GRID_CELL_SIZE,
  GRID_CELLS_X,
  GRID_CELLS_Y,
  PART_STYLES,
  RELIEF_DEPTH,
  RELIEF_WIDTH,
  clamp,
  footprintForAspect,
  setGeometry,
  type ColorIndex,
} from './config';
import { deriveDepthFromColor } from './depth-from-color';
import { colorNameForRgb, extractPalette } from './palette';
import {
  buildRelief,
  type ReliefBuildData,
  type ValidationReport,
} from './parts';
import {
  createPattern,
  normalizeRatios,
  overridePatternColors,
  type LatticeArrangement,
  type PatternParams,
} from './pattern';
import {
  colorImageToContinuousMap,
  colorImageToLattice,
} from './color-map';
import { ReliefViewer, type ViewMode } from './viewer';
import {
  createBuiltinRelief,
  createDepthMapRelief,
  type ReliefField,
} from './relief';

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
}

const patternState = {
  pitch: 6.2,
  unitRatio: 0.36,
  ratios: [42, 34, 24] as [number, number, number],
  arrangement: 'grid' as LatticeArrangement,
  rotationDeg: 0,
  jitter: 0.28,
  seed: 8241,
};

let viewMode: ViewMode = 'assembled';
const selectedParts = new Set<ColorIndex>();
let explodeDistance = 26;
let sectionY = 2;
let showDots = true;
let showBoundaries = true;
let autoRotate = false;
let latestBuild: ReliefBuildData | null = null;
let currentField: ReliefField = createBuiltinRelief();
let currentColorMap: Uint8Array | null = null;
let currentColourImageData: ImageData | null = null;
let latticePitch = 1.0;
let geometryCellSize = 0.2;
let geometryAuto = true;
let depthSmoothing = 0;
let continuousMode = true;
let depthRange = 2.0;
let invertDepth = false;
let currentDepthImageData: ImageData | null = null;
let layerColors: [ColorIndex, ColorIndex, ColorIndex] = [0, 1, 2];
let imageColourMode = false;
let dotsBeforeImageColour = true;
let rebuildTimer: number | null = null;
let buildGeneration = 0;

const canvas = byId<HTMLCanvasElement>('scene');
const app = byId<HTMLDivElement>('app');
let viewer: ReliefViewer | null = null;

try {
  viewer = new ReliefViewer(canvas, app);
} catch (error) {
  console.error('WebGL initialisation failed:', error);
  byId<HTMLDivElement>('fallback').hidden = false;
  byId<HTMLDivElement>('loader').classList.add('is-done');
}

const modeButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>('.mode-btn'),
);
const soloButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>('.part-pill'),
);
const arrangementButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>('#arrangement-control button'),
);

const explodeRange = byId<HTMLInputElement>('explode-range');
const explodeOutput = byId<HTMLOutputElement>('explode-output');
const sectionControl = byId<HTMLDivElement>('section-control');
const sectionRange = byId<HTMLInputElement>('section-range');
const sectionOutput = byId<HTMLOutputElement>('section-output');
const rotationRange = byId<HTMLInputElement>('rotation-range');
const rotationOutput = byId<HTMLOutputElement>('rotation-output');
const jitterRange = byId<HTMLInputElement>('jitter-range');
const jitterOutput = byId<HTMLOutputElement>('jitter-output');
const pitchInput = byId<HTMLInputElement>('pitch-input');
const unitInput = byId<HTMLInputElement>('unit-input');
const seedInput = byId<HTMLInputElement>('seed-input');
const toggleDots = byId<HTMLInputElement>('toggle-dots');
const toggleBoundaries = byId<HTMLInputElement>('toggle-boundaries');
const toggleRotate = byId<HTMLInputElement>('toggle-rotate');
const verifyPill = byId<HTMLDivElement>('verify-pill');
const metaSitesLabel = byId<HTMLElement>('meta-sites-label');
const verifyLabel = byId<HTMLSpanElement>('verify-label');
const rebuildStatus = byId<HTMLSpanElement>('rebuild-status');
const loader = byId<HTMLDivElement>('loader');
const legendList = byId<HTMLDivElement>('legend-list');
const ratioInputs = [
  byId<HTMLInputElement>('ratio-yellow'),
  byId<HTMLInputElement>('ratio-magenta'),
  byId<HTMLInputElement>('ratio-cyan'),
];
const ratioOutputs = [
  byId<HTMLOutputElement>('ratio-yellow-output'),
  byId<HTMLOutputElement>('ratio-magenta-output'),
  byId<HTMLOutputElement>('ratio-cyan-output'),
];
const shapeName = byId<HTMLSpanElement>('shape-name');
const shapeRange = byId<HTMLElement>('shape-range');
const uploadDepth = byId<HTMLButtonElement>('upload-depth');
const resetShape = byId<HTMLButtonElement>('reset-shape');
const loadDerivedDepth = byId<HTMLButtonElement>('load-derived-depth');
const geometryCell = byId<HTMLSelectElement>('geometry-cell');
const depthSmoothRange = byId<HTMLInputElement>('depth-smooth-range');
const depthSmoothOutput = byId<HTMLOutputElement>('depth-smooth-output');
const depthRangeRange = byId<HTMLInputElement>('depth-range-range');
const depthRangeOutput = byId<HTMLOutputElement>('depth-range-output');
const depthInvert = byId<HTMLInputElement>('depth-invert');
const continuousToggle = byId<HTMLInputElement>('continuous-mode');
const depthFileInput = byId<HTMLInputElement>('depth-file');
const colorName = byId<HTMLElement>('color-name');
const colorStatus = byId<HTMLElement>('color-status');
const uploadColor = byId<HTMLButtonElement>('upload-color');
const resetColor = byId<HTMLButtonElement>('reset-color');
const colorFileInput = byId<HTMLInputElement>('color-file');
const pitchRange = byId<HTMLInputElement>('pitch-range');
const pitchOutput = byId<HTMLOutputElement>('pitch-output');
const layerTop = byId<HTMLSelectElement>('layer-top');
const layerMiddle = byId<HTMLSelectElement>('layer-middle');
const layerBottom = byId<HTMLSelectElement>('layer-bottom');
const loadDemoButton = byId<HTMLButtonElement>('load-demo');
const latticeSection = byId<HTMLElement>('lattice-section');
const latticeLockNote = byId<HTMLElement>('lattice-lock-note');

function setRangeFill(input: HTMLInputElement, normalized = true): void {
  const value = Number(input.value);
  const min = Number(input.min);
  const max = Number(input.max);
  const percent = normalized
    ? ((value - min) / Math.max(0.0001, max - min)) * 100
    : value;
  input.style.setProperty('--range-fill', `${clamp(percent, 0, 100)}%`);
}

function formatSigned(value: number, digits = 2): string {
  const normalized = Math.abs(value) < 0.00005 ? 0 : value;
  return `${normalized >= 0 ? '+' : ''}${normalized.toFixed(digits)}`;
}

function updateLegend(report: ValidationReport): void {
  legendList.innerHTML = PART_STYLES.map((style, index) => {
    const ratio = report.areaRatios[index] * 100;
    const volume = latestBuild?.parts[index].volume ?? 0;
    return `
      <div class="legend-item" style="--legend-color: ${style.color}" title="体积含隐藏实心连接层">
        <div class="legend-head">
          <i class="legend-swatch"></i>
          <span class="legend-name">${style.name}色零件</span>
          <span class="legend-material">${style.material}</span>
        </div>
        <div class="legend-values">
          <strong>${(volume / 1000).toFixed(2)} cm³</strong>
          <span>${ratio.toFixed(1)}%</span>
        </div>
        <div class="legend-bar"><i style="width: ${ratio.toFixed(2)}%"></i></div>
      </div>
    `;
  }).join('');
}

function updateValidation(data: ReliefBuildData): void {
  const report = data.validation;
  const version = data.pattern.params;

  byId<HTMLSpanElement>('meta-sites').textContent = imageColourMode
    ? data.stats.cells.toLocaleString('en-US')
    : String(data.pattern.visibleSiteCount);
  metaSitesLabel.textContent = imageColourMode ? '图像色元' : '点阵单元';

  byId<HTMLElement>('val-original').textContent = (report.originalVolume / 1000).toFixed(2);
  byId<HTMLElement>('val-sum').textContent = (report.volumeSum / 1000).toFixed(2);

  const diffCm3 = report.volumeDifference / 1000;
  byId<HTMLElement>('val-difference').textContent =
    `${formatSigned(diffCm3, 4)} cm³ · ${formatSigned(report.volumeDifferencePercent, 5)}%`;
  const differencePill = byId<HTMLElement>('difference-pill');
  const volumePass = Math.abs(report.volumeDifferencePercent) < 0.0005;
  differencePill.textContent = volumePass ? 'PASS' : 'CHECK';
  differencePill.style.color = volumePass ? 'var(--green)' : 'var(--yellow)';

  byId<HTMLElement>('val-overlap').innerHTML =
    `${report.overlapArea.toFixed(3)} <small>mm²</small>`;
  byId<HTMLElement>('val-uncovered').innerHTML =
    `${report.uncoveredArea.toFixed(3)} <small>mm²</small>`;
  byId<HTMLElement>('val-max-deviation').innerHTML =
    `${report.topMaxDeviation.toFixed(3)} <small>mm</small>`;
  byId<HTMLElement>('val-area-ratio').textContent = report.areaRatios
    .map((ratio) => `${(ratio * 100).toFixed(1)}%`)
    .join(' / ');
  byId<HTMLElement>('val-triangles').textContent =
    data.stats.triangles.toLocaleString('en-US');

  byId<HTMLElement>('proof-samples').textContent =
    report.sampleCount.toLocaleString('en-US');
  byId<HTMLElement>('proof-rms').textContent =
    `${report.topRmsDeviation.toFixed(4)} mm`;
  byId<HTMLElement>('proof-analytic').textContent =
    `${(report.analyticVolume / 1000).toFixed(2)} cm³ · 差 ${formatSigned(
      report.analyticDifference / 1000,
      3,
    )} cm³`;
  byId<HTMLElement>('proof-closed').textContent = report.closed
    ? '分区墙完整 · 底面齐平'
    : '异常';

  const islands = report.surfaceIslandCounts;
  const connected = report.partConnected.every(Boolean);
  byId<HTMLElement>('component-yellow').textContent = String(islands[0]);
  byId<HTMLElement>('component-magenta').textContent = String(islands[1]);
  byId<HTMLElement>('component-cyan').textContent = String(islands[2]);
  const connectivityStatus = byId<HTMLElement>('connectivity-status');
  connectivityStatus.textContent = connected ? 'PASS' : 'SPLIT';
  connectivityStatus.classList.toggle('is-bad', !connected);
  byId<HTMLElement>('proof-components').textContent =
    `${islands.join(' / ')} → 1 / 1 / 1 · ${connected ? '已并入实心连接层' : '连接异常'}`;
  byId<HTMLElement>('proof-stems').textContent =
    report.stemCounts.join(' / ');
  byId<HTMLElement>('proof-connector').textContent =
    `+${(report.connectorVolume / 1000).toFixed(2)} cm³`;
  byId<HTMLElement>('proof-total').textContent =
    `${(report.totalPrintVolume / 1000).toFixed(2)} cm³`;
  byId<HTMLElement>('val-connector').textContent =
    `+${(report.connectorVolume / 1000).toFixed(2)} cm³`;

  byId<HTMLElement>('shape-range').textContent =
    `H ${report.minSurfaceHeight.toFixed(1)} – ${report.maxSurfaceHeight.toFixed(1)} mm`;
  if (imageColourMode) {
    colorStatus.textContent = `${continuousMode ? '连续色块' : '点阵取样'} · ${report.areaRatios
      .map((ratio) => Math.round(ratio * 100))
      .join(' / ')}%`;
  }

  const exclusive = report.volumeExclusive;
  byId<HTMLElement>('val-volume-overlap').textContent =
    `${(report.volumeOverlap / 1000).toFixed(3)} cm³`;
  const exclusionPill = byId<HTMLElement>('exclusion-pill');
  exclusionPill.textContent = exclusive ? 'PASS' : 'CHECK';
  exclusionPill.style.color = exclusive ? 'var(--green)' : 'var(--yellow)';
  byId<HTMLElement>('proof-exclusive').textContent = exclusive
    ? '通过 · 实心层互不重叠'
    : '异常';
  byId<HTMLElement>('connector-base').textContent =
    `顶层底板：${PART_STYLES[report.baseColour].name}`;
  byId<HTMLElement>('proof-base').textContent =
    `${PART_STYLES[report.baseColour].name}色 · 顶层负片`;

  const connectorsPass = report.partConnected.every(Boolean);
  const passed =
    volumePass &&
    report.overlapArea === 0 &&
    report.uncoveredArea === 0 &&
    report.closed &&
    report.bottomFlat &&
    connectorsPass &&
    exclusive;
  verifyPill.classList.toggle('is-building', false);
  verifyPill.style.borderColor = passed
    ? 'rgba(143, 216, 176, 0.2)'
    : 'rgba(245, 197, 66, 0.25)';
  verifyLabel.textContent = passed ? '几何验证通过' : '请检查验证项';

  document.querySelectorAll<HTMLElement>('.check-card em').forEach((badge) => {
    badge.style.color = passed ? 'var(--green)' : 'var(--yellow)';
  });

  updateLegend(report);

  // Keep the ratio sliders aligned with the requested target values.
  const target = normalizeRatios(version.ratios);
  ratioInputs.forEach((input, index) => {
    input.value = String(Math.round(target[index] * 100));
    ratioOutputs[index].textContent = `${Math.round(target[index] * 100)}%`;
    setRangeFill(input, false);
  });
}

function setBusy(busy: boolean): void {
  verifyPill.classList.toggle('is-building', busy);
  if (busy) {
    verifyLabel.textContent = '正在重建几何';
    rebuildStatus.textContent = 'REBUILDING';
    rebuildStatus.classList.add('is-active');
  } else {
    rebuildStatus.textContent = 'PARAMETRIC';
    rebuildStatus.classList.remove('is-active');
  }
}

function buildAndApply(token: number): void {
  if (token !== buildGeneration) return;
  try {
    const [r0, r1, r2] = patternState.ratios;
    const params: PatternParams = {
      pitch: patternState.pitch,
      unitRatio: patternState.unitRatio,
      ratios: [r0 / 100, r1 / 100, r2 / 100],
      arrangement: patternState.arrangement,
      rotationDeg: patternState.rotationDeg,
      jitter: patternState.jitter,
      seed: patternState.seed,
    };
    const basePattern = createPattern(params);
    const pattern = currentColorMap
      ? overridePatternColors(basePattern, currentColorMap)
      : basePattern;
    const data = buildRelief(pattern, currentField, {
      layerColors,
    });
    if (token !== buildGeneration) return;

    latestBuild = data;
    viewer?.setData(data);
    updateValidation(data);
    setBusy(false);
    loader.classList.add('is-done');
  } catch (error) {
    console.error('Geometry rebuild failed:', error);
    setBusy(false);
    verifyLabel.textContent = '几何重建失败';
    verifyPill.classList.add('is-building');
    rebuildStatus.textContent = 'ERROR';
    loader.classList.add('is-done');
  }
}

function scheduleRebuild(delay = 170): void {
  buildGeneration += 1;
  const token = buildGeneration;
  setBusy(true);
  if (rebuildTimer !== null) window.clearTimeout(rebuildTimer);
  rebuildTimer = window.setTimeout(() => buildAndApply(token), delay);
}

function updateReadout(): void {
  const readoutIndex = byId<HTMLSpanElement>('readout-index');
  const title = byId<HTMLElement>('readout-title');
  const subtitle = byId<HTMLElement>('readout-subtitle');

  if (selectedParts.size > 0) {
    const names = [...selectedParts]
      .sort((a, b) => a - b)
      .map((part) => PART_STYLES[part].name)
      .join(' / ');
    readoutIndex.textContent = selectedParts.size === 1 ? 'P' : 'SEL';
    title.textContent =
      selectedParts.size === 1 ? `单件 · ${names}` : `多选 · ${names}`;
    subtitle.textContent = '仅显示已选零件 · 点击可任意多选';
    return;
  }

  if (viewMode === 'assembled') {
    readoutIndex.textContent = '01';
    title.textContent = '组合视图';
    subtitle.textContent = '三件互补 · 完整覆盖原始浮雕';
  } else if (viewMode === 'exploded') {
    readoutIndex.textContent = '02';
    title.textContent = '爆炸视图';
    subtitle.textContent = '沿 Z 轴分离 · 上层通孔对应下层整柱';
  } else if (viewMode === 'xray') {
    readoutIndex.textContent = '03';
    title.textContent = '透明视图';
    subtitle.textContent = '半透明实体 · 观察内部垂直分区';
  } else {
    readoutIndex.textContent = '04';
    title.textContent = '剖切视图';
    subtitle.textContent = '沿 Y 轴截面 · 检查连续色柱与底面';
  }
}

function refreshViewChrome(): void {
  modeButtons.forEach((button) => {
    button.classList.toggle(
      'is-active',
      selectedParts.size === 0 && button.dataset.mode === viewMode,
    );
  });
  soloButtons.forEach((button) => {
    button.classList.toggle(
      'is-active',
      selectedParts.has(Number(button.dataset.solo) as ColorIndex),
    );
  });
  sectionControl.classList.toggle(
    'is-hidden',
    selectedParts.size > 0 || viewMode !== 'section',
  );
  updateReadout();
}

function applyViewerState(): void {
  viewer?.updateState({
    mode: viewMode,
    selectedParts: [...selectedParts],
    explodeDistance,
    sectionY,
    showDots,
    showBoundaries,
    autoRotate,
  });
}

function selectMode(mode: ViewMode): void {
  viewMode = mode;
  selectedParts.clear();
  refreshViewChrome();
  applyViewerState();
}

modeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const mode = button.dataset.mode as ViewMode | undefined;
    if (mode) selectMode(mode);
  });
});

soloButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const index = Number(button.dataset.solo) as ColorIndex;
    if (selectedParts.has(index)) {
      selectedParts.delete(index);
    } else {
      selectedParts.add(index);
    }
    refreshViewChrome();
    applyViewerState();
  });
});

explodeRange.addEventListener('input', () => {
  explodeDistance = Number(explodeRange.value);
  explodeOutput.textContent = `${explodeDistance} mm`;
  setRangeFill(explodeRange);
  applyViewerState();
});

sectionRange.addEventListener('input', () => {
  sectionY = Number(sectionRange.value);
  sectionOutput.textContent = `${sectionY >= 0 ? '+' : ''}${String(sectionY).padStart(2, '0')} mm`;
  setRangeFill(sectionRange);
  viewer?.updateSection(sectionY);
});

toggleDots.addEventListener('change', () => {
  showDots = toggleDots.checked;
  applyViewerState();
});

toggleBoundaries.addEventListener('change', () => {
  showBoundaries = toggleBoundaries.checked;
  applyViewerState();
});

toggleRotate.addEventListener('change', () => {
  autoRotate = toggleRotate.checked;
  applyViewerState();
});

byId<HTMLButtonElement>('reset-camera').addEventListener('click', () => {
  viewer?.resetCamera();
});

arrangementButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const arrangement = button.dataset.arrangement as
      | LatticeArrangement
      | undefined;
    if (!arrangement) return;
    patternState.arrangement = arrangement;
    arrangementButtons.forEach((candidate) => {
      candidate.classList.toggle('is-active', candidate === button);
    });
    scheduleRebuild();
  });
});

pitchInput.addEventListener('change', () => {
  const value = clamp(Number(pitchInput.value) || 6.2, 3.5, 14);
  patternState.pitch = Math.round(value * 10) / 10;
  pitchInput.value = patternState.pitch.toFixed(1);
  scheduleRebuild();
});

unitInput.addEventListener('change', () => {
  const value = clamp(Number(unitInput.value) || 0.36, 0.16, 0.68);
  patternState.unitRatio = Math.round(value * 100) / 100;
  unitInput.value = patternState.unitRatio.toFixed(2);
  scheduleRebuild();
});

rotationRange.addEventListener('input', () => {
  patternState.rotationDeg = Number(rotationRange.value);
  rotationOutput.textContent = `${patternState.rotationDeg >= 0 ? '+' : ''}${String(
    patternState.rotationDeg,
  ).padStart(2, '0')}°`;
  setRangeFill(rotationRange);
  scheduleRebuild(220);
});

jitterRange.addEventListener('input', () => {
  patternState.jitter = Number(jitterRange.value);
  jitterOutput.textContent = patternState.jitter.toFixed(2);
  setRangeFill(jitterRange);
  scheduleRebuild(220);
});

seedInput.addEventListener('change', () => {
  const value = Math.round(clamp(Number(seedInput.value) || 1, 1, 999999));
  patternState.seed = value;
  seedInput.value = String(value);
  scheduleRebuild();
});

byId<HTMLButtonElement>('seed-shuffle').addEventListener('click', () => {
  patternState.seed = Math.floor(1 + Math.random() * 999999);
  seedInput.value = String(patternState.seed);
  scheduleRebuild(20);
});

ratioInputs.forEach((input, index) => {
  input.addEventListener('input', () => {
    let value = Math.round(Number(input.value));
    value = clamp(value, 5, 80);
    const otherIndices = [0, 1, 2].filter((candidate) => candidate !== index);
    const remaining = 100 - value;
    const previousOtherSum =
      patternState.ratios[otherIndices[0]] + patternState.ratios[otherIndices[1]];
    let firstOther =
      previousOtherSum > 0
        ? Math.round(
            (remaining * patternState.ratios[otherIndices[0]]) / previousOtherSum,
          )
        : Math.round(remaining / 2);
    firstOther = clamp(firstOther, 5, remaining - 5);
    const secondOther = remaining - firstOther;

    patternState.ratios[index] = value;
    patternState.ratios[otherIndices[0]] = firstOther;
    patternState.ratios[otherIndices[1]] = secondOther;

    ratioInputs.forEach((range, colorIndex) => {
      range.value = String(patternState.ratios[colorIndex]);
      ratioOutputs[colorIndex].textContent = `${patternState.ratios[colorIndex]}%`;
      setRangeFill(range, false);
    });
    scheduleRebuild(240);
  });
});

function updateShapeUI(): void {
  const imageKind = currentField.kind === 'depth-map';
  shapeName.textContent = currentField.name;
  const sourceSize =
    currentField.sourceWidth && currentField.sourceHeight
      ? ` · ${currentField.sourceWidth}×${currentField.sourceHeight}`
      : '';
  shapeRange.textContent =
    `H ${currentField.minHeight.toFixed(1)} – ${currentField.maxHeight.toFixed(1)} mm${sourceSize}`;
  resetShape.disabled = !imageKind;
  depthSmoothRange.disabled = !imageKind;
  depthRangeRange.disabled = !imageKind;
  depthInvert.disabled = !imageKind;
}

function rgbToHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue]
    .map((value) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0'))
    .join('')}`;
}

function applyPaletteFromImage(imageData: ImageData): void {
  const colors = extractPalette(imageData);
  if (!colors) return;
  colors.forEach((rgb, index) => {
    const style = PART_STYLES[index];
    const [red, green, blue] = rgb;
    style.rgb = [red, green, blue];
    style.color = rgbToHex(red, green, blue);
    style.colorHex = (red << 16) | (green << 8) | blue;
    const dark = rgb.map((value) => Math.round(value * 0.58)) as [number, number, number];
    style.dark = rgbToHex(...dark);
    style.darkHex = (dark[0] << 16) | (dark[1] << 8) | dark[2];
    style.name = colorNameForRgb(rgb);
    style.english = style.name.toUpperCase();
    style.material = `PLA · ${style.name}`;
  });
  layerColors = [0, 1, 2];
  updateLayerSelects();
  updateLayerOptionLabels();
  soloButtons.forEach((button, index) => {
    const label = button.querySelector('span');
    if (label) label.textContent = PART_STYLES[index].name;
  });
  const root = document.documentElement;
  root.style.setProperty('--yellow', PART_STYLES[0].color);
  root.style.setProperty('--magenta', PART_STYLES[1].color);
  root.style.setProperty('--cyan', PART_STYLES[2].color);
  viewer?.updatePalette();
  if (latestBuild) {
    updateLegend(latestBuild.validation);
  } else {
    primeLegend();
  }
}

function updateGeometryUI(): void {
  byId<HTMLElement>('stat-grid').textContent =
    `${GRID_CELLS_X} × ${GRID_CELLS_Y}`;
  byId<HTMLElement>('stat-cell').textContent =
    `${GRID_CELL_SIZE.toFixed(2)} mm`;
  byId<HTMLElement>('field-size').textContent =
    `FIELD ${RELIEF_WIDTH.toFixed(1)} × ${RELIEF_DEPTH.toFixed(1)} mm`;
}

function applyGeometryFromImage(imageData: ImageData): void {
  const { width, depth } = footprintForAspect(
    imageData.width / imageData.height,
    105,
  );
  if (geometryAuto) {
    const sourcePixels = Math.max(imageData.width, imageData.height);
    let cell = clamp(105 / sourcePixels, 0.06, 0.2);
    const cells = (width / cell) * (depth / cell);
    if (cells > 1_200_000) {
      cell = Math.sqrt((width * depth) / 1_200_000);
    }
    geometryCellSize = cell;
  }
  const geometry = setGeometry(width, depth, geometryCellSize);
  geometryCellSize = geometry.cellSize;
  updateGeometryUI();
  if (currentColourImageData) regenerateImageColorMap();
  if (currentField.kind === 'builtin') {
    currentField = createBuiltinRelief();
  }
  viewer?.resetCamera();
}

async function blobToImageData(
  blob: Blob,
  maxDimension = 720,
): Promise<ImageData> {
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = objectUrl;
    await image.decode();
    const naturalWidth = image.naturalWidth || image.width;
    const naturalHeight = image.naturalHeight || image.height;
    const scale = Math.min(1, maxDimension / Math.max(naturalWidth, naturalHeight));
    const width = Math.max(1, Math.round(naturalWidth * scale));
    const height = Math.max(1, Math.round(naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas 2D unavailable');
    context.imageSmoothingEnabled = true;
    context.drawImage(image, 0, 0, width, height);
    return context.getImageData(0, 0, width, height);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function processDepthBlob(blob: Blob, name: string): Promise<void> {
  const imageData = await blobToImageData(blob, 2048);
  currentDepthImageData = imageData;
  currentField = createDepthMapRelief(imageData, name, {
    smoothingPasses: depthSmoothing,
    depthRange,
    invert: invertDepth,
  });
  updateShapeUI();
  scheduleRebuild(20);
}

async function loadDepthImage(file: File): Promise<void> {
  try {
    await processDepthBlob(file, file.name);
  } finally {
    depthFileInput.value = '';
  }
}

function setColourUI(name: string): void {
  colorName.textContent = imageColourMode ? name : '程序点阵';
  colorStatus.textContent = imageColourMode
    ? continuousMode
      ? '原始比例 · 连续色块（实验）'
      : '原始比例 · 坐标点阵取样'
    : '点阵参数生效';
  resetColor.disabled = !imageColourMode;
  latticeSection.classList.toggle('is-locked', imageColourMode);
  latticeSection
    .querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')
    .forEach((element) => {
      element.disabled = imageColourMode;
    });
  latticeLockNote.hidden = !imageColourMode;
  pitchRange.disabled = !imageColourMode || continuousMode;
  pitchOutput.textContent = `${latticePitch.toFixed(1)} mm`;
  toggleDots.checked = showDots;
  applyViewerState();
}

function regenerateImageColorMap(): void {
  if (!currentColourImageData) return;
  if (continuousMode) {
    currentColorMap = colorImageToContinuousMap(
      currentColourImageData,
      layerColors,
    ).cellColors;
  } else {
    const result = colorImageToLattice(currentColourImageData, {
      pitchMm: latticePitch,
      topColor: layerColors[0],
    });
    currentColorMap = result.cellColors;
  }
}

async function processColourBlob(blob: Blob, name: string): Promise<void> {
  const imageData = await blobToImageData(blob, 2048);
  currentColourImageData = imageData;
  applyPaletteFromImage(imageData);
  applyGeometryFromImage(imageData);
  if (!imageColourMode) dotsBeforeImageColour = showDots;
  imageColourMode = true;
  regenerateImageColorMap();
  showDots = false;
  setColourUI(name);
  scheduleRebuild(20);
}

async function loadColourImage(file: File): Promise<void> {
  try {
    await processColourBlob(file, file.name);
  } finally {
    colorFileInput.value = '';
  }
}

function clearColourImage(): void {
  if (!imageColourMode) return;
  currentColorMap = null;
  currentColourImageData = null;
  imageColourMode = false;
  showDots = dotsBeforeImageColour;
  setColourUI('程序点阵');
  scheduleRebuild(20);
}

loadDerivedDepth.addEventListener('click', () => {
  if (!currentColourImageData) {
    colorStatus.textContent = '请先载入三色图，再派生深度';
    return;
  }
  const derived = deriveDepthFromColor(currentColourImageData, layerColors);
  currentDepthImageData = derived;
  currentField = createDepthMapRelief(derived, '由三色图派生', {
    smoothingPasses: depthSmoothing,
    depthRange,
    invert: invertDepth,
  });
  updateShapeUI();
  scheduleRebuild(60);
});

uploadDepth.addEventListener('click', () => {
  depthFileInput.click();
});

depthFileInput.addEventListener('change', () => {
  const file = depthFileInput.files?.[0];
  if (!file) return;
  loadDepthImage(file).catch((error) => {
    console.error('Depth map loading failed:', error);
    shapeName.textContent = '深度图读取失败';
  });
});

resetShape.addEventListener('click', () => {
  if (currentField.kind === 'builtin') return;
  currentField = createBuiltinRelief();
  currentDepthImageData = null;
  updateShapeUI();
  scheduleRebuild(20);
});

uploadColor.addEventListener('click', () => {
  colorFileInput.click();
});

colorFileInput.addEventListener('change', () => {
  const file = colorFileInput.files?.[0];
  if (!file) return;
  loadColourImage(file).catch((error) => {
    console.error('Colour map loading failed:', error);
    colorName.textContent = '三色图读取失败';
    colorStatus.textContent = '需要黄 / 品红 / 青蓝像素';
  });
});

resetColor.addEventListener('click', clearColourImage);

let demoLoading = false;
async function loadWaveDemo(): Promise<void> {
  if (demoLoading) return;
  demoLoading = true;
  loadDemoButton.disabled = true;
  colorStatus.textContent = '正在载入参考点阵…';
  const base = import.meta.env.BASE_URL;
  const version = '?v=20261113b';
  try {
    const [colourResponse, depthResponse] = await Promise.all([
      fetch(`${base}reference2-threecolor.png${version}`, { cache: 'no-store' }),
      fetch(`${base}reference2-depth.png${version}`, { cache: 'no-store' }),
    ]);
    if (!colourResponse.ok) throw new Error('colour source unavailable');
    if (!depthResponse.ok) throw new Error('depth source unavailable');
    await processColourBlob(await colourResponse.blob(), 'reference2-threecolor.png');
    await processDepthBlob(await depthResponse.blob(), 'reference2-depth.png');
  } catch (error) {
    console.error('Demo map loading failed:', error);
    colorStatus.textContent = '参考图加载失败';
  } finally {
    demoLoading = false;
    loadDemoButton.disabled = false;
    if (!latestBuild) scheduleRebuild(20);
  }
}

loadDemoButton.addEventListener('click', () => {
  void loadWaveDemo();
});

function updateLayerOptionLabels(): void {
  [layerTop, layerMiddle, layerBottom].forEach((select) => {
    for (const option of Array.from(select.options)) {
      option.textContent = PART_STYLES[Number(option.value)].name;
    }
  });
}

function updateLayerSelects(): void {
  layerTop.value = String(layerColors[0]);
  layerMiddle.value = String(layerColors[1]);
  layerBottom.value = String(layerColors[2]);
}

function setLayerColor(layer: number, color: ColorIndex): void {
  const existing = layerColors.indexOf(color);
  if (existing !== -1 && existing !== layer) {
    layerColors[existing] = layerColors[layer];
  }
  layerColors[layer] = color;
  updateLayerSelects();
  if (currentColourImageData) regenerateImageColorMap();
  scheduleRebuild(90);
}

layerTop.addEventListener('change', () => {
  setLayerColor(0, Number(layerTop.value) as ColorIndex);
});
layerMiddle.addEventListener('change', () => {
  setLayerColor(1, Number(layerMiddle.value) as ColorIndex);
});
layerBottom.addEventListener('change', () => {
  setLayerColor(2, Number(layerBottom.value) as ColorIndex);
});

continuousToggle.addEventListener('change', () => {
  continuousMode = continuousToggle.checked;
  if (currentColourImageData) regenerateImageColorMap();
  setColourUI(currentColourImageData ? colorName.textContent : '程序点阵');
  scheduleRebuild(90);
});

geometryCell.addEventListener('change', () => {
  geometryAuto = geometryCell.value === 'auto';
  if (geometryAuto) {
    if (currentColourImageData) {
      applyGeometryFromImage(currentColourImageData);
      scheduleRebuild(150);
    }
    return;
  }
  const requested = Number(geometryCell.value);
  geometryCellSize = Number.isFinite(requested) ? requested : 0.2;
  const geometry = setGeometry(RELIEF_WIDTH, RELIEF_DEPTH, geometryCellSize);
  geometryCellSize = geometry.cellSize;
  updateGeometryUI();
  if (currentColourImageData) regenerateImageColorMap();
  if (currentField.kind === 'builtin') {
    currentField = createBuiltinRelief();
  }
  viewer?.resetCamera();
  scheduleRebuild(150);
});

pitchRange.addEventListener('input', () => {
  latticePitch = Number(pitchRange.value);
  pitchOutput.textContent = `${latticePitch.toFixed(1)} mm`;
  setRangeFill(pitchRange);
  if (currentColourImageData) {
    regenerateImageColorMap();
    scheduleRebuild(90);
  }
});

function recreateDepthField(): void {
  if (!currentDepthImageData) return;
  currentField = createDepthMapRelief(
    currentDepthImageData,
    currentField.name,
    {
      smoothingPasses: depthSmoothing,
      depthRange,
      invert: invertDepth,
    },
  );
  updateShapeUI();
  scheduleRebuild(60);
}

depthSmoothRange.addEventListener('input', () => {
  depthSmoothing = Number(depthSmoothRange.value);
  depthSmoothOutput.textContent = String(depthSmoothing);
  setRangeFill(depthSmoothRange);
  recreateDepthField();
});

depthRangeRange.addEventListener('input', () => {
  depthRange = Number(depthRangeRange.value);
  depthRangeOutput.textContent = `${depthRange.toFixed(1)} mm`;
  setRangeFill(depthRangeRange);
  recreateDepthField();
});

depthInvert.addEventListener('change', () => {
  invertDepth = depthInvert.checked;
  recreateDepthField();
});

function initializeRangeFills(): void {
  [
    explodeRange,
    sectionRange,
    rotationRange,
    jitterRange,
    pitchRange,
    depthSmoothRange,
    depthRangeRange,
    ...ratioInputs,
  ].forEach((input) => {
    const index = ratioInputs.indexOf(input);
    setRangeFill(input, index === -1);
  });
  explodeOutput.textContent = `${explodeDistance} mm`;
  sectionOutput.textContent = `+${String(sectionY).padStart(2, '0')} mm`;
  rotationOutput.textContent = `+${String(patternState.rotationDeg).padStart(2, '0')}°`;
  jitterOutput.textContent = patternState.jitter.toFixed(2);
}

function primeLegend(): void {
  legendList.innerHTML = PART_STYLES.map(
    (style) => `
      <div class="legend-item" style="--legend-color: ${style.color}" title="体积含隐藏实心连接层">
        <div class="legend-head">
          <i class="legend-swatch"></i>
          <span class="legend-name">${style.name}色零件</span>
          <span class="legend-material">${style.material}</span>
        </div>
        <div class="legend-values"><strong>—</strong><span>—</span></div>
        <div class="legend-bar"><i></i></div>
      </div>
    `,
  ).join('');
}

window.addEventListener('pagehide', (event) => {
  if (event.persisted) return;
  if (rebuildTimer !== null) {
    window.clearTimeout(rebuildTimer);
    rebuildTimer = null;
  }
  viewer?.dispose();
});

initializeRangeFills();
updateLayerSelects();
updateGeometryUI();
depthSmoothOutput.textContent = String(depthSmoothing);
depthRangeOutput.textContent = `${depthRange.toFixed(1)} mm`;
updateShapeUI();
setColourUI('程序点阵');
primeLegend();
refreshViewChrome();
applyViewerState();

// The run starts with the cropped reference images; the procedural lattice and
// analytic height field remain available through the reset buttons.
window.setTimeout(() => {
  void loadWaveDemo();
}, 60);

// Expose a tiny QA surface for headless screenshots and manual inspection.
interface TricolorDebugApi {
  build: () => ReliefBuildData | null;
  state: () => {
    mode: ViewMode;
    selectedParts: ColorIndex[];
    explodeDistance: number;
    sectionY: number;
  };
  setMode: (mode: ViewMode) => void;
  setSelection: (parts: ColorIndex[]) => void;
  setExplode: (distance: number) => void;
  setSection: (value: number) => void;
  setViewingAngle: (x: number, y: number, z: number, tx?: number) => void;
  debug: () => Record<string, unknown> | null;
}

(window as unknown as { __tricolor?: TricolorDebugApi }).__tricolor = {
  build: () => latestBuild,
  state: () => ({
    mode: viewMode,
    selectedParts: [...selectedParts],
    explodeDistance,
    sectionY,
  }),
  setMode: (mode) => selectMode(mode),
  setSelection: (parts) => {
    selectedParts.clear();
    parts.forEach((part) => selectedParts.add(part));
    refreshViewChrome();
    applyViewerState();
  },
  setExplode: (distance) => {
    explodeDistance = clamp(distance, 0, 68);
    explodeRange.value = String(explodeDistance);
    explodeOutput.textContent = `${explodeDistance} mm`;
    setRangeFill(explodeRange);
    applyViewerState();
  },
  setSection: (value) => {
    sectionY = clamp(value, -36, 36);
    sectionRange.value = String(sectionY);
    sectionOutput.textContent = `${sectionY >= 0 ? '+' : ''}${String(sectionY).padStart(2, '0')} mm`;
    setRangeFill(sectionRange);
    viewer?.updateSection(sectionY);
  },
  setViewingAngle: (x, y, z, tx = 0) => {
    viewer?.setCameraPose([x, y, z], [tx, 0, 11]);
  },
  debug: () => viewer?.debugInfo() ?? null,
};
