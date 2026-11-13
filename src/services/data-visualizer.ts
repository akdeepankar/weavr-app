/**
 * DataVisualizer — offline, procedural 3D & 2D data visualization engine.
 *
 * Supports CSV parsing, axis mapping, column filtering, and renders:
 * - 3D Scatter Plots (multi-axis spatial clustering)
 * - 3D Bar Charts (categorical grid with extruded height)
 * - 2D Flat Bar Charts (clean planar comparative view)
 *
 * All geometry is generated procedurally with Three.js via @iwsdk/core.
 */

import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Shape,
  SphereGeometry,
  Vector3,
} from '@iwsdk/core';
import type { DataPayload, MathConceptConfig, VisConfig } from './workflow-graph.js';
import { buildMathVisualizationScene } from './math-visualizer.js';

// ---------------------------------------------------------------------------
// Sample Datasets for Instant Exploration
// ---------------------------------------------------------------------------

export const SAMPLE_DATASETS: Record<string, string> = {
  'Iris Measurements': `sepal_length,sepal_width,petal_length,petal_width,species
5.1,3.5,1.4,0.2,setosa
4.9,3.0,1.4,0.2,setosa
4.7,3.2,1.3,0.2,setosa
4.6,3.1,1.5,0.2,setosa
5.0,3.6,1.4,0.2,setosa
5.4,3.9,1.7,0.4,setosa
7.0,3.2,4.7,1.4,versicolor
6.4,3.2,4.5,1.5,versicolor
6.9,3.1,4.9,1.5,versicolor
5.5,2.3,4.0,1.3,versicolor
6.5,2.8,4.6,1.5,versicolor
6.3,3.3,6.0,2.5,virginica
5.8,2.7,5.1,1.9,virginica
7.1,3.0,5.9,2.1,virginica
6.3,2.9,5.6,1.8,virginica
6.5,3.0,5.8,2.2,virginica`,

  'Monthly Financials': `month,revenue,expenses,profit,margin_pct
Jan,120,80,40,33
Feb,150,90,60,40
Mar,180,95,85,47
Apr,210,110,100,48
May,240,120,120,50
Jun,270,135,135,50
Jul,290,140,150,52
Aug,310,145,165,53
Sep,340,160,180,53
Oct,360,170,190,53`,

  'Tech Cloud Metrics': `service,latency_ms,requests_k,error_rate,cost_usd
AuthAPI,45,1200,0.12,350
Storage,120,850,0.05,720
Inference,320,450,0.85,1400
Database,28,3400,0.02,890
Search,85,920,0.25,510
Analytics,210,610,0.40,680`,
};

// ---------------------------------------------------------------------------
// CSV Parser
// ---------------------------------------------------------------------------

export function parseCSV(rawText: string): DataPayload {
  const lines = rawText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    return { headers: [], rows: [], types: [] };
  }

  const headers = lines[0].split(',').map((h) => h.trim().replace(/^["']|["']$/g, ''));
  const rows: (string | number)[][] = [];

  for (let i = 1; i < lines.length; i++) {
    const rawCols = lines[i].split(',').map((c) => c.trim().replace(/^["']|["']$/g, ''));
    if (rawCols.length < headers.length) continue;
    const row = rawCols.map((val) => {
      const num = Number(val);
      return !isNaN(num) && val !== '' ? num : val;
    });
    rows.push(row);
  }

  // Determine column types based on row values
  const types: ('number' | 'string')[] = headers.map((_, colIdx) => {
    let numericCount = 0;
    for (const r of rows) {
      if (typeof r[colIdx] === 'number') numericCount++;
    }
    return numericCount >= rows.length * 0.7 ? 'number' : 'string';
  });

  return { headers, rows, types };
}

// ---------------------------------------------------------------------------
// 3D & 2D Procedural Visualization Builder
// ---------------------------------------------------------------------------

const COLOR_PALETTE = [
  0x8b5cf6, // Violet
  0x06b6d4, // Cyan
  0x10b981, // Emerald
  0xf59e0b, // Amber
  0xec4899, // Pink
  0x3b82f6, // Blue
  0xa855f7, // Purple
  0x14b8a6, // Teal
];

export const NAMED_COLORS: Record<string, number> = {
  red: 0xef4444,
  green: 0x10b981,
  'neon green': 0x22c55e,
  blue: 0x3b82f6,
  cyan: 0x06b6d4,
  yellow: 0xeab308,
  gold: 0xf59e0b,
  orange: 0xf97316,
  purple: 0xa855f7,
  violet: 0x8b5cf6,
  pink: 0xec4899,
  magenta: 0xd946ef,
  white: 0xffffff,
  emerald: 0x10b981,
  teal: 0x14b8a6,
  indigo: 0x6366f1,
  rose: 0xf43f5e,
  lime: 0x84cc16,
};

export function resolveColor(val: string | number | undefined, defaultHex: number): number {
  if (val == null) return defaultHex;
  if (typeof val === 'number') return val;
  const str = String(val).toLowerCase().trim();
  if (NAMED_COLORS[str]) return NAMED_COLORS[str];
  if (str.startsWith('#')) {
    const hex = parseInt(str.slice(1), 16);
    if (!isNaN(hex)) return hex;
  }
  const parsedNum = parseInt(str, 16);
  if (!isNaN(parsedNum)) return parsedNum;
  return defaultHex;
}

function drawCanvasRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export function createTextSprite(
  text: string,
  color = '#E2E8F0',
  fontSize = 28,
  width = 0.16,
  height = 0.045,
  withBackdrop = true,
): Mesh {
  const canvas = document.createElement('canvas');
  // High-DPI canvas (1024x256) for ultra-sharp, large text rendering in WebXR
  canvas.width = 1024;
  canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 1024, 256);

  if (withBackdrop) {
    const padX = 24;
    const padY = 20;
    drawCanvasRoundRect(ctx, padX, padY, 1024 - padX * 2, 256 - padY * 2, 38);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
    ctx.fill();
    // No border stroke!
  }

  // Crisp text rendering with subtle shadow for high contrast
  ctx.shadowColor = 'rgba(0, 0, 0, 0.95)';
  ctx.shadowBlur = 12;
  ctx.font = `bold ${fontSize * 2.2}px system-ui, -apple-system, sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 512, 128);

  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  const mat = new MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const geo = new PlaneGeometry(width, height);
  const mesh = new Mesh(geo, mat);
  mesh.renderOrder = 40;
  return mesh;
}

/**
 * Animation metadata attached to visualization scenes for smooth entrance rising.
 */
export interface VisAnimItem {
  mesh: Mesh;
  label?: Mesh;
  targetHeight: number;
  delay: number;
  isSmall?: boolean;
  labelTargetY?: number;
  labelH?: number;
  isPoint?: boolean;
}

export interface VisAnimData {
  elapsed: number;
  duration: number;
  items: VisAnimItem[];
  complete: boolean;
}

/**
 * Creates an ultra-sharp, tactile vertical label printed onto the face of a 3D bar,
 * or placed above it if the bar is smaller.
 * Zero borders, significantly larger font size for effortless VR legibility.
 */
export function createBarFaceLabel(
  text: string,
  width: number,
  height: number,
): Mesh {
  const canvas = document.createElement('canvas');
  // High-DPI vertical canvas: 512 wide x 1024 tall for razor-sharp legibility in WebXR
  canvas.width = 512;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 512, 1024);

  // Dark translucent rounded pill backing along the vertical bar — NO BORDER
  const padX = 16;
  const padY = 16;
  const r = 32;
  drawCanvasRoundRect(ctx, padX, padY, 512 - padX * 2, 1024 - padY * 2, r);
  ctx.fillStyle = 'rgba(8, 12, 24, 0.88)';
  ctx.fill();

  // Clear, LARGE vertical text:
  // Rotated 90 degrees counter-clockwise so it reads naturally bottom-to-top along the bar
  ctx.save();
  ctx.translate(256, 512);
  ctx.rotate(-Math.PI / 2);

  // High contrast white text with deep shadow
  ctx.shadowColor = 'rgba(0, 0, 0, 1.0)';
  ctx.shadowBlur = 20;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 2;

  // Extra large bold font
  const maxLen = 14;
  const displayText = text.length > maxLen ? text.slice(0, maxLen - 1) + '…' : text;
  let fontSize = 106;
  if (displayText.length > 5) {
    fontSize = Math.max(64, Math.floor(106 * (5 / displayText.length)));
  }
  ctx.font = `900 ${fontSize}px system-ui, -apple-system, sans-serif`;
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(displayText, 0, 0);
  ctx.restore();

  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  const mat = new MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  const geo = new PlaneGeometry(width, height);
  const mesh = new Mesh(geo, mat);
  mesh.renderOrder = 50;
  return mesh;
}

/**
 * Creates a floating high-contrast badge label for a 3D pie slice,
 * displaying the category name, value, and percentage share.
 */
export function createPieSliceLabel(
  category: string,
  valText: string,
  pctText: string,
  colorHex: number,
  width = 0.11,
  height = 0.048,
): Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 224;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 512, 224);

  // Rounded pill background
  const padX = 12;
  const padY = 12;
  drawCanvasRoundRect(ctx, padX, padY, 512 - padX * 2, 224 - padY * 2, 28);
  ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
  ctx.fill();

  // Left accent dot indicator with slice color
  const hexStr = `#${colorHex.toString(16).padStart(6, '0')}`;
  ctx.fillStyle = hexStr;
  ctx.beginPath();
  ctx.arc(46, 76, 16, 0, Math.PI * 2);
  ctx.fill();

  // Category title
  ctx.shadowColor = 'rgba(0, 0, 0, 0.95)';
  ctx.shadowBlur = 10;
  ctx.font = 'bold 44px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const displayCat = category.length > 13 ? category.slice(0, 12) + '…' : category;
  ctx.fillText(displayCat, 76, 76);

  // Value & percentage subtitle
  ctx.font = 'bold 36px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = hexStr;
  ctx.fillText(`${valText} (${pctText})`, 76, 150);

  const texture = new CanvasTexture(canvas);
  texture.needsUpdate = true;
  const mat = new MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });
  const geo = new PlaneGeometry(width, height);
  const mesh = new Mesh(geo, mat);
  mesh.renderOrder = 45;
  return mesh;
}

export function buildVisualizationScene(
  data: DataPayload,
  config: VisConfig,
): Group {
  const root = new Group();
  root.name = 'weavr-visualization-root';

  // 0. Route to 3D Mathematical Concepts Engine if configured
  if (config.chartType === 'math3d' || config.math) {
    const mathConfig: MathConceptConfig = config.math || {
      conceptType: 'pythagoras',
    };
    return buildMathVisualizationScene(mathConfig);
  }

  if (!data || data.headers.length === 0 || data.rows.length === 0) {
    return root;
  }

  // 1. Apply filtering if configured
  let activeRows = data.rows;
  if (config.filterColumn && config.filterValue) {
    const fIdx = data.headers.indexOf(config.filterColumn);
    if (fIdx >= 0) {
      const fValLower = String(config.filterValue).toLowerCase();
      activeRows = data.rows.filter((r) =>
        String(r[fIdx]).toLowerCase().includes(fValLower),
      );
    }
  }

  if (activeRows.length === 0) {
    activeRows = data.rows; // fallback to full data if filter matches nothing
  }

  // Find column indices
  const xIdx = Math.max(0, data.headers.indexOf(config.xAxis));
  const yIdx = Math.max(0, data.headers.indexOf(config.yAxis));
  const zIdx = config.zAxis ? data.headers.indexOf(config.zAxis) : -1;

  const isFlat = config.mode === 'flat' || config.chartType === 'bar2d';

  // Spatial volume bounds in meters (compact tabletop scale)
  const BOUND_W = 0.36; // X axis
  const BOUND_H = 0.24; // Y axis
  const BOUND_D = isFlat ? 0.01 : 0.28; // Z axis

  // 2. Compute min/max for numerical axes
  const getMinMax = (idx: number) => {
    let min = Infinity;
    let max = -Infinity;
    for (const r of activeRows) {
      const val = Number(r[idx]);
      if (!isNaN(val)) {
        if (val < min) min = val;
        if (val > max) max = val;
      }
    }
    if (!isFinite(min) || min === max) {
      min = 0;
      max = max > 0 ? max * 1.2 : 10;
    }
    return { min, max };
  };

  const xStats = data.types[xIdx] === 'number' ? getMinMax(xIdx) : null;
  const yStats = getMinMax(yIdx);
  const zStats = zIdx >= 0 && data.types[zIdx] === 'number' ? getMinMax(zIdx) : null;

  const isPie = config.chartType === 'pie3d';

  // 3. Build Reference Grid & Axes
  const gridGroup = new Group();
  gridGroup.name = 'vis-grid';

  if (isPie && !isFlat) {
    // Circular radial base grid for 3D Pie Chart
    const circlePoints: number[] = [];
    const segs = 48;
    for (let i = 0; i < segs; i++) {
      const a1 = (i / segs) * Math.PI * 2;
      const a2 = ((i + 1) / segs) * Math.PI * 2;
      // Outer subtle ring
      circlePoints.push(Math.cos(a1) * 0.132, 0, Math.sin(a1) * 0.132);
      circlePoints.push(Math.cos(a2) * 0.132, 0, Math.sin(a2) * 0.132);
      // Secondary accent ring
      circlePoints.push(Math.cos(a1) * 0.138, 0, Math.sin(a1) * 0.138);
      circlePoints.push(Math.cos(a2) * 0.138, 0, Math.sin(a2) * 0.138);
    }
    // Radial ticks at 8 compass angles
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2;
      circlePoints.push(Math.cos(ang) * 0.128, 0, Math.sin(ang) * 0.128);
      circlePoints.push(Math.cos(ang) * 0.142, 0, Math.sin(ang) * 0.142);
    }
    const circleGeo = new BufferGeometry();
    circleGeo.setAttribute('position', new Float32BufferAttribute(circlePoints, 3));
    const circleMesh = new LineSegments(
      circleGeo,
      new LineBasicMaterial({ color: new Color(0x38bdf8), transparent: true, opacity: 0.45 }),
    );
    gridGroup.add(circleMesh);

    // Front Title Badge
    const titleBadge = createTextSprite(`${config.yAxis} by ${config.xAxis}`, '#C084FC', 30, 0.28, 0.055, true);
    titleBadge.position.set(0, 0.005, BOUND_D / 2 + 0.02);
    titleBadge.rotation.x = -Math.PI / 4;
    gridGroup.add(titleBadge);
  } else {
    const gridLineMat = new LineBasicMaterial({
      color: new Color(0x334155),
      transparent: true,
      opacity: 0.6,
    });

    const axisLineMat = new LineBasicMaterial({
      color: new Color(0x94a3b8),
      linewidth: 2,
    });

    // Base floor wireframe grid
    const gridPoints: number[] = [];
    const gridDivs = 4;
    for (let i = 0; i <= gridDivs; i++) {
      const f = i / gridDivs;
      const x = -BOUND_W / 2 + f * BOUND_W;
      const z = -BOUND_D / 2 + f * BOUND_D;

      // Line parallel to Z
      gridPoints.push(x, 0, -BOUND_D / 2);
      gridPoints.push(x, 0, BOUND_D / 2);

      // Line parallel to X
      gridPoints.push(-BOUND_W / 2, 0, z);
      gridPoints.push(BOUND_W / 2, 0, z);
    }

    // Vertical back grid (if not flat)
    if (!isFlat) {
      for (let i = 1; i <= gridDivs; i++) {
        const y = (i / gridDivs) * BOUND_H;
        gridPoints.push(-BOUND_W / 2, y, -BOUND_D / 2);
        gridPoints.push(BOUND_W / 2, y, -BOUND_D / 2);
      }
    }

    const gridGeo = new BufferGeometry();
    gridGeo.setAttribute('position', new Float32BufferAttribute(gridPoints, 3));
    const gridMesh = new LineSegments(gridGeo, gridLineMat);
    gridGroup.add(gridMesh);

    // Main Axes Lines
    const axisPoints: number[] = [
      // X Axis
      -BOUND_W / 2, 0, -BOUND_D / 2,
      BOUND_W / 2, 0, -BOUND_D / 2,
      // Y Axis
      -BOUND_W / 2, 0, -BOUND_D / 2,
      -BOUND_W / 2, BOUND_H, -BOUND_D / 2,
    ];

    if (!isFlat) {
      // Z Axis
      axisPoints.push(-BOUND_W / 2, 0, -BOUND_D / 2);
      axisPoints.push(-BOUND_W / 2, 0, BOUND_D / 2);
    }

    const axisGeo = new BufferGeometry();
    axisGeo.setAttribute('position', new Float32BufferAttribute(axisPoints, 3));
    const axisMesh = new LineSegments(axisGeo, axisLineMat);
    gridGroup.add(axisMesh);

    // Axis Floating Labels — large, prominent badges
    const xLabel = createTextSprite(config.xAxis, '#38BDF8', 32, 0.22, 0.055, true);
    xLabel.position.set(0, -0.05, isFlat ? 0.005 : BOUND_D / 2 + 0.04);
    gridGroup.add(xLabel);

    const yLabel = createTextSprite(config.yAxis, '#A78BFA', 32, 0.22, 0.055, true);
    yLabel.position.set(-BOUND_W / 2 - 0.11, BOUND_H / 2, isFlat ? 0.005 : 0);
    gridGroup.add(yLabel);

    if (!isFlat && config.zAxis) {
      const zLabel = createTextSprite(config.zAxis, '#34D399', 32, 0.22, 0.055, true);
      zLabel.position.set(-BOUND_W / 2 - 0.10, 0, 0);
      zLabel.rotation.y = -Math.PI / 4;
      gridGroup.add(zLabel);
    }
  }

  // Center vertically around root (y = 0)
  gridGroup.position.y = -BOUND_H / 2;
  root.add(gridGroup);

  // 4. Render Chart Data Elements
  const dataGroup = new Group();
  dataGroup.name = 'vis-data-points';
  const animItems: VisAnimItem[] = [];

  if (config.chartType === 'scatter3d' && !isFlat) {
    // -----------------------------------------------------------------------
    // 3D Scatter Plot (True 3D Spatial Exploration)
    // -----------------------------------------------------------------------
    const pointGeo = new SphereGeometry(0.007, 14, 10);
    const categoryColors = new Map<string, number>();
    let nextColorIdx = 0;

    for (let i = 0; i < activeRows.length; i++) {
      const row = activeRows[i];

      // Calculate X pos
      let normX = 0.5;
      if (xStats) {
        const vx = Number(row[xIdx]) || 0;
        normX = (vx - xStats.min) / (xStats.max - xStats.min || 1);
      } else {
        normX = (i + 0.5) / activeRows.length;
      }
      const posX = -BOUND_W / 2 + normX * BOUND_W;

      // Calculate Y pos
      const vy = Number(row[yIdx]) || 0;
      const normY = Math.max(0, Math.min(1, (vy - yStats.min) / (yStats.max - yStats.min || 1)));
      const posY = normY * BOUND_H;

      // Calculate Z pos
      let normZ = 0.5;
      if (zStats && zIdx >= 0) {
        const vz = Number(row[zIdx]) || 0;
        normZ = (vz - zStats.min) / (zStats.max - zStats.min || 1);
      } else {
        normZ = 0.5;
      }
      const posZ = -BOUND_D / 2 + normZ * BOUND_D;

      // Determine color by customColors, category, or default palette
      let colorHex = COLOR_PALETTE[i % COLOR_PALETTE.length];
      const catVal = String(row[row.length - 1]);
      const xVal = String(row[xIdx]);

      if (config.customColors) {
        const customMatch =
          config.customColors[xVal] ??
          config.customColors[xVal.toLowerCase()] ??
          config.customColors[catVal] ??
          config.customColors[catVal.toLowerCase()] ??
          config.customColors[String(i)];
        if (customMatch) {
          colorHex = resolveColor(customMatch, colorHex);
        }
      } else if (catVal && isNaN(Number(catVal))) {
        if (!categoryColors.has(catVal)) {
          categoryColors.set(catVal, COLOR_PALETTE[nextColorIdx++ % COLOR_PALETTE.length]);
        }
        colorHex = categoryColors.get(catVal)!;
      }

      const pointMat = new MeshStandardMaterial({
        color: new Color(colorHex),
        emissive: new Color(colorHex),
        emissiveIntensity: 0.4,
        roughness: 0.3,
        metalness: 0.2,
      });

      const sphere = new Mesh(pointGeo, pointMat);
      sphere.position.set(posX, posY, posZ);
      sphere.scale.set(0.0001, 0.0001, 0.0001);
      dataGroup.add(sphere);

      animItems.push({
        mesh: sphere,
        targetHeight: 1,
        delay: i * 0.018,
        isPoint: true,
      });

      // Dropline from point down to base floor for depth perception
      const dropPoints = [posX, 0, posZ, posX, posY, posZ];
      const dropGeo = new BufferGeometry();
      dropGeo.setAttribute('position', new Float32BufferAttribute(dropPoints, 3));
      const dropLine = new LineSegments(
        dropGeo,
        new LineBasicMaterial({ color: colorHex, transparent: true, opacity: 0.3 }),
      );
      dataGroup.add(dropLine);
    }
  } else if (config.chartType === 'bar3d' && !isFlat) {
    // -----------------------------------------------------------------------
    // 3D Bar Chart (Categorical Grid Extrusion with Vertical Face Labels)
    // -----------------------------------------------------------------------
    const count = activeRows.length;
    const barWidth = Math.min(0.052, (BOUND_W / count) * 0.75);
    const barDepth = Math.max(0.038, barWidth);

    for (let i = 0; i < count; i++) {
      const row = activeRows[i];
      const val = Number(row[yIdx]) || 0;
      const normH = Math.max(0.02, (val - yStats.min) / (yStats.max - yStats.min || 1));
      const barHeight = normH * BOUND_H;

      const posX = -BOUND_W / 2 + ((i + 0.5) / count) * BOUND_W;
      const posY = barHeight / 2;
      const posZ = 0;

      const barGeo = new BoxGeometry(barWidth, barHeight, barDepth);
      const catText = String(row[xIdx]);
      let colorHex = COLOR_PALETTE[i % COLOR_PALETTE.length];
      if (config.customColors) {
        const customMatch =
          config.customColors[catText] ??
          config.customColors[catText.toLowerCase()] ??
          config.customColors[String(i)];
        if (customMatch) {
          colorHex = resolveColor(customMatch, colorHex);
        }
      }
      const barMat = new MeshStandardMaterial({
        color: new Color(colorHex),
        emissive: new Color(colorHex),
        emissiveIntensity: 0.35,
        roughness: 0.3,
        metalness: 0.2,
      });

      const barMesh = new Mesh(barGeo, barMat);
      barMesh.position.set(posX, 0.0001, posZ);
      barMesh.scale.y = 0.0001;
      dataGroup.add(barMesh);

      // Large, razor-sharp vertical label on the 3D bar:
      // Placed directly into dataGroup so it is never deformed by barMesh scale
      const labelW = Math.max(0.052, barWidth * 1.15);
      const labelH = Math.max(0.13, labelW * 2.5);
      const isSmall = barHeight < labelH + 0.02;

      const barLabel = createBarFaceLabel(catText, labelW, labelH);
      const labelPosZ = posZ + barDepth / 2 + 0.008;
      let labelTargetY: number;
      if (isSmall) {
        // Bar is smaller -> placed above it
        labelTargetY = barHeight + labelH / 2 + 0.008;
      } else {
        // Bar is tall enough -> written inside it near the bottom
        labelTargetY = labelH / 2 + 0.008;
      }
      barLabel.position.set(posX, 0.0001, labelPosZ);
      barLabel.scale.set(0.0001, 0.0001, 0.0001);
      dataGroup.add(barLabel);

      animItems.push({
        mesh: barMesh,
        label: barLabel,
        targetHeight: barHeight,
        delay: i * 0.05,
        isSmall,
        labelTargetY,
        labelH,
      });
    }
  } else if (config.chartType === 'pie3d' && !isFlat) {
    // -----------------------------------------------------------------------
    // 3D Pie Chart (Beveled Radial Extrusions with Exploded Tactile Slices)
    // -----------------------------------------------------------------------
    const sliceMap = new Map<string, number>();
    for (const row of activeRows) {
      const cat = String(row[xIdx] ?? 'Item').trim();
      const val = Math.max(0, Number(row[yIdx]) || 0);
      sliceMap.set(cat, (sliceMap.get(cat) || 0) + val);
    }

    let entries = Array.from(sliceMap.entries()).filter(([_, val]) => val > 0);
    if (entries.length === 0) {
      entries = Array.from(sliceMap.entries());
    }
    // Limit to 7 slices max (top 6 + Other) so it remains clean and legible in VR
    if (entries.length > 7) {
      entries.sort((a, b) => b[1] - a[1]);
      const top = entries.slice(0, 6);
      const otherVal = entries.slice(6).reduce((sum, e) => sum + e[1], 0);
      if (otherVal > 0) {
        top.push(['Other', otherVal]);
      }
      entries = top;
    }

    const totalVal = entries.reduce((sum, e) => sum + e[1], 0) || 1;
    const pieRadius = 0.118;
    const pieDepth = 0.034;
    const explodeDist = entries.length > 1 ? 0.007 : 0;
    let currentAngle = 0;

    for (let i = 0; i < entries.length; i++) {
      const [catText, val] = entries[i];
      const pct = val / totalVal;
      const spanAngle = pct * Math.PI * 2;
      const startAngle = currentAngle;
      const endAngle = currentAngle + spanAngle;
      const midAngle = startAngle + spanAngle / 2;
      currentAngle = endAngle;

      let colorHex = COLOR_PALETTE[i % COLOR_PALETTE.length];
      if (config.customColors) {
        const customMatch =
          config.customColors[catText] ??
          config.customColors[catText.toLowerCase()] ??
          config.customColors[String(i)];
        if (customMatch) {
          colorHex = resolveColor(customMatch, colorHex);
        }
      }

      // 2D Sector shape in XY plane
      const shape = new Shape();
      shape.moveTo(0, 0);
      shape.absarc(0, 0, pieRadius, startAngle, endAngle, false);
      shape.lineTo(0, 0);

      // Extrude with slight bevel
      const curveSegments = Math.max(8, Math.round(pct * 48));
      const sliceGeo = new ExtrudeGeometry(shape, {
        depth: pieDepth,
        bevelEnabled: true,
        bevelSegments: 2,
        steps: 1,
        bevelSize: 0.002,
        bevelThickness: 0.002,
        curveSegments,
      });

      // Rotate so extrusion depth aligns with vertical Y, lying in horizontal XZ tabletop
      sliceGeo.rotateX(-Math.PI / 2);

      const sliceMat = new MeshStandardMaterial({
        color: new Color(colorHex),
        emissive: new Color(colorHex),
        emissiveIntensity: 0.38,
        roughness: 0.28,
        metalness: 0.18,
      });

      const sliceMesh = new Mesh(sliceGeo, sliceMat);

      // Exploded radial offset
      const offX = Math.cos(midAngle) * explodeDist;
      const offZ = -Math.sin(midAngle) * explodeDist;
      sliceMesh.position.set(offX, 0.002, offZ);
      sliceMesh.scale.set(0.0001, 0.0001, 0.0001);
      dataGroup.add(sliceMesh);

      // Floating 3D label badge placed radially outside the slice
      const valText = Number.isInteger(val) ? String(val) : val.toFixed(1);
      const pctText = `${Math.round(pct * 100)}%`;
      const labelDist = pieRadius + 0.046;
      const labelX = offX + Math.cos(midAngle) * labelDist;
      const labelZ = offZ - Math.sin(midAngle) * labelDist;
      const labelY = pieDepth + 0.015;

      const sliceLabel = createPieSliceLabel(catText, valText, pctText, colorHex);
      sliceLabel.position.set(labelX, labelY, labelZ);
      sliceLabel.rotation.x = -Math.PI / 4;
      sliceLabel.scale.set(0.0001, 0.0001, 0.0001);
      dataGroup.add(sliceLabel);

      animItems.push({
        mesh: sliceMesh,
        label: sliceLabel,
        targetHeight: 1,
        delay: i * 0.05,
        isPoint: true,
      });
    }
  } else {
    // -----------------------------------------------------------------------
    // 2D / Flat Bar Chart (Planar, Highly Readable)
    // -----------------------------------------------------------------------
    const count = activeRows.length;
    const barWidth = Math.min(0.052, (BOUND_W / count) * 0.75);

    for (let i = 0; i < count; i++) {
      const row = activeRows[i];
      const val = Number(row[yIdx]) || 0;
      const normH = Math.max(0.02, (val - yStats.min) / (yStats.max - yStats.min || 1));
      const barHeight = normH * BOUND_H;

      const posX = -BOUND_W / 2 + ((i + 0.5) / count) * BOUND_W;
      const posY = barHeight / 2;
      const posZ = 0.002;

      const barGeo = new BoxGeometry(barWidth, barHeight, 0.004);
      const catText = String(row[xIdx]);
      let colorHex = COLOR_PALETTE[i % COLOR_PALETTE.length];
      if (config.customColors) {
        const customMatch =
          config.customColors[catText] ??
          config.customColors[catText.toLowerCase()] ??
          config.customColors[String(i)];
        if (customMatch) {
          colorHex = resolveColor(customMatch, colorHex);
        }
      }
      const barMat = new MeshStandardMaterial({
        color: new Color(colorHex),
        emissive: new Color(colorHex),
        emissiveIntensity: 0.45,
        roughness: 0.4,
      });

      const barMesh = new Mesh(barGeo, barMat);
      barMesh.position.set(posX, 0.0001, posZ);
      barMesh.scale.y = 0.0001;
      dataGroup.add(barMesh);

      // Large, razor-sharp vertical label on the 2D bar:
      const labelW = Math.max(0.052, barWidth * 1.15);
      const labelH = Math.max(0.13, labelW * 2.5);
      const isSmall = barHeight < labelH + 0.02;

      const barLabel = createBarFaceLabel(catText, labelW, labelH);
      const labelPosZ = posZ + 0.006;
      let labelTargetY: number;
      if (isSmall) {
        labelTargetY = barHeight + labelH / 2 + 0.008;
      } else {
        labelTargetY = labelH / 2 + 0.008;
      }
      barLabel.position.set(posX, 0.0001, labelPosZ);
      barLabel.scale.set(0.0001, 0.0001, 0.0001);
      dataGroup.add(barLabel);

      animItems.push({
        mesh: barMesh,
        label: barLabel,
        targetHeight: barHeight,
        delay: i * 0.05,
        isSmall,
        labelTargetY,
        labelH,
      });
    }
  }

  // Center vertically around root (y = 0)
  dataGroup.position.y = -BOUND_H / 2;
  root.add(dataGroup);

  // Attach animation metadata for animated small to large rising entrance
  root.userData.anim = {
    elapsed: 0,
    duration: 0.65,
    items: animItems,
    complete: false,
  } as VisAnimData;

  return root;
}

// ---------------------------------------------------------------------------
// Export Summarizer
// ---------------------------------------------------------------------------

export function generateExportSummary(data: DataPayload, config?: VisConfig): string {
  if (!data || data.headers.length === 0) return 'No data available to export.';

  const colCount = data.headers.length;
  const rowCount = data.rows.length;
  const numCols = data.headers.filter((_, idx) => data.types[idx] === 'number');

  let summary = `Data Summary: ${rowCount} rows × ${colCount} columns\n`;
  summary += `Numerical Fields: ${numCols.join(', ')}\n`;

  if (config) {
    summary += `Chart Mode: ${config.mode.toUpperCase()} (${config.chartType})\n`;
    summary += `Axes: X=${config.xAxis}, Y=${config.yAxis}${config.zAxis ? `, Z=${config.zAxis}` : ''}\n`;
    if (config.filterColumn && config.filterValue) {
      summary += `Filter: ${config.filterColumn} contains "${config.filterValue}"\n`;
    }
    if (config.chartType === 'pie3d') {
      const xCol = data.headers.indexOf(config.xAxis);
      const yCol = data.headers.indexOf(config.yAxis);
      if (xCol >= 0 && yCol >= 0) {
        const catMap = new Map<string, number>();
        for (const row of data.rows) {
          const cat = String(row[xCol] ?? 'Item').trim();
          const val = Math.max(0, Number(row[yCol]) || 0);
          catMap.set(cat, (catMap.get(cat) || 0) + val);
        }
        const total = Array.from(catMap.values()).reduce((a, b) => a + b, 0) || 1;
        summary += 'Category Breakdown:\n';
        for (const [cat, val] of catMap.entries()) {
          const pct = Math.round((val / total) * 100);
          summary += `  • ${cat}: ${val} (${pct}%)\n`;
        }
      }
    }
  }

  // Calculate simple stats for first numeric column
  const primaryNum = data.headers.find((_, idx) => data.types[idx] === 'number');
  if (primaryNum) {
    const idx = data.headers.indexOf(primaryNum);
    const nums = data.rows.map((r) => Number(r[idx])).filter((v) => !isNaN(v));
    if (nums.length > 0) {
      const sum = nums.reduce((a, b) => a + b, 0);
      const mean = (sum / nums.length).toFixed(2);
      const min = Math.min(...nums);
      const max = Math.max(...nums);
      summary += `Stats for ${primaryNum}: Min=${min}, Max=${max}, Mean=${mean}`;
    }
  }

  return summary;
}

