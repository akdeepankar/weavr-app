/**
 * WorkspaceSystem — creates, destroys and updates node entities
 * in response to WorkflowGraph events.
 *
 * Each node is a Three.js Group with:
 *  - a rounded panel mesh (MeshStandardMaterial)
 *  - a front-face plane with a CanvasTexture for dynamic content
 *  - small spheres for input/output connectors
 *
 * The system subscribes to graph events in init() and reacts by
 * spawning or destroying entities. Canvas textures are redrawn
 * only when the underlying NodeData changes.
 */

import {
  AssetManager,
  Box3,
  CanvasTexture,
  Color,
  createSystem,
  CubicBezierCurve3,
  DistanceGrabbable,
  DoubleSide,
  Grabbed,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  OneHandGrabbable,
  PlaneGeometry,
  Pressed,
  RayInteractable,
  SphereGeometry,
  TubeGeometry,
  UIKitMLAsset,
  Vector3,
  VideoTexture,
} from '@iwsdk/core';
import { WorkflowNode, NodeConnector } from '../weavr-components.js';
import {
  workflowGraph,
  inputPortCount,
  outputPortCount,
  nodeTypeLabel,
  canConnect,
  type NodeData,
  type VisConfig,
  type MathConceptType,
  type ChecklistItem,
  type GraphEvent,
} from '../services/workflow-graph.js';
import { pickAndUploadLocalImage } from '../services/image-uploader.js';
import {
  buildVisualizationScene,
  createTextSprite,
  parseCSV,
  SAMPLE_DATASETS,
  generateExportSummary,
} from '../services/data-visualizer.js';

// ---------------------------------------------------------------------------
// Geometry + material cache (allocated once, shared across nodes)
// ---------------------------------------------------------------------------

const PANEL_W = 0.40;
const PANEL_H = 0.30;
const CONNECTOR_RADIUS = 0.008;

const panelGeometry = new PlaneGeometry(PANEL_W, PANEL_H);
const connectorGeometry = new SphereGeometry(CONNECTOR_RADIUS, 16, 12);

const panelBackMaterial = new MeshStandardMaterial({
  color: new Color(0x12151f),
  roughness: 0.35,
  metalness: 0.25,
  side: DoubleSide,
});

// Sleek luminous white connector ports
const connectorMaterial = new MeshStandardMaterial({
  color: new Color(0xffffff),
  emissive: new Color(0xffffff),
  emissiveIntensity: 0.65,
  roughness: 0.15,
  metalness: 0.2,
});

const connectorInputMaterial = new MeshStandardMaterial({
  color: new Color(0xffffff),
  emissive: new Color(0xffffff),
  emissiveIntensity: 0.65,
  roughness: 0.15,
  metalness: 0.2,
});

// Glowing white drag wire matching connection wire
const dragWireMaterial = new MeshStandardMaterial({
  color: new Color(0xffffff),
  roughness: 0.15,
  metalness: 0.08,
  emissive: new Color(0xffffff),
  emissiveIntensity: 0.85,
});

function easeOutBack(t: number): number {
  const c1 = 1.25;
  const c3 = c1 + 1;
  const tm1 = t - 1;
  return 1 + c3 * tm1 * tm1 * tm1 + c1 * tm1 * tm1;
}

// ---------------------------------------------------------------------------
// Status colours
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, string> = {
  Idle: '#6B7280',
  Queued: '#F59E0B',
  Generating: '#8B5CF6',
  Completed: '#10B981',
  Failed: '#EF4444',
};

const NODE_TYPE_COLORS: Record<string, string> = {
  Text: '#6366F1',
  ImageGen: '#8B5CF6',
  ImageInput: '#06B6D4',
  ImageCombine: '#F59E0B',
  Model3D: '#10B981',
  Data: '#3B82F6',
  Visualize: '#8B5CF6',
  Export: '#059669',
  Checklist: '#10B981',
  Video: '#F43F5E',
};

// ---------------------------------------------------------------------------
// Canvas rendering helpers
// ---------------------------------------------------------------------------

function roundRect(
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
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines = 3,
): void {
  const words = text.split(' ');
  let line = '';
  let lines = 0;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, y + lines * lineHeight);
      line = word;
      lines++;
      if (lines >= maxLines) {
        ctx.fillText(line + '…', x, y + lines * lineHeight);
        return;
      }
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, y + lines * lineHeight);
}

const BACKEND_URL =
  (typeof import.meta !== 'undefined' &&
    (import.meta as any).env?.VITE_WEAVR_API_URL) ||
  'http://localhost:3001';

/** Pre-cached loaded images keyed by URL to avoid reloading. */
const imageCache = new Map<string, HTMLImageElement>();
/** Track in-flight load promises so concurrent requests share the same promise */
const inFlightLoads = new Map<string, Promise<HTMLImageElement>>();

function loadImage(url: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(url);
  if (cached?.complete && cached.naturalWidth > 0) return Promise.resolve(cached);

  const existingPromise = inFlightLoads.get(url);
  if (existingPromise) return existingPromise;

  const promise = (async () => {
    // Generate candidates to try in order
    const candidates: string[] = [];
    if (url.startsWith('/generated/')) {
      // 1. Direct from local dev server with cache-buster
      candidates.push(`${url}?t=${Date.now()}`);
      // 2. Direct from backend proxy (which serves from disk)
      candidates.push(`${BACKEND_URL}${url}?t=${Date.now()}`);
      // 3. Fallback without query params
      candidates.push(url);
      candidates.push(`${BACKEND_URL}${url}`);
    } else if (url.startsWith('http://') || url.startsWith('https://')) {
      // 1. Direct URL
      candidates.push(url);
      // 2. Backend image proxy (bypasses CORS and referrer locks)
      candidates.push(
        `${BACKEND_URL}/api/image-proxy?url=${encodeURIComponent(url)}`,
      );
    } else {
      candidates.push(url);
    }

    // Try candidates across up to 6 retry attempts with backoff
    for (let attempt = 0; attempt < 6; attempt++) {
      for (const candidateSrc of candidates) {
        try {
          const loadedImg = await new Promise<HTMLImageElement | null>(
            (resolve) => {
              const img = new Image();
              if (
                candidateSrc.startsWith('http://') ||
                candidateSrc.startsWith('https://')
              ) {
                img.crossOrigin = 'anonymous';
              }
              const timer = setTimeout(() => {
                img.src = '';
                resolve(null);
              }, 4000);

              img.onload = () => {
                clearTimeout(timer);
                if (img.naturalWidth > 0) {
                  resolve(img);
                } else {
                  resolve(null);
                }
              };
              img.onerror = () => {
                clearTimeout(timer);
                resolve(null);
              };
              img.src = candidateSrc;
            },
          );

          if (loadedImg && loadedImg.naturalWidth > 0) {
            console.log(
              `[WeaVR] Image loaded successfully (${loadedImg.naturalWidth}x${loadedImg.naturalHeight}): ${candidateSrc.slice(0, 60)}`,
            );
            imageCache.set(url, loadedImg);
            inFlightLoads.delete(url);
            return loadedImg;
          }
        } catch {
          /* try next candidate */
        }
      }

      // Wait with backoff before next attempt loop
      await new Promise((r) => setTimeout(r, 250 * Math.pow(1.4, attempt)));
    }

    inFlightLoads.delete(url);
    const emptyImg = new Image();
    return emptyImg;
  })();

  inFlightLoads.set(url, promise);
  return promise;
}

function renderNodeCanvas(
  canvas: HTMLCanvasElement,
  node: NodeData,
  loadedImage?: HTMLImageElement,
  isSelected = false,
  isConnectSource = false,
  isConnectCandidate = false,
): void {
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width;
  const H = canvas.height;
  const pad = 24;
  const r = 24;

  ctx.clearRect(0, 0, W, H);

  // 1. Deep matte obsidian backdrop with minimal vignette
  const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
  bgGrad.addColorStop(0, '#0D1117');
  bgGrad.addColorStop(1, '#080A0E');
  roundRect(ctx, 0, 0, W, H, r);
  ctx.fillStyle = bgGrad;
  ctx.fill();

  // 2. Refined minimal border
  const accentColor = NODE_TYPE_COLORS[node.type] ?? '#6366F1';
  let borderColor = 'rgba(255, 255, 255, 0.08)';
  let borderWidth = 1.5;

  if (isConnectSource) {
    borderColor = '#06B6D4'; // Electric cyan
    borderWidth = 2;
  } else if (isConnectCandidate) {
    borderColor = '#38BDF8'; // Sky cyan
    borderWidth = 2;
  } else if (isSelected) {
    borderColor = '#6366F1'; // Sleek modern indigo
    borderWidth = 2.5;
  }

  ctx.strokeStyle = borderColor;
  ctx.lineWidth = borderWidth;
  ctx.stroke();

  // 3. Minimalist Header
  const headerH = 48;
  ctx.beginPath();
  ctx.moveTo(pad, headerH);
  ctx.lineTo(W - pad, headerH);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Left: Minimal node type label
  ctx.font = '600 11px system-ui, -apple-system, sans-serif';
  ctx.fillStyle = accentColor;
  const typeText = nodeTypeLabel(node.type).toUpperCase();
  ctx.fillText(typeText, pad + 4, 30);

  // Status/Mode Tag: Subtle minimal chips
  if (isConnectSource) {
    roundRect(ctx, pad + 85, 17, 68, 18, 9);
    ctx.fillStyle = 'rgba(6, 182, 212, 0.15)';
    ctx.fill();
    ctx.font = '600 9px system-ui, sans-serif';
    ctx.fillStyle = '#22D3EE';
    ctx.fillText('SOURCE', pad + 99, 29);
  } else if (isConnectCandidate) {
    roundRect(ctx, pad + 85, 17, 62, 18, 9);
    ctx.fillStyle = 'rgba(56, 189, 248, 0.15)';
    ctx.fill();
    ctx.font = '600 9px system-ui, sans-serif';
    ctx.fillStyle = '#7DD3FC';
    ctx.fillText('TARGET', pad + 98, 29);
  } else if (isSelected) {
    roundRect(ctx, pad + 85, 17, 64, 18, 9);
    ctx.fillStyle = 'rgba(99, 102, 241, 0.18)';
    ctx.fill();
    ctx.font = '600 9px system-ui, sans-serif';
    ctx.fillStyle = '#A5B4FC';
    ctx.fillText('ACTIVE', pad + 99, 29);
  }

  // Right: Clean minimal status indicator dot + label
  const statusColor = STATUS_COLORS[node.state] ?? '#64748B';
  const statusText = node.state === 'Completed' ? 'Ready' : node.state;
  ctx.font = '500 11px system-ui, sans-serif';
  const statusW = ctx.measureText(statusText).width;

  ctx.beginPath();
  ctx.arc(W - pad - statusW - 10, 27, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = statusColor;
  ctx.fill();

  ctx.fillStyle = '#94A3B8';
  ctx.fillText(statusText, W - pad - statusW - 2, 30);

  // Content Area
  const contentY = headerH + 16;
  const contentH = H - contentY - pad;
  const contentW = W - pad * 2;

  if (node.state === 'Failed') {
    // Dedicated Failure Screen with clean error details
    roundRect(ctx, pad, contentY, contentW, contentH, 14);
    ctx.fillStyle = 'rgba(38, 14, 20, 0.94)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.7)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.fillStyle = '#EF4444';
    ctx.fillText(
      node.type === 'Model3D'
        ? '❌ Meshy 3D Generation Failed'
        : node.type === 'Video'
          ? '❌ Runway Video Generation Failed'
          : '❌ Generation Failed',
      pad + 24,
      contentY + 45,
    );

    const isCreditError =
      node.error?.includes('402') ||
      node.error?.toLowerCase().includes('credit');

    ctx.font = '15px system-ui, sans-serif';
    ctx.fillStyle = '#FCA5A5';
    wrapText(
      ctx,
      node.error || 'The generation service returned an error.',
      pad + 24,
      contentY + 80,
      contentW - 48,
      22,
      4,
    );

    if (isCreditError) {
      const boxY = contentY + contentH - 72;
      roundRect(ctx, pad + 20, boxY, contentW - 40, 56, 10);
      ctx.fillStyle = 'rgba(239, 68, 68, 0.16)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(239, 68, 68, 0.45)';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.font = 'bold 14px system-ui, sans-serif';
      ctx.fillStyle = '#F87171';
      ctx.fillText('💡 Meshy API issue: check account credits', pad + 32, boxY + 24);
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillStyle = '#FECACA';
      ctx.fillText(
        'Check credits at https://meshy.ai, then tap Run Node to generate.',
        pad + 32,
        boxY + 44,
      );
    }
  } else if (node.state === 'Generating') {
    // Cyberpunk generation screen
    roundRect(ctx, pad, contentY, contentW, contentH, 14);
    ctx.fillStyle = 'rgba(15, 18, 28, 0.85)';
    ctx.fill();
    ctx.strokeStyle =
      node.type === 'Model3D'
        ? 'rgba(16, 185, 129, 0.5)'
        : node.type === 'Video'
          ? 'rgba(244, 63, 94, 0.5)'
          : 'rgba(168, 85, 247, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.fillStyle =
      node.type === 'Model3D'
        ? '#A7F3D0'
        : node.type === 'Video'
          ? '#FDA4AF'
          : '#E9D5FF';
    ctx.fillText(
      node.type === 'Model3D'
        ? '⚡ Reconstructing 3D Mesh with Meshy AI...'
        : node.type === 'Video'
          ? '🎬 Generating Runway Gen-3 Video...'
          : '⚡ Synthesizing with Runway AI...',
      pad + 24,
      contentY + 45,
    );

    if (node.prompt) {
      ctx.font = 'bold 22px system-ui, sans-serif';
      ctx.fillStyle = '#FFFFFF';
      wrapText(
        ctx,
        `"${node.prompt}"`,
        pad + 24,
        contentY + 84,
        contentW - 48,
        30,
        3,
      );
    }

    // High-tech animated progress bar
    const barY = contentY + contentH - 52;
    const barW = contentW - 48;
    roundRect(ctx, pad + 24, barY, barW, 12, 6);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.fill();

    const t = (Date.now() % 2200) / 2200;
    const shimmerW = Math.max(40, barW * t);
    const grad = ctx.createLinearGradient(pad + 24, 0, pad + 24 + shimmerW, 0);
    if (node.type === 'Model3D') {
      grad.addColorStop(0, '#059669');
      grad.addColorStop(0.5, '#10B981');
      grad.addColorStop(1, '#34D399');
    } else if (node.type === 'Video') {
      grad.addColorStop(0, '#E11D48');
      grad.addColorStop(0.5, '#F43F5E');
      grad.addColorStop(1, '#FB7185');
    } else {
      grad.addColorStop(0, '#7C3AED');
      grad.addColorStop(0.5, '#A855F7');
      grad.addColorStop(1, '#38BDF8');
    }
    roundRect(ctx, pad + 24, barY, shimmerW, 12, 6);
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.font = '13px system-ui, sans-serif';
    ctx.fillStyle = '#94A3B8';
    ctx.fillText(
      node.type === 'Model3D'
        ? 'Neural marching cubes & surface texture synthesis'
        : node.type === 'Video'
          ? 'Runway Gen-3 Alpha temporal video diffusion'
          : 'Neural latent diffusion rendering',
      pad + 24,
      barY + 28,
    );
  } else if (
    loadedImage?.complete &&
    loadedImage.naturalWidth > 0 &&
    node.imageUrl
  ) {
    // Rich Image Card Preview
    const imgAspect = loadedImage.naturalWidth / loadedImage.naturalHeight;
    let drawW = contentW;
    let drawH = contentW / imgAspect;
    if (drawH > contentH) {
      drawH = contentH;
      drawW = contentH * imgAspect;
    }
    const drawX = pad + (contentW - drawW) / 2;
    const drawY = contentY + (contentH - drawH) / 2;

    ctx.save();
    roundRect(ctx, drawX, drawY, drawW, drawH, 12);
    ctx.clip();
    ctx.drawImage(loadedImage, drawX, drawY, drawW, drawH);

    // Subtle bottom overlay with prompt
    if (node.prompt) {
      const overlayH = 60;
      const overlayY = drawY + drawH - overlayH;
      const ovGrad = ctx.createLinearGradient(
        0,
        overlayY,
        0,
        overlayY + overlayH,
      );
      ovGrad.addColorStop(0, 'rgba(0, 0, 0, 0)');
      ovGrad.addColorStop(1, 'rgba(0, 0, 0, 0.90)');
      ctx.fillStyle = ovGrad;
      ctx.fillRect(drawX, overlayY, drawW, overlayH);

      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
      ctx.shadowBlur = 6;
      ctx.font = 'bold 18px system-ui, sans-serif';
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(
        node.prompt.slice(0, 55) + (node.prompt.length > 55 ? '...' : ''),
        drawX + 16,
        overlayY + 38,
      );
      ctx.restore();
    }
    ctx.restore();

    roundRect(ctx, drawX, drawY, drawW, drawH, 12);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.stroke();
  } else if (node.type === 'Text') {
    // Text / Prompt node view
    roundRect(ctx, pad, contentY, contentW, contentH, 14);
    ctx.fillStyle = 'rgba(20, 24, 38, 0.85)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(99, 102, 241, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.font = 'bold 44px serif';
    ctx.fillStyle = '#818CF8';
    ctx.fillText('“', pad + 18, contentY + 40);

    ctx.font = 'bold 26px system-ui, sans-serif';
    ctx.fillStyle = '#FFFFFF';
    const textToShow =
      node.prompt || 'Connect to Image Gen to pass this prompt text...';
    wrapText(ctx, textToShow, pad + 40, contentY + 44, contentW - 56, 36, 6);

    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.fillStyle = '#818CF8';
    ctx.fillText('PROMPT OUTPUT ➔', contentW - 90, contentY + contentH - 18);
  } else if (node.imageUrl) {
    // Image URL ready — texture loading into memory
    roundRect(ctx, pad, contentY, contentW, contentH, 14);
    ctx.fillStyle = 'rgba(15, 18, 28, 0.7)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(16, 185, 129, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.fillStyle = '#34D399';
    ctx.fillText('⚡ Rendering Visual Preview...', pad + 24, contentY + 45);

    if (node.prompt) {
      ctx.font = 'bold 22px system-ui, sans-serif';
      ctx.fillStyle = '#FFFFFF';
      wrapText(
        ctx,
        `"${node.prompt}"`,
        pad + 24,
        contentY + 84,
        contentW - 48,
        30,
        3,
      );
    }
  } else if (node.type === 'ImageInput' && !node.imageUrl) {
    // Dedicated Upload Area for ImageInput
    roundRect(ctx, pad, contentY, contentW, contentH, 14);
    ctx.fillStyle = 'rgba(6, 182, 212, 0.08)';
    ctx.fill();
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = 'rgba(6, 182, 212, 0.45)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = 'bold 44px system-ui, sans-serif';
    ctx.fillStyle = '#06B6D4';
    ctx.fillText('📁', pad + 32, contentY + 68);

    ctx.font = 'bold 24px system-ui, sans-serif';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText('Tap to Upload Local Image', pad + 95, contentY + 54);

    ctx.font = '15px system-ui, sans-serif';
    ctx.fillStyle = '#94A3B8';
    ctx.fillText(
      'Select image from device storage (PNG, JPG, WebP)',
      pad + 95,
      contentY + 86,
    );

    // Decorative button shape
    roundRect(ctx, pad + 32, contentY + contentH - 64, 210, 42, 21);
    ctx.fillStyle = 'rgba(6, 182, 212, 0.22)';
    ctx.fill();
    ctx.strokeStyle = '#06B6D4';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.font = 'bold 15px system-ui, sans-serif';
    ctx.fillStyle = '#22D3EE';
    ctx.fillText('CHOOSE FILE ➔', pad + 68, contentY + contentH - 37);
  } else if (node.type === 'Model3D') {
    roundRect(ctx, pad, contentY, contentW, contentH, 14);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.fill();
    ctx.strokeStyle = node.modelUrl ? 'rgba(16, 185, 129, 0.6)' : 'rgba(16, 185, 129, 0.25)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    if (loadedImage?.complete && loadedImage.naturalWidth > 0) {
      // Draw reference preview image thumbnail
      const thumbW = 160;
      const thumbH = 120;
      const thumbX = pad + 20;
      const thumbY = contentY + 24;
      ctx.save();
      roundRect(ctx, thumbX, thumbY, thumbW, thumbH, 10);
      ctx.clip();
      ctx.drawImage(loadedImage, thumbX, thumbY, thumbW, thumbH);
      ctx.restore();
      roundRect(ctx, thumbX, thumbY, thumbW, thumbH, 10);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = 1;
      ctx.stroke();

      const textX = thumbX + thumbW + 24;
      ctx.font = 'bold 22px system-ui, sans-serif';
      ctx.fillStyle = '#34D399';
      ctx.fillText(node.modelUrl ? '📦 3D Model Spawned' : '🔗 Image Reference', textX, contentY + 50);

      ctx.font = '15px system-ui, sans-serif';
      ctx.fillStyle = '#94A3B8';
      ctx.fillText(
        node.modelUrl
          ? 'Grab & move the holographic model in VR!'
          : 'Ready — tap Run to generate 3D mesh',
        textX,
        contentY + 80,
      );

      if (node.prompt) {
        ctx.font = 'italic 14px system-ui, sans-serif';
        ctx.fillStyle = '#CBD5E1';
        wrapText(ctx, `"${node.prompt}"`, textX, contentY + 110, contentW - thumbW - 50, 22, 2);
      }
    } else {
      // No reference image yet
      ctx.font = 'bold 44px system-ui, sans-serif';
      ctx.fillStyle = '#10B981';
      ctx.fillText('📦', pad + 32, contentY + 70);

      ctx.font = 'bold 24px system-ui, sans-serif';
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(node.modelUrl ? '3D Model Ready' : '3D Model Node', pad + 100, contentY + 54);

      ctx.font = '15px system-ui, sans-serif';
      ctx.fillStyle = '#94A3B8';
      ctx.fillText(
        node.modelUrl
          ? '3D GLB model active in VR space'
          : 'Connect an Image or Text node (or use voice)',
        pad + 100,
        contentY + 86,
      );

      if (node.prompt) {
        ctx.font = 'italic 15px system-ui, sans-serif';
        ctx.fillStyle = '#CBD5E1';
        wrapText(ctx, `"${node.prompt}"`, pad + 100, contentY + 114, contentW - 120, 22, 2);
      }
    }

    if (node.modelUrl) {
      // Status pill at the bottom
      roundRect(ctx, pad + 20, contentY + contentH - 48, contentW - 40, 34, 17);
      ctx.fillStyle = 'rgba(16, 185, 129, 0.18)';
      ctx.fill();
      ctx.strokeStyle = '#10B981';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.fillStyle = '#6EE7B7';
      ctx.fillText('✨ MODEL READY — USE CONTROLLER / HAND TO GRAB & MOVE', pad + 38, contentY + contentH - 26);
    }
  } else if (node.type === 'Video') {
    roundRect(ctx, pad, contentY, contentW, contentH, 14);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.fill();
    ctx.strokeStyle = node.videoUrl ? 'rgba(244, 63, 94, 0.7)' : 'rgba(244, 63, 94, 0.3)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    if (loadedImage?.complete && loadedImage.naturalWidth > 0) {
      if (!node.videoUrl) {
        // Draw reference preview image thumbnail
        const thumbW = 160;
        const thumbH = 120;
        const thumbX = pad + 20;
        const thumbY = contentY + 24;
        ctx.save();
        roundRect(ctx, thumbX, thumbY, thumbW, thumbH, 10);
        ctx.clip();
        ctx.drawImage(loadedImage, thumbX, thumbY, thumbW, thumbH);
        ctx.restore();
        roundRect(ctx, thumbX, thumbY, thumbW, thumbH, 10);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.lineWidth = 1;
        ctx.stroke();

        const textX = thumbX + thumbW + 24;
        ctx.font = 'bold 22px system-ui, sans-serif';
        ctx.fillStyle = '#FB7185';
        ctx.fillText('🎬 Image Reference Ready', textX, contentY + 50);

        ctx.font = '15px system-ui, sans-serif';
        ctx.fillStyle = '#94A3B8';
        ctx.fillText(
          'Ready — tap Run or use voice to generate video',
          textX,
          contentY + 80,
        );

        if (node.prompt) {
          ctx.font = 'italic 14px system-ui, sans-serif';
          ctx.fillStyle = '#CBD5E1';
          wrapText(ctx, `"${node.prompt}"`, textX, contentY + 110, contentW - thumbW - 50, 22, 2);
        }
      } else {
        // Draw full-width poster image in the content viewport behind the video
        const posterW = contentW - 40;
        const posterH = contentH - 90;
        const posterX = pad + 20;
        const posterY = contentY + 16;
        ctx.save();
        roundRect(ctx, posterX, posterY, posterW, posterH, 10);
        ctx.clip();
        ctx.drawImage(loadedImage, posterX, posterY, posterW, posterH);
        ctx.restore();
        roundRect(ctx, posterX, posterY, posterW, posterH, 10);
        ctx.strokeStyle = 'rgba(244, 63, 94, 0.4)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    } else {
      ctx.font = 'bold 44px system-ui, sans-serif';
      ctx.fillStyle = '#F43F5E';
      ctx.fillText('🎬', pad + 32, contentY + 70);

      ctx.font = 'bold 24px system-ui, sans-serif';
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(node.videoUrl ? 'Runway Video Ready' : 'Runway Video Node', pad + 100, contentY + 54);

      ctx.font = '15px system-ui, sans-serif';
      ctx.fillStyle = '#94A3B8';
      ctx.fillText(
        node.videoUrl
          ? 'Interactive video player active • Looping in VR'
          : 'Connect an Image node (port 1) or speak voice command',
        pad + 100,
        contentY + 86,
      );

      if (node.prompt) {
        ctx.font = 'italic 15px system-ui, sans-serif';
        ctx.fillStyle = '#CBD5E1';
        wrapText(ctx, `"${node.prompt}"`, pad + 100, contentY + 114, contentW - 120, 22, 2);
      }
    }

    if (node.videoUrl) {
      // High-visibility status pill
      roundRect(ctx, pad + 20, contentY + contentH - 48, contentW - 40, 34, 17);
      ctx.fillStyle = 'rgba(244, 63, 94, 0.18)';
      ctx.fill();
      ctx.strokeStyle = '#F43F5E';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.fillStyle = '#FDA4AF';
      ctx.fillText('▶ RUNWAY GEN-3 ALPHA • 5S VIDEO • TAP CARD TO TOGGLE PLAY', pad + 32, contentY + contentH - 26);
    }
  } else if (node.type === 'Data') {
    // -----------------------------------------------------------------------
    // Data Node Canvas
    // -----------------------------------------------------------------------
    roundRect(ctx, pad, contentY, contentW, contentH, 14);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.9)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.5)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.font = 'bold 36px system-ui, sans-serif';
    ctx.fillStyle = '#3B82F6';
    ctx.fillText('📊', pad + 24, contentY + 54);

    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(node.prompt || 'Tabular Dataset', pad + 80, contentY + 42);

    const rowCount = node.parsedData?.rows.length ?? 0;
    const colCount = node.parsedData?.headers.length ?? 0;

    // Badge showing rows × cols
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillStyle = '#94A3B8';
    ctx.fillText(
      `${rowCount} rows × ${colCount} columns (CSV / Local)`,
      pad + 80,
      contentY + 66,
    );

    // Mini Table Preview
    if (node.parsedData && node.parsedData.headers.length > 0) {
      const tableY = contentY + 86;
      const headers = node.parsedData.headers.slice(0, 4);
      const colW = (contentW - 32) / headers.length;

      // Table Header Row
      roundRect(ctx, pad + 16, tableY, contentW - 32, 28, 6);
      ctx.fillStyle = 'rgba(59, 130, 246, 0.18)';
      ctx.fill();

      ctx.font = 'bold 12px monospace';
      ctx.fillStyle = '#93C5FD';
      headers.forEach((h, idx) => {
        ctx.fillText(h.slice(0, 10), pad + 24 + idx * colW, tableY + 18);
      });

      // Preview 2 data rows
      const previewRows = node.parsedData.rows.slice(0, 2);
      ctx.font = '12px monospace';
      ctx.fillStyle = '#E2E8F0';
      previewRows.forEach((row, rIdx) => {
        const rowY = tableY + 36 + rIdx * 24;
        headers.forEach((_, cIdx) => {
          const val = String(row[cIdx] ?? '');
          ctx.fillText(val.slice(0, 9), pad + 24 + cIdx * colW, rowY + 14);
        });
      });
    }

    // Bottom tip pill
    const pillY = contentY + contentH - 46;
    roundRect(ctx, pad + 16, pillY, contentW - 32, 34, 17);
    ctx.fillStyle = 'rgba(59, 130, 246, 0.15)';
    ctx.fill();
    ctx.strokeStyle = '#3B82F6';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillStyle = '#60A5FA';
    ctx.fillText('💡 TAP NODE TO CYCLE DATASETS (Iris / Financials / Metrics)', pad + 32, pillY + 22);

  } else if (node.type === 'Visualize') {
    // -----------------------------------------------------------------------
    // Visualize Node Canvas
    // -----------------------------------------------------------------------
    roundRect(ctx, pad, contentY, contentW, contentH, 14);
    ctx.fillStyle = 'rgba(24, 16, 42, 0.92)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(139, 92, 246, 0.6)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const cfg = node.visConfig || {
      chartType: 'scatter3d',
      xAxis: 'X Axis',
      yAxis: 'Y Axis',
      zAxis: 'Z Axis',
      mode: '3d',
    };

    if (cfg.math) {
      ctx.font = 'bold 36px system-ui, sans-serif';
      ctx.fillStyle = '#8B5CF6';
      ctx.fillText('📐', pad + 24, contentY + 54);

      ctx.font = 'bold 22px system-ui, sans-serif';
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(cfg.math.title || node.prompt || '3D Math Visualization', pad + 80, contentY + 42);

      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.fillStyle = '#34D399';
      ctx.fillText(`Formula: ${cfg.math.formula || '3D Geometry & Multivariable Theorem'}`, pad + 80, contentY + 66);

      // Detail Box
      const axesY = contentY + 92;
      roundRect(ctx, pad + 16, axesY, contentW - 32, 60, 8);
      ctx.fillStyle = 'rgba(139, 92, 246, 0.12)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(139, 92, 246, 0.3)';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.fillStyle = '#A78BFA';
      ctx.fillText(`Concept: ${cfg.math.conceptType.toUpperCase()}`, pad + 30, axesY + 24);
      ctx.fillStyle = cfg.math.highlightName ? '#F59E0B' : '#94A3B8';
      const hlText = cfg.math.highlightName
        ? `★ Highlight: ${cfg.math.highlightName.toUpperCase()} (${cfg.math.highlightColor || 'active'})`
        : 'Highlight: None';
      ctx.fillText(hlText, pad + 30, axesY + 44);

      // Interactive Prompt Pill
      const pillY = contentY + contentH - 46;
      roundRect(ctx, pad + 16, pillY, contentW - 32, 34, 17);
      ctx.fillStyle = 'rgba(139, 92, 246, 0.2)';
      ctx.fill();
      ctx.strokeStyle = '#8B5CF6';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.font = 'bold 12px system-ui, sans-serif';
      ctx.fillStyle = '#DDD6FE';
      ctx.fillText(
        '📐 TAP: Pythagoras ➔ Cube ➔ Saddle ➔ Unit Circle ➔ Cross Product',
        pad + 32,
        pillY + 22,
      );
      return;
    }

    const isHidden = cfg.mode === 'hidden' || cfg.chartType === 'hidden';

    ctx.font = 'bold 36px system-ui, sans-serif';
    ctx.fillStyle = '#8B5CF6';
    ctx.fillText(isHidden ? '🙈' : cfg.chartType === 'pie3d' ? '🥧' : cfg.mode === 'flat' ? '📄' : '🌐', pad + 24, contentY + 54);

    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.fillStyle = '#FFFFFF';
    const chartTypeName =
      cfg.chartType === 'pie3d'
        ? '3D Pie Chart'
        : cfg.chartType === 'scatter3d'
          ? '3D Scatter Plot'
          : cfg.chartType === 'bar3d'
            ? '3D Bar Chart'
            : cfg.chartType === 'bar2d'
              ? '2D Flat Bar Chart'
              : 'Chart Hidden';
    ctx.fillText(node.prompt || chartTypeName, pad + 80, contentY + 42);

    // Mode & Chart Type Tag
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillStyle = isHidden ? '#F87171' : cfg.mode === 'flat' ? '#38BDF8' : '#C084FC';
    ctx.fillText(
      isHidden
        ? '3D Chart Closed / Hidden from View'
        : cfg.chartType === 'pie3d'
          ? '3D Pie Chart (Beveled Radial Extrusions & Proportions)'
          : cfg.mode === 'flat'
            ? '2D Planar Mode (Zero-distortion Comparative View)'
            : '3D Spatial Depth Mode (Full Multi-Axis Spatial Depth)',
      pad + 80,
      contentY + 66,
    );

    // Axis mapping details
    const axesY = contentY + 92;
    roundRect(ctx, pad + 16, axesY, contentW - 32, 60, 8);
    ctx.fillStyle = 'rgba(139, 92, 246, 0.12)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(139, 92, 246, 0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.fillStyle = '#A78BFA';
    ctx.fillText(`X-Axis: ${cfg.xAxis}`, pad + 30, axesY + 24);
    ctx.fillText(`Y-Axis: ${cfg.yAxis}`, pad + 30, axesY + 44);

    if (cfg.zAxis && cfg.mode !== 'flat') {
      ctx.fillStyle = '#34D399';
      ctx.fillText(`Z-Axis: ${cfg.zAxis}`, pad + contentW / 2 + 10, axesY + 24);
    }
    const filterTxt = cfg.filterColumn ? `${cfg.filterColumn} = "${cfg.filterValue}"` : 'All Rows';
    ctx.fillStyle = '#94A3B8';
    ctx.fillText(`Filter: ${filterTxt}`, pad + contentW / 2 + 10, axesY + 44);

    // Interactive Prompt Pill
    const pillY = contentY + contentH - 46;
    roundRect(ctx, pad + 16, pillY, contentW - 32, 34, 17);
    ctx.fillStyle = isHidden ? 'rgba(239, 68, 68, 0.2)' : 'rgba(139, 92, 246, 0.2)';
    ctx.fill();
    ctx.strokeStyle = isHidden ? '#EF4444' : '#8B5CF6';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillStyle = isHidden ? '#FCA5A5' : '#DDD6FE';
    ctx.fillText(
      isHidden
        ? '👁️ CHART HIDDEN — TAP TO RESTORE 3D VIEW'
        : '✨ TAP: 3D Scatter ➔ 3D Bar ➔ 2D Flat ➔ Close / Hide',
      pad + 32,
      pillY + 22,
    );

  } else if (node.type === 'Export') {
    // -----------------------------------------------------------------------
    // Export Node Canvas
    // -----------------------------------------------------------------------
    roundRect(ctx, pad, contentY, contentW, contentH, 14);
    ctx.fillStyle = 'rgba(10, 30, 24, 0.92)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(16, 185, 129, 0.6)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.font = 'bold 36px system-ui, sans-serif';
    ctx.fillStyle = '#10B981';
    ctx.fillText('💾', pad + 24, contentY + 54);

    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText('Export Terminal', pad + 80, contentY + 42);

    ctx.font = '13px system-ui, sans-serif';
    ctx.fillStyle = '#6EE7B7';
    ctx.fillText('Filtered Dataset & Visualization Spec', pad + 80, contentY + 66);

    // Summary Box
    const boxY = contentY + 86;
    roundRect(ctx, pad + 16, boxY, contentW - 32, 68, 8);
    ctx.fillStyle = 'rgba(16, 185, 129, 0.12)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(16, 185, 129, 0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.font = '12px monospace';
    ctx.fillStyle = '#D1FAE5';
    const lines = (node.exportSummary || 'Connect from Visualize or Data node to inspect export statistics.').split('\n');
    lines.slice(0, 3).forEach((line, lIdx) => {
      ctx.fillText(line.slice(0, 52), pad + 28, boxY + 20 + lIdx * 20);
    });

    // Action button
    const pillY = contentY + contentH - 46;
    roundRect(ctx, pad + 16, pillY, contentW - 32, 34, 17);
    ctx.fillStyle = 'rgba(16, 185, 129, 0.22)';
    ctx.fill();
    ctx.strokeStyle = '#10B981';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillStyle = '#A7F3D0';
    ctx.fillText('📥 TAP NODE TO DOWNLOAD CSV / JSON EXPORT', pad + 38, pillY + 22);

  } else if (node.type === 'Checklist') {
    // -----------------------------------------------------------------------
    // Checklist Node Canvas — Big VR-legible text, 30px checkboxes & clear indicators
    // -----------------------------------------------------------------------
    roundRect(ctx, pad, contentY, contentW, contentH, 14);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(16, 185, 129, 0.45)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const items = node.checklist || [];
    const completedCount = items.filter((it) => it.done).length;
    const totalCount = items.length;
    const pct = totalCount > 0 ? completedCount / totalCount : 0;

    // Header Title & Counter with large bold text
    ctx.font = 'bold 24px system-ui, sans-serif';
    ctx.fillStyle = '#F8FAFC';
    ctx.fillText(node.prompt || 'Project Tasks', pad + 20, contentY + 36);

    ctx.font = 'bold 16px monospace';
    ctx.fillStyle = pct === 1 ? '#34D399' : '#10B981';
    const counterText = pct === 1 ? `${completedCount}/${totalCount} ALL DONE ✓` : `${completedCount}/${totalCount} Completed`;
    const counterW = ctx.measureText(counterText).width;
    ctx.fillText(counterText, pad + contentW - counterW - 20, contentY + 36);

    // Thick prominent progress bar
    const trackY = contentY + 52;
    roundRect(ctx, pad + 20, trackY, contentW - 40, 8, 4);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.fill();

    if (pct > 0) {
      roundRect(ctx, pad + 20, trackY, (contentW - 40) * pct, 8, 4);
      ctx.fillStyle = '#10B981';
      ctx.fill();
    }

    if (items.length === 0) {
      // Empty state on 3D node card
      roundRect(ctx, pad + 20, contentY + 80, contentW - 40, 150, 12);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.font = 'bold 24px system-ui, sans-serif';
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText('No tasks yet', pad + 40, contentY + 130);

      ctx.font = '16px system-ui, sans-serif';
      ctx.fillStyle = '#94A3B8';
      ctx.fillText('Tap card or use Sidebar to add your first objective', pad + 40, contentY + 165);

      roundRect(ctx, pad + 40, contentY + 185, 170, 34, 17);
      ctx.fillStyle = 'rgba(16, 185, 129, 0.2)';
      ctx.fill();
      ctx.strokeStyle = '#10B981';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.font = 'bold 14px system-ui, sans-serif';
      ctx.fillStyle = '#34D399';
      ctx.fillText('+ Add First Task', pad + 58, contentY + 208);
    }

    // Task rows (up to 5 items) with large tap targets and 30px boxes
    const listStartY = trackY + 20;
    const maxItems = Math.min(items.length, 5);
    const rowH = 56;

    for (let i = 0; i < maxItems; i++) {
      const it = items[i];
      const rowY = listStartY + i * rowH;

      // Row background card
      roundRect(ctx, pad + 16, rowY, contentW - 32, 48, 10);
      if (it.done) {
        ctx.fillStyle = 'rgba(16, 185, 129, 0.08)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(16, 185, 129, 0.3)';
        ctx.lineWidth = 1;
        ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.03)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Checkbox box (30x30px)
      const boxSize = 30;
      const boxX = pad + 28;
      const boxY = rowY + 9;
      roundRect(ctx, boxX, boxY, boxSize, boxSize, 6);

      if (it.done) {
        // Checked state: Emerald fill, bright mint border, crisp white checkmark
        ctx.fillStyle = 'rgba(16, 185, 129, 0.35)';
        ctx.fill();
        ctx.strokeStyle = '#10B981';
        ctx.lineWidth = 2.5;
        ctx.stroke();

        // Big checkmark glyph
        ctx.font = 'bold 22px system-ui, sans-serif';
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText('✓', boxX + 6, boxY + 23);

        // Bright pure white text when selected in green (as requested)
        const textX = boxX + 44;
        const textY = rowY + 31;
        ctx.font = 'bold 20px system-ui, sans-serif';
        ctx.fillStyle = '#FFFFFF';
        const itemText = it.text.slice(0, 32);
        ctx.fillText(itemText, textX, textY);

        // Sleek subtle green strikethrough line
        const tw = ctx.measureText(itemText).width;
        ctx.beginPath();
        ctx.moveTo(textX, textY - 6);
        ctx.lineTo(textX + tw, textY - 6);
        ctx.strokeStyle = '#10B981';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // [DONE] pill badge
        const badgeW = 74;
        const badgeX = pad + contentW - badgeW - 32;
        roundRect(ctx, badgeX, rowY + 11, badgeW, 26, 13);
        ctx.fillStyle = 'rgba(16, 185, 129, 0.2)';
        ctx.fill();
        ctx.strokeStyle = '#10B981';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.font = 'bold 12px monospace';
        ctx.fillStyle = '#34D399';
        ctx.fillText('DONE', badgeX + 18, rowY + 28);
      } else {
        // Unchecked state: Empty dark fill, high-contrast white border
        ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
        ctx.lineWidth = 2;
        ctx.stroke();

        // High-contrast white task text
        const textX = boxX + 44;
        const textY = rowY + 31;
        ctx.font = 'bold 20px system-ui, sans-serif';
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(it.text.slice(0, 34), textX, textY);

        // [TODO] pill badge
        const badgeW = 66;
        const badgeX = pad + contentW - badgeW - 32;
        roundRect(ctx, badgeX, rowY + 11, badgeW, 26, 13);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.font = 'bold 12px monospace';
        ctx.fillStyle = '#94A3B8';
        ctx.fillText('TODO', badgeX + 16, rowY + 28);
      }
    }

    if (items.length > 5) {
      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.fillStyle = '#34D399';
      ctx.fillText(`+ ${items.length - 5} more items • Use ▲ / ▼ on Sidebar to Scroll`, pad + 38, listStartY + 5 * rowH + 8);
    }

    // High-visibility footer hint pill
    const pillY = contentY + contentH - 46;
    roundRect(ctx, pad + 16, pillY, contentW - 32, 34, 17);
    ctx.fillStyle = 'rgba(16, 185, 129, 0.14)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(16, 185, 129, 0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.fillStyle = '#A7F3D0';
    ctx.fillText('💡 TAP CARD OR SIDEBAR TO CHECK OFF • VOICE: "ADD TASK ..."', pad + 32, pillY + 22);

  } else {
    // Empty awaiting state
    roundRect(ctx, pad, contentY, contentW, contentH, 14);
    ctx.fillStyle = 'rgba(15, 18, 28, 0.55)';
    ctx.fill();
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);

    if (node.prompt) {
      ctx.font = 'bold 12px system-ui, sans-serif';
      ctx.fillStyle = '#A78BFA';
      ctx.fillText('PROMPT READY', pad + 24, contentY + 36);

      ctx.font = 'bold 24px system-ui, sans-serif';
      ctx.fillStyle = '#FFFFFF';
      wrapText(
        ctx,
        `"${node.prompt}"`,
        pad + 24,
        contentY + 70,
        contentW - 48,
        34,
        3,
      );

      ctx.font = '14px system-ui, sans-serif';
      ctx.fillStyle = '#94A3B8';
      ctx.fillText(
        'Tap Run Node or speak voice command to execute',
        pad + 24,
        contentY + contentH - 24,
      );
    } else {
      ctx.font = 'bold 24px system-ui, sans-serif';
      ctx.fillStyle = '#E2E8F0';
      ctx.fillText('Ready to Generate', pad + 24, contentY + 50);

      ctx.font = '15px system-ui, sans-serif';
      ctx.fillStyle = '#64748B';
      ctx.fillText(
        'Connect a Text node, edit prompt, or speak voice command',
        pad + 24,
        contentY + 85,
      );
    }
  }

  // Minimal port indicators
  ctx.font = '500 9px system-ui, sans-serif';
  const inputs = inputPortCount(node.type);
  ctx.fillStyle = '#64748B';
  if (inputs === 1) {
    ctx.fillText('in', pad + 2, H / 2 + 3);
  } else if (inputs === 2) {
    ctx.fillText(node.type === 'Model3D' || node.type === 'ImageGen' ? 'prompt' : 'in 1', pad + 2, H / 2 - 45);
    ctx.fillText(node.type === 'Model3D' || node.type === 'ImageGen' ? 'ref' : 'in 2', pad + 2, H / 2 + 45);
  } else if (inputs === 3) {
    ctx.fillText('prompt', pad + 2, H / 2 - 58);
    ctx.fillText('ref 1', pad + 2, H / 2 + 3);
    ctx.fillText('ref 2', pad + 2, H / 2 + 65);
  }

  const outputs = outputPortCount(node.type);
  if (outputs > 0) {
    ctx.fillText('out', W - pad - 16, H / 2 + 3);
  }
}

// ---------------------------------------------------------------------------
// Node entity factory
// ---------------------------------------------------------------------------

interface NodeVisual {
  group: Group;
  canvas: HTMLCanvasElement;
  texture: CanvasTexture;
  backPanel: Mesh;
  frontFace: Mesh;
  loadedImage?: HTMLImageElement;
  lastState: string;
  lastPrompt: string;
  lastImageUrl: string;
  lastVideoUrl?: string;
  lastVisConfig?: string;
  lastParsedData?: any;
  lastModelScale?: number;
  lastModelUrl?: string;
  lastChecklist?: string;
  videoEl?: HTMLVideoElement;
  videoMesh?: Mesh;
  videoTexture?: VideoTexture;
  inputConnectors: Array<{ mesh: Mesh; port: number }>;
  outputConnectors: Array<{ mesh: Mesh; port: number }>;
  connectorEntities?: any[];
}

function createNodeVisual(node: NodeData): NodeVisual {
  const group = new Group();
  group.name = `weavr-node-${node.id}`;

  // Back panel (gives depth to the node)
  const backPanel = new Mesh(panelGeometry, panelBackMaterial);
  backPanel.position.z = -0.004;
  backPanel.castShadow = true;
  group.add(backPanel);

  // Front face with canvas texture
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 576;
  const texture = new CanvasTexture(canvas);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;

  const frontMaterial = new MeshStandardMaterial({
    map: texture,
    transparent: true,
    roughness: 0.5,
    metalness: 0,
  });
  const frontFace = new Mesh(panelGeometry, frontMaterial);
  frontFace.position.z = 0.001;
  group.add(frontFace);

  // For 3D charts and loaded 3D models: hide the 2D background card panels
  if (
    (node.type === 'Visualize' && node.visConfig?.chartType !== 'hidden' && (node.visConfig as any)?.mode !== 'hidden') ||
    (node.type === 'Model3D' && node.modelUrl)
  ) {
    backPanel.visible = false;
    frontFace.visible = false;
  }

  // Input connectors (left side) — placed directly flush on card border
  const inputConnectors: Array<{ mesh: Mesh; port: number }> = [];
  const inputs = inputPortCount(node.type);
  for (let i = 0; i < inputs; i++) {
    const sphere = new Mesh(connectorGeometry, connectorInputMaterial);
    const y = inputs === 1 ? 0 : -((i - (inputs - 1) / 2) * PANEL_H * 0.5);
    sphere.position.set(-PANEL_W / 2, y, 0.002);
    sphere.name = `input-${i}`;
    group.add(sphere);
    inputConnectors.push({ mesh: sphere, port: i });
  }

  // Output connectors (right side) — placed directly flush on card border
  const outputConnectors: Array<{ mesh: Mesh; port: number }> = [];
  const outputs = outputPortCount(node.type);
  for (let i = 0; i < outputs; i++) {
    const sphere = new Mesh(connectorGeometry, connectorMaterial);
    const y = outputs === 1 ? 0 : -((i - (outputs - 1) / 2) * PANEL_H * 0.5);
    sphere.position.set(PANEL_W / 2, y, 0.002);
    sphere.name = `output-${i}`;
    group.add(sphere);
    outputConnectors.push({ mesh: sphere, port: i });
  }

  // Initial canvas render
  renderNodeCanvas(canvas, node);
  texture.needsUpdate = true;

  // Position the group
  group.position.set(...node.position);

  return {
    group,
    canvas,
    texture,
    backPanel,
    frontFace,
    lastState: node.state,
    lastPrompt: node.prompt,
    lastImageUrl: node.imageUrl,
    lastVisConfig: JSON.stringify(node.visConfig),
    lastParsedData: node.parsedData,
    lastModelScale: node.modelScale,
    lastModelUrl: undefined,
    lastVideoUrl: undefined,
    lastChecklist: JSON.stringify(node.checklist),
    inputConnectors,
    outputConnectors,
  };
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

interface DragSession {
  sourceNodeId: string;
  sourcePort: number;
  sourcePos: Vector3;
  currentPos: Vector3;
  curve: CubicBezierCurve3;
  geometry: TubeGeometry;
  mesh: Mesh;
  group: Group;
  entity: any;
  candidateTarget?: {
    nodeId: string;
    port: number;
    pos: Vector3;
    isValid: boolean;
  };
}

export class WorkspaceSystem extends createSystem({
  nodes: { required: [WorkflowNode] },
  clickedNode: { required: [WorkflowNode, Pressed] },
  clickedConnector: { required: [NodeConnector, Pressed] },
  grabbedNodes: { required: [WorkflowNode, Grabbed] },
}) {
  /** Map from nodeId → visual metadata */
  private visuals = new Map<string, NodeVisual>();
  /** Map from nodeId → IWSDK entity */
  private entityMap = new Map<string, unknown>();
  /** Map tracking starting positions when nodes are grabbed to detect placement */
  private grabStartPositions = new Map<string, Vector3>();
  /** Elapsed time for animations */
  private elapsed = 0;
  /** Currently selected node ID, if any */
  private selectedNodeId: string | null = null;

  private setSelectedNodeId(id: string | null): void {
    this.selectedNodeId = id;
    (window as any).__weavrSelectedNodeId = id;
  }
  /** Whether the user clicked "Connect" button on toolbar */
  private connectMode = false;
  /** Source node ID for connect mode */
  private connectSourceId: string | null = null;
  /** Pending output port selected for connection */
  private pendingOutput: { nodeId: string; port: number } | null = null;
  /** Active live pinch/drag wire session */
  private dragSession: DragSession | null = null;
  /** Active interactive 3D model entities spawned in VR */
  private modelEntities = new Map<
    string,
    {
      group: Group;
      entity: any;
      modelScene: Object3D;
      labelMesh?: Mesh;
      baseScale: number;
      center?: Vector3;
      minY?: number;
      maxY?: number;
    }
  >();
  /** Lock set to prevent duplicate concurrent GLTF loads for the same node */
  private loadingModels = new Set<string>();
  /** Active interactive procedural data visualizations spawned in VR */
  private visEntities = new Map<
    string,
    { group: Group; entity: any; visMeshGroup: Group }
  >();
  /** Scratch vectors to avoid per-frame allocations */
  private pointerPos = new Vector3(0, 1.48, -0.95);
  private tempDir = new Vector3();
  private tempVec = new Vector3();
  private lastMousePos = new Vector3(0, 1.48, -0.95);

  init(): void {
    // Select node on click/pinch, or connect if in Connect Mode
    const offNodeClick = this.queries.clickedNode.subscribe('qualify', (entity) => {
      const nodeId = entity.getValue(WorkflowNode, 'nodeId') as string;
      if (!nodeId) return;

      // If in Connect Mode, clicking a second node completes the connection!
      if (this.connectMode && this.connectSourceId) {
        if (nodeId !== this.connectSourceId) {
          const sourceNode = workflowGraph.getNode(this.connectSourceId);
          const targetNode = workflowGraph.getNode(nodeId);
          if (sourceNode && targetNode) {
            let targetPort = 0;
            if (targetNode?.type === 'Video') {
              targetPort = sourceNode.type === 'Text' ? 0 : 1;
            } else if (sourceNode.type === 'Text' && targetNode.type === 'ImageGen') {
              targetPort = 0; // prompt
            } else if (targetNode.type === 'ImageGen') {
              const inConns = workflowGraph.getInputConnections(targetNode.id);
              if (sourceNode.type === 'Text') {
                targetPort = 0;
              } else {
                // Auto-route to next free reference port (REF 1, REF 2, or port 0)
                if (!inConns.some((c) => c.targetPort === 1)) {
                  targetPort = 1;
                } else if (!inConns.some((c) => c.targetPort === 2)) {
                  targetPort = 2;
                } else if (!inConns.some((c) => c.targetPort === 0)) {
                  targetPort = 0;
                } else {
                  targetPort = 1;
                }
              }
            } else if (targetNode.type === 'ImageCombine') {
              const inConns = workflowGraph.getInputConnections(targetNode.id);
              targetPort = inConns.some((c) => c.targetPort === 0) ? 1 : 0;
            } else if (targetNode.type === 'Model3D') {
              targetPort = sourceNode.type === 'Text' ? 0 : 1;
            }

            console.log(
              `[WeaVR] Connected ${sourceNode.type} (${sourceNode.id}) -> ${targetNode.type} (${targetNode.id}) port ${targetPort}`,
            );
            workflowGraph.addConnection(sourceNode.id, 0, targetNode.id, targetPort);
          }
        }
        this.connectMode = false;
        this.connectSourceId = null;
        this.setSelectedNodeId(nodeId); // Target node becomes active selection for running
        this.updateConnectButtonLabel('Connect');
        this.refreshAllVisuals();
        return;
      }

      this.setSelectedNodeId(this.selectedNodeId === nodeId ? null : nodeId);
      this.refreshAllVisuals();

      // If an ImageInput node is clicked, allow picking or replacing image from local storage
      const clickedNode = workflowGraph.getNode(nodeId);
      if (clickedNode?.type === 'Video') {
        const visual = this.visuals.get(nodeId);
        if (visual?.videoEl) {
          if (visual.videoEl.paused) {
            visual.videoEl.play().catch(() => {});
          } else {
            visual.videoEl.pause();
          }
        }
      }
      if (clickedNode?.type === 'ImageInput' && (!clickedNode.imageUrl || this.selectedNodeId === nodeId)) {
        pickAndUploadLocalImage().then((res) => {
          if (res) {
            workflowGraph.updateNode(nodeId, {
              prompt: res.filename,
              imageUrl: res.imageUrl,
              state: 'Completed',
            });
          }
        });
      }
      // If a Data node is clicked, cycle through sample datasets
      if (clickedNode?.type === 'Data' && this.selectedNodeId === nodeId) {
        const datasetKeys = Object.keys(SAMPLE_DATASETS);
        const currentPrompt = clickedNode.prompt || datasetKeys[0];
        const nextIdx = (datasetKeys.indexOf(currentPrompt) + 1) % datasetKeys.length;
        const nextKey = datasetKeys[nextIdx];
        const nextCsv = SAMPLE_DATASETS[nextKey];
        const parsed = parseCSV(nextCsv);
        workflowGraph.updateNode(nodeId, {
          prompt: nextKey,
          csvData: nextCsv,
          parsedData: parsed,
          state: 'Completed',
        });

        // Propagate to downstream connected Visualize nodes
        const outConns = workflowGraph.getOutputConnections(nodeId);
        for (const conn of outConns) {
          const target = workflowGraph.getNode(conn.targetNodeId);
          if (target?.type === 'Visualize') {
            const numHeaders = parsed.headers.filter((_, idx) => parsed.types[idx] === 'number');
            const catHeaders = parsed.headers.filter((_, idx) => parsed.types[idx] === 'string');
            workflowGraph.updateNode(target.id, {
              parsedData: parsed,
              visConfig: {
                chartType: target.visConfig?.chartType || 'scatter3d',
                xAxis: catHeaders[0] || parsed.headers[0] || 'x',
                yAxis: numHeaders[0] || parsed.headers[1] || 'y',
                zAxis: numHeaders[1] || parsed.headers[2],
                mode: target.visConfig?.mode || '3d',
              },
            });
          }
        }
      }

      // When a Visualize node is clicked/pinched, keep its 3D mode intact (no unwanted 2D toggle)
      if (clickedNode?.type === 'Visualize') {
        // Selection is maintained; no chart-mode mutation during pinch/grab
      }

      // If an Export node is clicked, trigger browser download of CSV data
      if (clickedNode?.type === 'Export' && this.selectedNodeId === nodeId) {
        const inNodes = workflowGraph.getInputNodes(nodeId);
        const sourceDataNode = inNodes.find((n) => n.parsedData);
        if (sourceDataNode?.parsedData) {
          const csvLines = [
            sourceDataNode.parsedData.headers.join(','),
            ...sourceDataNode.parsedData.rows.map((r) => r.join(',')),
          ].join('\n');
          const blob = new Blob([csvLines], { type: 'text/csv' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `weavr-export-${Date.now()}.csv`;
          a.click();
          URL.revokeObjectURL(url);
          console.log('[WeaVR Export] Downloaded dataset CSV');
        }
      }

      // If a Checklist node is clicked, toggle the next item
      if (clickedNode?.type === 'Checklist' && this.selectedNodeId === nodeId) {
        const items = clickedNode.checklist || [];
        if (items.length === 0) {
          const newItems: ChecklistItem[] = [
            { id: '1', text: 'Concept & Outline', done: false },
          ];
          workflowGraph.updateNode(nodeId, {
            checklist: newItems,
            state: 'Queued',
          });
        } else {
          const firstPendingIdx = items.findIndex((it) => !it.done);
          let newItems: ChecklistItem[];
          if (firstPendingIdx !== -1) {
            newItems = items.map((it, idx) =>
              idx === firstPendingIdx ? { ...it, done: true } : it,
            );
          } else {
            // All items were completed, reset all to unchecked
            newItems = items.map((it) => ({ ...it, done: false }));
          }
          const allDone = newItems.every((it) => it.done);
          workflowGraph.updateNode(nodeId, {
            checklist: newItems,
            state: allDone ? 'Completed' : 'Queued',
          });
        }
      }
    });
    // When a node is grabbed in XR, record its starting position
    const offGrabQualify = this.queries.grabbedNodes.subscribe('qualify', (entity) => {
      const nodeId = entity.getValue(WorkflowNode, 'nodeId') as string;
      if (!nodeId || !entity.object3D) return;
      this.grabStartPositions.set(nodeId, entity.object3D.position.clone());
    });

    // When released / placed in a new place: replay the rising animation for 3D charts!
    const offGrabDisqualify = this.queries.grabbedNodes.subscribe('disqualify', (entity) => {
      const nodeId = entity.getValue(WorkflowNode, 'nodeId') as string;
      if (!nodeId || !entity.object3D) return;
      const startPos = this.grabStartPositions.get(nodeId);
      const currentPos = entity.object3D.position;
      const moved = !startPos || startPos.distanceTo(currentPos) > 0.01;
      this.grabStartPositions.delete(nodeId);

      const node = workflowGraph.getNode(nodeId);
      if (node) {
        node.position = [currentPos.x, currentPos.y, currentPos.z];
        node.manuallyMoved = true;
        const visual = this.visuals.get(nodeId);
        if (visual && visual.group !== entity.object3D) {
          visual.group.position.copy(currentPos);
        }
        const visItem = this.visEntities.get(nodeId);
        if (visItem && visItem.group !== entity.object3D) {
          visItem.group.position.copy(currentPos);
        }
        const modelItem = this.modelEntities.get(nodeId);
        if (modelItem && modelItem.group !== entity.object3D) {
          modelItem.group.position.copy(currentPos);
        }
      }

      if (node?.type === 'Visualize' && moved) {
        this.triggerRisingAnimation(nodeId);
      }
    });
    this.cleanupFuncs.push(offNodeClick, offGrabQualify, offGrabDisqualify);

    // Drag-and-drop local images from device desktop directly onto spatial workspace
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = async (e: DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (file && file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = async () => {
          const dataUrl = reader.result as string;
          const node = workflowGraph.addNode('ImageInput', file.name);
          try {
            const BACKEND_URL =
              (typeof import.meta !== 'undefined' &&
                (import.meta as any).env?.VITE_WEAVR_API_URL) ||
              'http://localhost:3001';
            const res = await fetch(`${BACKEND_URL}/api/upload-image`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ dataUrl, filename: file.name }),
            });
            if (res.ok) {
              const data = await res.json();
              workflowGraph.updateNode(node.id, {
                imageUrl: data.imageUrl,
                state: 'Completed',
              });
              return;
            }
          } catch {
            // fallback
          }
          workflowGraph.updateNode(node.id, {
            imageUrl: dataUrl,
            state: 'Completed',
          });
        };
        reader.readAsDataURL(file);
      }
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    this.cleanupFuncs.push(() => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    });

    // Toolbar "Connect" button click
    const onToggleConnect = () => {
      if (this.connectMode) {
        this.connectMode = false;
        this.connectSourceId = null;
        this.updateConnectButtonLabel('Connect');
      } else {
        const sourceId = this.selectedNodeId ?? workflowGraph.lastNode()?.id;
        if (!sourceId) {
          console.warn('[WeaVR] Please select a node first to connect!');
          return;
        }
        this.connectMode = true;
        this.connectSourceId = sourceId;
        this.setSelectedNodeId(sourceId);
        this.updateConnectButtonLabel('Pick Target...');
        console.log('[WeaVR] Connect Mode active. Source node:', sourceId, '— click target node to link.');
      }
      this.refreshAllVisuals();
    };
    window.addEventListener('weavr:toggle-connect-mode', onToggleConnect);
    this.cleanupFuncs.push(() =>
      window.removeEventListener('weavr:toggle-connect-mode', onToggleConnect),
    );

    // External select node event (e.g. from intelligent voice agent deduplication)
    const onSelectNode = (e: any) => {
      const nodeId = e.detail?.nodeId;
      if (nodeId) {
        this.setSelectedNodeId(nodeId);
        this.refreshAllVisuals();
      }
    };
    window.addEventListener('weavr:select-node', onSelectNode);
    this.cleanupFuncs.push(() =>
      window.removeEventListener('weavr:select-node', onSelectNode),
    );

    // Connector click & pinch-drag logic
    const offConnectorClick = this.queries.clickedConnector.subscribe('qualify', (entity) => {
      const nodeId = entity.getValue(NodeConnector, 'nodeId') as string;
      const isOutput = entity.getValue(NodeConnector, 'isOutput') as boolean;
      const port = entity.getValue(NodeConnector, 'port') as number;
      if (!nodeId) return;

      if (isOutput) {
        if (this.dragSession) {
          this.cancelDragWire();
        }
        this.startDragWire(nodeId, port);
        console.log('[WeaVR] Started drag wire from output:', nodeId, 'port:', port);
      } else {
        if (this.dragSession) {
          const sourceNode = workflowGraph.getNode(this.dragSession.sourceNodeId);
          const targetNode = workflowGraph.getNode(nodeId);
          if (sourceNode && targetNode && sourceNode.id !== targetNode.id) {
            let targetPort = port;
            if (targetNode?.type === 'Video') {
              targetPort = sourceNode.type === 'Text' ? 0 : 1;
            } else if (targetNode.type === 'ImageGen' && sourceNode.type !== 'Text') {
              const inConns = workflowGraph.getInputConnections(targetNode.id);
              if (inConns.some((c) => c.targetPort === port)) {
                if (!inConns.some((c) => c.targetPort === 1)) targetPort = 1;
                else if (!inConns.some((c) => c.targetPort === 2)) targetPort = 2;
                else if (!inConns.some((c) => c.targetPort === 0)) targetPort = 0;
              }
            }
            if (canConnect(sourceNode.type, targetNode.type, targetPort)) {
              console.log('[WeaVR] Connected', sourceNode.id, '->', targetNode.id, 'port', targetPort);
              workflowGraph.addConnection(
                this.dragSession.sourceNodeId,
                this.dragSession.sourcePort,
                targetNode.id,
                targetPort,
              );
            }
          }
          this.cancelDragWire();
        } else if (this.pendingOutput) {
          const sourceNode = workflowGraph.getNode(this.pendingOutput.nodeId);
          const targetNode = workflowGraph.getNode(nodeId);
          if (sourceNode && targetNode && sourceNode.id !== targetNode.id) {
            let targetPort = port;
            if (targetNode?.type === 'Video') {
              targetPort = sourceNode.type === 'Text' ? 0 : 1;
            } else if (targetNode.type === 'ImageGen' && sourceNode.type !== 'Text') {
              const inConns = workflowGraph.getInputConnections(targetNode.id);
              if (inConns.some((c) => c.targetPort === port)) {
                if (!inConns.some((c) => c.targetPort === 1)) targetPort = 1;
                else if (!inConns.some((c) => c.targetPort === 2)) targetPort = 2;
                else if (!inConns.some((c) => c.targetPort === 0)) targetPort = 0;
              }
            }
            if (canConnect(sourceNode.type, targetNode.type, targetPort)) {
              console.log('[WeaVR] Connected', this.pendingOutput.nodeId, '->', nodeId, 'port', targetPort);
              workflowGraph.addConnection(
                this.pendingOutput.nodeId,
                this.pendingOutput.port,
                nodeId,
                targetPort,
              );
            }
          }
          this.pendingOutput = null;
        }
      }
    });
    this.cleanupFuncs.push(offConnectorClick);

    // Track mouse on desktop canvas
    const onPointerMove = (e: PointerEvent) => {
      const aspect = window.innerWidth / (window.innerHeight || 1);
      const x = ((e.clientX / window.innerWidth) * 2 - 1) * aspect * 1.0;
      const y = (-(e.clientY / window.innerHeight) * 2 + 1) * 0.6 + 1.48;
      this.lastMousePos.set(x, y, -0.95);
    };
    window.addEventListener('pointermove', onPointerMove);
    this.cleanupFuncs.push(() =>
      window.removeEventListener('pointermove', onPointerMove),
    );

    // Release to drop wire
    const onPointerUp = () => {
      if (this.dragSession) {
        if (this.dragSession.candidateTarget?.isValid) {
          const sourceNode = workflowGraph.getNode(this.dragSession.sourceNodeId);
          const targetNode = workflowGraph.getNode(this.dragSession.candidateTarget.nodeId);
          let targetPort = this.dragSession.candidateTarget.port;

          if (targetNode?.type === 'Video') {
            targetPort = sourceNode && sourceNode.type === 'Text' ? 0 : 1;
          } else if (sourceNode && targetNode && targetNode.type === 'ImageGen' && sourceNode.type !== 'Text') {
            const inConns = workflowGraph.getInputConnections(targetNode.id);
            if (inConns.some((c) => c.targetPort === targetPort && c.sourceNodeId !== sourceNode.id) || targetPort === 0) {
              if (!inConns.some((c) => c.targetPort === 1)) targetPort = 1;
              else if (!inConns.some((c) => c.targetPort === 2)) targetPort = 2;
            }
          }

          workflowGraph.addConnection(
            this.dragSession.sourceNodeId,
            this.dragSession.sourcePort,
            this.dragSession.candidateTarget.nodeId,
            targetPort,
          );
        }
        this.cancelDragWire();
      }
    };
    window.addEventListener('pointerup', onPointerUp);
    this.cleanupFuncs.push(() =>
      window.removeEventListener('pointerup', onPointerUp),
    );

    // Toolbar custom events
    const onRunSelected = () => {
      const targetId = this.selectedNodeId ?? workflowGraph.lastNode()?.id;
      if (targetId) {
        window.dispatchEvent(
          new CustomEvent('weavr:execute-single', { detail: { nodeId: targetId } }),
        );
      }
    };
    window.addEventListener('weavr:run-selected', onRunSelected);
    this.cleanupFuncs.push(() =>
      window.removeEventListener('weavr:run-selected', onRunSelected),
    );

    const onDeleteSelected = () => {
      const targetId = this.selectedNodeId ?? workflowGraph.lastNode()?.id ?? null;
      if (targetId) {
        workflowGraph.removeNode(targetId);
      }
    };
    window.addEventListener('weavr:delete-selected', onDeleteSelected);
    this.cleanupFuncs.push(() =>
      window.removeEventListener('weavr:delete-selected', onDeleteSelected),
    );

    // Subscribe to graph events
    const unsubscribe = workflowGraph.subscribe((event: GraphEvent) => {
      this.handleGraphEvent(event);
    });
    this.cleanupFuncs.push(unsubscribe);
  }

  private startDragWire(sourceNodeId: string, sourcePort: number): void {
    const sourceNode = workflowGraph.getNode(sourceNodeId);
    if (!sourceNode) return;

    const outputsCount = outputPortCount(sourceNode.type);
    const portOffsetY =
      outputsCount === 1
        ? 0
        : -((sourcePort - (outputsCount - 1) / 2) * PANEL_H * 0.5);

    const sourcePos = new Vector3(
      sourceNode.position[0] + PANEL_W / 2,
      sourceNode.position[1] + portOffsetY,
      sourceNode.position[2] + 0.002,
    );
    const currentPos = sourcePos.clone().add(new Vector3(0.08, 0, 0));

    const curve = new CubicBezierCurve3(
      sourcePos,
      sourcePos.clone().add(new Vector3(0.2, 0, 0)),
      currentPos.clone().add(new Vector3(-0.2, 0, 0)),
      currentPos,
    );
    const geometry = new TubeGeometry(curve, 28, 0.005, 6, false);
    const mesh = new Mesh(geometry, dragWireMaterial);
    mesh.castShadow = true;
    const group = new Group();
    group.name = 'weavr-drag-wire';
    group.add(mesh);

    const entity = (this.world as any).createTransformEntity(
      group,
      'weavr-drag-wire',
    );

    this.dragSession = {
      sourceNodeId,
      sourcePort,
      sourcePos,
      currentPos,
      curve,
      geometry,
      mesh,
      group,
      entity,
    };
    this.pendingOutput = { nodeId: sourceNodeId, port: sourcePort };
  }

  private cancelDragWire(): void {
    if (this.dragSession) {
      if (this.dragSession.entity?.dispose) {
        this.dragSession.entity.dispose();
      }
      this.dragSession.geometry.dispose();
      this.dragSession.group.removeFromParent();
      this.dragSession = null;
    }
    this.pendingOutput = null;
  }

  private refreshAllVisuals(): void {
    for (const [nodeId, visual] of this.visuals) {
      const node = workflowGraph.getNode(nodeId);
      if (node) {
        const isSelected = nodeId === this.selectedNodeId;
        const isConnectSource = this.connectMode && nodeId === this.connectSourceId;
        const isConnectCandidate = this.connectMode && nodeId !== this.connectSourceId;
        renderNodeCanvas(
          visual.canvas,
          node,
          visual.loadedImage,
          isSelected,
          isConnectSource,
          isConnectCandidate,
        );
        visual.texture.needsUpdate = true;
      }
    }
  }

  private updateConnectButtonLabel(text: string): void {
    const toolbar = this.world.getSceneObject<UIKitMLAsset>(
      'toolbar-panel',
    ) as UIKitMLAsset | null;
    const label = toolbar?.getElementById('connect-label');
    if (label) {
      label.setProperties({ text });
    }
  }

  private handleGraphEvent(event: GraphEvent): void {
    switch (event.kind) {
      case 'nodeAdded':
        this.spawnNode(event.node);
        break;
      case 'nodeRemoved':
        this.despawnNode(event.nodeId);
        break;
      case 'nodeUpdated':
        this.updateNodeVisual(event.node);
        break;
    }
  }

  private spawnNode(node: NodeData): void {
    const visual = createNodeVisual(node);

    // Create IWSDK entity with the visual group
    const entity = (this.world as any).createTransformEntity(
      visual.group,
      `weavr-node-${node.id}`,
    );

    // Add components for interaction
    if (entity.addComponent) {
      entity.addComponent(WorkflowNode);
      entity.setValue(WorkflowNode, 'nodeId', node.id);
      entity.addComponent(RayInteractable);
      entity.addComponent(OneHandGrabbable);
      entity.addComponent(DistanceGrabbable);
    }

    // Spawn connector entities
    const connectorEntities: any[] = [];
    for (const inConn of visual.inputConnectors) {
      const connEnt = (this.world as any).createTransformEntity(
        inConn.mesh,
        `connector-${node.id}-in-${inConn.port}`,
      );
      if (connEnt.addComponent) {
        connEnt.addComponent(NodeConnector);
        connEnt.setValue(NodeConnector, 'nodeId', node.id);
        connEnt.setValue(NodeConnector, 'isOutput', false);
        connEnt.setValue(NodeConnector, 'port', inConn.port);
        connEnt.addComponent(RayInteractable);
      }
      connectorEntities.push(connEnt);
    }

    for (const outConn of visual.outputConnectors) {
      const connEnt = (this.world as any).createTransformEntity(
        outConn.mesh,
        `connector-${node.id}-out-${outConn.port}`,
      );
      if (connEnt.addComponent) {
        connEnt.addComponent(NodeConnector);
        connEnt.setValue(NodeConnector, 'nodeId', node.id);
        connEnt.setValue(NodeConnector, 'isOutput', true);
        connEnt.setValue(NodeConnector, 'port', outConn.port);
        connEnt.addComponent(RayInteractable);
      }
      connectorEntities.push(connEnt);
    }

    visual.connectorEntities = connectorEntities;
    this.visuals.set(node.id, visual);
    this.entityMap.set(node.id, entity);

    if (node.type === 'Video' && node.videoUrl) {
      this.spawnOrUpdateVideo(visual, node);
    }

    if (node.type === 'Model3D' && node.modelUrl) {
      this.spawnOrUpdate3DModel(node);
    }

    if (node.type === 'Visualize') {
      if (node.visConfig?.chartType === 'hidden' || (node.visConfig as any)?.mode === 'hidden') {
        this.despawnVisualization(node.id);
      } else {
        this.spawnOrUpdateVisualization(node);
      }
    }
  }

  private despawnNode(nodeId: string): void {
    this.despawn3DModel(nodeId);
    this.despawnVisualization(nodeId);
    const visual = this.visuals.get(nodeId);
    if (visual?.videoMesh) {
      visual.group.remove(visual.videoMesh);
      if (visual.videoTexture) visual.videoTexture.dispose();
      (visual.videoMesh.material as any)?.dispose();
      visual.videoMesh.geometry.dispose();
      if (visual.videoEl) {
        visual.videoEl.pause();
        visual.videoEl.src = '';
      }
    }
    if (visual?.connectorEntities) {
      for (const ent of visual.connectorEntities) {
        if (ent.dispose) ent.dispose();
      }
    }
    const entity = this.entityMap.get(nodeId) as any;
    if (entity?.dispose) {
      entity.dispose();
    }
    if (visual) {
      visual.texture.dispose();
      visual.group.removeFromParent();
    }
    this.visuals.delete(nodeId);
    this.entityMap.delete(nodeId);
    if (this.selectedNodeId === nodeId) {
      this.setSelectedNodeId(null);
    }
  }

  private updateNodeVisual(node: NodeData): void {
    const visual = this.visuals.get(node.id);
    if (visual == null) return;

    // Sync 3D position if updated programmatically (e.g. auto-align)
    if (
      Math.abs(visual.group.position.x - node.position[0]) > 0.001 ||
      Math.abs(visual.group.position.y - node.position[1]) > 0.001 ||
      Math.abs(visual.group.position.z - node.position[2]) > 0.001
    ) {
      visual.group.position.set(...node.position);
    }

    const visItem = this.visEntities.get(node.id);
    if (visItem) {
      if (
        Math.abs(visItem.group.position.x - node.position[0]) > 0.001 ||
        Math.abs(visItem.group.position.y - node.position[1]) > 0.001 ||
        Math.abs(visItem.group.position.z - node.position[2]) > 0.001
      ) {
        visItem.group.position.set(...node.position);
      }
      const targetScale = node.modelScale ?? 1.0;
      if (Math.abs(visItem.group.scale.x - targetScale) > 0.001) {
        visItem.group.scale.setScalar(targetScale);
      }
    }

    const modelItem = this.modelEntities.get(node.id);
    if (modelItem) {
      if (
        Math.abs(modelItem.group.position.x - node.position[0]) > 0.001 ||
        Math.abs(modelItem.group.position.y - node.position[1]) > 0.001 ||
        Math.abs(modelItem.group.position.z - node.position[2]) > 0.001
      ) {
        modelItem.group.position.set(...node.position);
      }
    }

    const visConfigStr = JSON.stringify(node.visConfig);
    const checklistStr = JSON.stringify(node.checklist);
    const changed =
      visual.lastState !== node.state ||
      visual.lastPrompt !== node.prompt ||
      visual.lastImageUrl !== node.imageUrl ||
      visual.lastVideoUrl !== node.videoUrl ||
      visual.lastModelScale !== node.modelScale ||
      visual.lastModelUrl !== node.modelUrl ||
      (node.type === 'Checklist' && checklistStr !== visual.lastChecklist) ||
      (node.type === 'Visualize' &&
        (visConfigStr !== visual.lastVisConfig ||
          node.parsedData !== visual.lastParsedData));

    if (!changed) return;

    visual.lastChecklist = checklistStr;

    const isSelected = node.id === this.selectedNodeId;
    const isConnectSource = this.connectMode && node.id === this.connectSourceId;
    const isConnectCandidate = this.connectMode && node.id !== this.connectSourceId;

    // Load new image if URL changed or if not yet loaded
    if (
      node.imageUrl &&
      (node.imageUrl !== visual.lastImageUrl ||
        !visual.loadedImage ||
        !visual.loadedImage.complete ||
        visual.loadedImage.naturalWidth === 0)
    ) {
      loadImage(node.imageUrl).then((img) => {
        if (img.naturalWidth > 0) {
          visual.loadedImage = img;
          visual.lastImageUrl = node.imageUrl;
          renderNodeCanvas(
            visual.canvas,
            node,
            img,
            isSelected,
            isConnectSource,
            isConnectCandidate,
          );
          visual.texture.needsUpdate = true;
        }
      });
    }

    visual.lastState = node.state;
    visual.lastPrompt = node.prompt;
    visual.lastVisConfig = visConfigStr;
    visual.lastParsedData = node.parsedData;
    visual.lastModelScale = node.modelScale;
    visual.lastModelUrl = node.modelUrl;
    visual.lastVideoUrl = node.videoUrl;
    if (visual.loadedImage?.naturalWidth) {
      visual.lastImageUrl = node.imageUrl;
    }

    renderNodeCanvas(
      visual.canvas,
      node,
      visual.loadedImage,
      isSelected,
      isConnectSource,
      isConnectCandidate,
    );
    visual.texture.needsUpdate = true;

    if (node.type === 'Model3D' && node.modelUrl) {
      this.spawnOrUpdate3DModel(node);
    }

    if (node.type === 'Video' && node.videoUrl) {
      this.spawnOrUpdateVideo(visual, node);
    }

    if (node.type === 'Visualize') {
      if (node.visConfig?.chartType === 'hidden' || (node.visConfig as any)?.mode === 'hidden') {
        this.despawnVisualization(node.id);
      } else {
        this.spawnOrUpdateVisualization(node);
      }
    }
  }

  private spawnOrUpdateVideo(visual: NodeVisual, node: NodeData): void {
    if (!node.videoUrl) return;
    if (visual.lastVideoUrl === node.videoUrl && visual.videoMesh) return;

    if (visual.videoMesh) {
      visual.group.remove(visual.videoMesh);
      if (visual.videoTexture) visual.videoTexture.dispose();
      (visual.videoMesh.material as any)?.dispose();
      visual.videoMesh.geometry.dispose();
      if (visual.videoEl) {
        visual.videoEl.pause();
        visual.videoEl.src = '';
      }
    }

    try {
      const videoEl = document.createElement('video');
      videoEl.src = node.videoUrl;
      if (
        node.videoUrl.startsWith('http') &&
        !node.videoUrl.startsWith(window.location.origin)
      ) {
        videoEl.crossOrigin = 'anonymous';
      }
      videoEl.loop = true;
      videoEl.muted = true;
      videoEl.playsInline = true;
      videoEl.autoplay = true;
      videoEl.setAttribute('playsinline', '');
      videoEl.setAttribute('webkit-playsinline', '');
      videoEl.setAttribute('muted', '');
      videoEl.preload = 'auto';

      const videoTexture = new VideoTexture(videoEl);
      videoTexture.minFilter = LinearFilter;
      videoTexture.magFilter = LinearFilter;
      videoTexture.generateMipmaps = false;

      // Card is 0.40m wide x 0.30m high. Content viewport is 0.35m x 0.17m
      const screenGeo = new PlaneGeometry(0.35, 0.17);
      const screenMat = new MeshBasicMaterial({
        map: videoTexture,
        side: DoubleSide,
      });
      const screenMesh = new Mesh(screenGeo, screenMat);
      // Sit flush inside the card content bounds
      screenMesh.position.set(0, -0.015, 0.003);
      visual.group.add(screenMesh);

      visual.videoEl = videoEl;
      visual.videoMesh = screenMesh;
      visual.videoTexture = videoTexture;
      visual.lastVideoUrl = node.videoUrl;

      const tryPlay = () => {
        videoTexture.needsUpdate = true;
        videoEl.play().catch((err) => {
          console.warn('[WeaVR Video] Autoplay deferred until interaction:', err);
        });
      };

      videoEl.addEventListener('canplay', tryPlay, { once: true });
      videoEl.addEventListener('loadeddata', () => {
        videoTexture.needsUpdate = true;
      }, { once: true });

      videoEl.load();
      tryPlay();
      console.log(`[WeaVR Video] Successfully spawned active video player for ${node.id} (${node.videoUrl})`);
    } catch (err) {
      console.error('[WeaVR Video] Failed to setup video texture:', err);
    }
  }

  private async spawnOrUpdate3DModel(node: NodeData): Promise<void> {
    if (!node.modelUrl) return;

    // Prevent concurrent load attempts across animation frames
    if (this.loadingModels.has(node.id)) return;

    // If model entity already exists, dynamically update its scale in real-time
    const existing = this.modelEntities.get(node.id);
    if (existing) {
      const userScale = node.modelScale ?? 1.0;
      const targetScale = existing.baseScale * userScale;
      existing.modelScene.scale.setScalar(targetScale);
      if (existing.center && existing.minY != null && existing.maxY != null) {
        existing.modelScene.position.set(
          -existing.center.x * targetScale,
          -existing.minY * targetScale,
          -existing.center.z * targetScale,
        );
        if (existing.labelMesh) {
          const topY = (existing.maxY - existing.minY) * targetScale;
          existing.labelMesh.position.set(0, topY + 0.045, 0);
        }
      }
      console.log(
        `[WeaVR 3D] Real-time scaled model ${node.id} to multiplier ${userScale} (targetScale: ${targetScale.toFixed(4)})`,
      );
      return;
    }

    this.loadingModels.add(node.id);
    try {
      console.log(
        `[WeaVR 3D] Loading GLB model for node ${node.id} from: ${node.modelUrl}`,
      );
      const gltf = await AssetManager.loadGLTF(node.modelUrl);
      if (!gltf || !gltf.scene) {
        console.error('[WeaVR 3D] Failed to load GLTF scene:', node.modelUrl);
        return;
      }

      // If an existing model entity somehow exists, despawn it first to guarantee no duplicate meshes
      if (this.modelEntities.has(node.id)) {
        this.despawn3DModel(node.id);
      }

      const modelScene = gltf.scene;

      const modelGroup = new Group();
      modelGroup.name = `weavr-3d-model-${node.id}`;

      // Calculate bounding box and scale to compact ~0.14m base (tabletop/palm scale, not too big)
      const box = new Box3().setFromObject(modelScene);
      const size = new Vector3();
      box.getSize(size);
      const maxDim = Math.max(size.x, size.y, size.z) || 1;
      const baseScale = 0.14 / maxDim;
      const userScale = node.modelScale ?? 1.0;
      const targetScale = baseScale * userScale;
      modelScene.scale.setScalar(targetScale);

      // Center geometry so base sits on y=0
      const center = new Vector3();
      box.getCenter(center);
      modelScene.position.set(
        -center.x * targetScale,
        -box.min.y * targetScale,
        -center.z * targetScale,
      );

      modelGroup.add(modelScene);

      // Add a large, crisp floating title badge above the 3D model
      const labelText = node.prompt
        ? (node.prompt.length > 28 ? node.prompt.slice(0, 26) + '...' : node.prompt)
        : '3D Hologram';
      const labelMesh = createTextSprite(
        `📦 ${labelText}`,
        '#34D399',
        28,
        0.26,
        0.048,
        true,
      );
      const topY = (box.max.y - box.min.y) * targetScale;
      labelMesh.position.set(0, topY + 0.045, 0);
      modelGroup.add(labelMesh);

      // Hide 2D background card panels for clean floating 3D model
      const visual = this.visuals.get(node.id);
      if (visual) {
        if (visual.backPanel) visual.backPanel.visible = false;
        if (visual.frontFace) visual.frontFace.visible = false;
      }

      // Position directly at node position (no 2D card background)
      modelGroup.position.set(
        node.position[0],
        node.position[1],
        node.position[2],
      );

      const entity = (this.world as any).createTransformEntity(
        modelGroup,
        `weavr-model-${node.id}`,
      );

      if (entity.addComponent) {
        entity.addComponent(RayInteractable);
        entity.addComponent(OneHandGrabbable);
        entity.addComponent(DistanceGrabbable);
      }

      this.modelEntities.set(node.id, {
        group: modelGroup,
        entity,
        modelScene,
        labelMesh,
        baseScale,
        center,
        minY: box.min.y,
        maxY: box.max.y,
      });

      console.log(
        `[WeaVR 3D] Successfully spawned compact interactive 3D model for node ${node.id} (scale: ${targetScale.toFixed(3)})`,
      );
    } catch (err) {
      console.error(
        `[WeaVR 3D] Error loading 3D model for node ${node.id}:`,
        err,
      );
    } finally {
      this.loadingModels.delete(node.id);
    }
  }

  private despawn3DModel(nodeId: string): void {
    this.loadingModels.delete(nodeId);
    const item = this.modelEntities.get(nodeId);
    if (!item) return;
    if (item.entity?.dispose) {
      item.entity.dispose();
    }
    item.group.removeFromParent();
    this.modelEntities.delete(nodeId);

    const visual = this.visuals.get(nodeId);
    if (visual) {
      if (visual.backPanel) visual.backPanel.visible = true;
      if (visual.frontFace) visual.frontFace.visible = true;
    }
  }

  private spawnOrUpdateVisualization(node: NodeData): void {
    // 1. Gather data payload: from node.parsedData, node.csvData, or upstream connected Data node
    let data = node.parsedData;
    if (!data && node.csvData) {
      data = parseCSV(node.csvData);
      node.parsedData = data;
    }
    if (!data) {
      const inNodes = workflowGraph.getInputNodes(node.id);
      const dataNode = inNodes.find((n) => n.parsedData);
      if (dataNode?.parsedData) {
        data = dataNode.parsedData;
      } else {
        data = parseCSV(SAMPLE_DATASETS['Iris Measurements']);
      }
    }

    if (node.visConfig?.chartType === 'hidden' || (node.visConfig as any)?.mode === 'hidden') {
      this.despawnVisualization(node.id);
      return;
    }

    // 2. Ensure valid VisConfig
    const numHeaders = data.headers.filter((_, idx) => data?.types[idx] === 'number');
    const catHeaders = data.headers.filter((_, idx) => data?.types[idx] === 'string');

    const config: VisConfig = node.visConfig || {
      chartType: numHeaders.length >= 3 ? 'scatter3d' : 'bar3d',
      xAxis: catHeaders[0] || data.headers[0] || 'x',
      yAxis: numHeaders[0] || data.headers[1] || 'y',
      zAxis: numHeaders[1] || data.headers[2],
      mode: '3d',
    };

    // 3. Build Three.js procedural visualization scene
    const newScene = buildVisualizationScene(data, config);

    // Ensure 2D background card panels are hidden for clean floating 3D chart
    const visual = this.visuals.get(node.id);
    if (visual) {
      if (visual.backPanel) visual.backPanel.visible = false;
      if (visual.frontFace) visual.frontFace.visible = false;
    }

    const userScale = node.modelScale ?? 1.0;
    const existing = this.visEntities.get(node.id);
    if (existing) {
      existing.group.remove(existing.visMeshGroup);
      existing.visMeshGroup = newScene;
      existing.group.add(newScene);
      existing.group.position.set(
        node.position[0],
        node.position[1],
        node.position[2],
      );
      existing.group.scale.setScalar(userScale);
      return;
    }

    const group = new Group();
    group.name = `weavr-vis-${node.id}`;
    group.add(newScene);

    // Position directly at node position (no 2D card background)
    group.position.set(
      node.position[0],
      node.position[1],
      node.position[2],
    );
    group.scale.setScalar(userScale);

    const entity = (this.world as any).createTransformEntity(
      group,
      `weavr-vis-${node.id}`,
    );

    if (entity.addComponent) {
      entity.addComponent(WorkflowNode);
      entity.setValue(WorkflowNode, 'nodeId', node.id);
      entity.addComponent(RayInteractable);
      entity.addComponent(OneHandGrabbable);
      entity.addComponent(DistanceGrabbable);
    }

    this.visEntities.set(node.id, {
      group,
      entity,
      visMeshGroup: newScene,
    });

    console.log(
      `[WeaVR Vis] Spawned interactive procedural visualization for node ${node.id}`,
    );
  }

  private despawnVisualization(nodeId: string): void {
    const item = this.visEntities.get(nodeId);
    if (!item) return;

    // Dispose all meshes, materials, and textures
    item.group.traverse((child: any) => {
      if (child.geometry?.dispose) {
        child.geometry.dispose();
      }
      if (child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach((m: any) => {
            if (m.map?.dispose) m.map.dispose();
            m.dispose();
          });
        } else {
          if (child.material.map?.dispose) child.material.map.dispose();
          child.material.dispose();
        }
      }
    });

    item.group.removeFromParent();
    if (item.entity?.dispose) {
      item.entity.dispose();
    }
    this.visEntities.delete(nodeId);

    const visual = this.visuals.get(nodeId);
    if (visual) {
      if (visual.backPanel) visual.backPanel.visible = true;
      if (visual.frontFace) visual.frontFace.visible = true;
    }
    console.log(`[WeaVR Vis] Cleaned up and removed visualization for ${nodeId}`);
  }

  private triggerRisingAnimation(nodeId: string): void {
    const visItem = this.visEntities.get(nodeId);
    if (!visItem) return;
    const anim = (visItem.visMeshGroup as any)?.userData?.anim;
    if (anim && anim.items) {
      anim.elapsed = 0;
      anim.complete = false;
      for (const item of anim.items) {
        if (item.isPoint) {
          item.mesh.scale.set(0.0001, 0.0001, 0.0001);
          if (item.label) {
            item.label.scale.set(0.0001, 0.0001, 0.0001);
          }
        } else {
          item.mesh.position.y = 0.0001;
          item.mesh.scale.y = 0.0001;
          if (item.label) {
            item.label.scale.set(0.0001, 0.0001, 0.0001);
          }
        }
      }
      console.log(`[WeaVR Vis] Re-triggered rising animation for node ${nodeId}`);
    }
  }

  update(delta: number): void {
    this.elapsed += delta;

    // Update live drag wire if active
    if (this.dragSession) {
      if (this.player?.raySpaces?.right) {
        this.player.raySpaces.right.updateWorldMatrix(true, false);
        this.player.raySpaces.right.getWorldPosition(this.pointerPos);
        this.tempDir
          .set(0, 0, -1)
          .applyQuaternion(this.player.raySpaces.right.quaternion);
        this.pointerPos.addScaledVector(this.tempDir, 0.6);
      } else {
        this.pointerPos.copy(this.lastMousePos);
      }

      // Proximity snap check against all candidate input connectors
      let closestDist = 0.22;
      let candidate:
        | { nodeId: string; port: number; pos: Vector3; isValid: boolean }
        | undefined;
      const sourceNode = workflowGraph.getNode(this.dragSession.sourceNodeId);

      for (const [otherNodeId, otherVisual] of this.visuals) {
        if (otherNodeId === this.dragSession.sourceNodeId) continue;
        const otherNode = workflowGraph.getNode(otherNodeId);
        if (!otherNode) continue;

        for (const inConn of otherVisual.inputConnectors) {
          inConn.mesh.getWorldPosition(this.tempVec);
          const d = this.pointerPos.distanceTo(this.tempVec);
          if (d < closestDist) {
            closestDist = d;
            let targetPort = inConn.port;
            if (otherNode.type === 'Video') {
              targetPort = sourceNode && sourceNode.type === 'Text' ? 0 : 1;
            } else if (otherNode.type === 'ImageGen' && sourceNode && sourceNode.type !== 'Text') {
              const inConns = workflowGraph.getInputConnections(otherNode.id);
              if (inConns.some((c) => c.targetPort === targetPort && c.sourceNodeId !== sourceNode.id) || targetPort === 0) {
                if (!inConns.some((c) => c.targetPort === 1)) targetPort = 1;
                else if (!inConns.some((c) => c.targetPort === 2)) targetPort = 2;
              }
            }
            const isValid = sourceNode
              ? canConnect(sourceNode.type, otherNode.type, targetPort)
              : false;
            candidate = {
              nodeId: otherNodeId,
              port: targetPort,
              pos: this.tempVec.clone(),
              isValid,
            };
          }
        }
      }

      this.dragSession.candidateTarget = candidate;

      if (candidate) {
        this.dragSession.currentPos.copy(candidate.pos);
        const mat = this.dragSession.mesh.material as MeshStandardMaterial;
        mat.color.setHex(candidate.isValid ? 0x10b981 : 0xef4444);
        mat.emissive.setHex(candidate.isValid ? 0x059669 : 0xb91c1c);
      } else {
        this.dragSession.currentPos.copy(this.pointerPos);
        const mat = this.dragSession.mesh.material as MeshStandardMaterial;
        mat.color.setHex(0x38bdf8);
        mat.emissive.setHex(0x0284c7);
      }

      const dx =
        Math.abs(
          this.dragSession.currentPos.x - this.dragSession.sourcePos.x,
        ) *
          0.5 +
        0.15;
      this.dragSession.curve.v0.copy(this.dragSession.sourcePos);
      this.dragSession.curve.v1.set(
        this.dragSession.sourcePos.x + dx,
        this.dragSession.sourcePos.y,
        this.dragSession.sourcePos.z,
      );
      this.dragSession.curve.v2.set(
        this.dragSession.currentPos.x - dx,
        this.dragSession.currentPos.y,
        this.dragSession.currentPos.z,
      );
      this.dragSession.curve.v3.copy(this.dragSession.currentPos);

      this.dragSession.geometry.dispose();
      this.dragSession.geometry = new TubeGeometry(
        this.dragSession.curve,
        28,
        0.005,
        6,
        false,
      );
      this.dragSession.mesh.geometry = this.dragSession.geometry;
    }

    // Animate generating nodes and ensure completed images are rendered
    const tick500ms =
      Math.floor(this.elapsed * 2) !== Math.floor((this.elapsed - delta) * 2);

    for (const [nodeId, visual] of this.visuals) {
      const node = workflowGraph.getNode(nodeId);
      if (node?.state === 'Generating') {
        renderNodeCanvas(visual.canvas, node, visual.loadedImage);
        visual.texture.needsUpdate = true;
      } else if (
        node?.imageUrl &&
        (!visual.loadedImage ||
          !visual.loadedImage.complete ||
          visual.loadedImage.naturalWidth === 0)
      ) {
        if (tick500ms) {
          loadImage(node.imageUrl).then((img) => {
            if (img.naturalWidth > 0) {
              visual.loadedImage = img;
              visual.lastImageUrl = node.imageUrl;
              renderNodeCanvas(visual.canvas, node, img);
              visual.texture.needsUpdate = true;
            }
          });
        }
      }
    }

    // Check for any Model3D nodes that have modelUrl but haven't spawned yet
    for (const node of workflowGraph.allNodes()) {
      if (
        node.type === 'Model3D' &&
        node.modelUrl &&
        !this.modelEntities.has(node.id) &&
        !this.loadingModels.has(node.id)
      ) {
        this.spawnOrUpdate3DModel(node);
      }
    }

    // Check for any Video nodes that have videoUrl but haven't spawned their video mesh yet
    for (const node of workflowGraph.allNodes()) {
      if (node.type === 'Video' && node.videoUrl) {
        const visual = this.visuals.get(node.id);
        if (visual && (!visual.videoMesh || visual.lastVideoUrl !== node.videoUrl)) {
          this.spawnOrUpdateVideo(visual, node);
        }
      }
    }

    // Keep active video textures rendering smoothly in WebXR
    for (const [, visual] of this.visuals) {
      if (visual.videoEl && visual.videoTexture && !visual.videoEl.paused) {
        visual.videoTexture.needsUpdate = true;
      }
    }

    // Check for any Visualize nodes that haven't spawned their 3D scene yet
    for (const node of workflowGraph.allNodes()) {
      if (node.type === 'Visualize' && !this.visEntities.has(node.id)) {
        this.spawnOrUpdateVisualization(node);
      }
    }

    // Animate 3D chart appearance: rising smoothly from small to large
    for (const [, visItem] of this.visEntities) {
      const anim = (visItem.visMeshGroup as any)?.userData?.anim;
      if (anim && !anim.complete) {
        anim.elapsed += delta;
        let allDone = true;
        for (let i = 0; i < anim.items.length; i++) {
          const item = anim.items[i];
          const localTime = anim.elapsed - item.delay;
          if (localTime <= 0) {
            allDone = false;
            if (item.isPoint) {
              item.mesh.scale.set(0.0001, 0.0001, 0.0001);
              if (item.label) item.label.scale.set(0.0001, 0.0001, 0.0001);
            } else {
              item.mesh.scale.y = 0.0001;
              item.mesh.position.y = 0;
              if (item.label) item.label.scale.set(0.0001, 0.0001, 0.0001);
            }
            continue;
          }

          const progress = Math.min(1.0, localTime / anim.duration);
          if (progress < 1.0) allDone = false;

          const ease = Math.max(0.0001, easeOutBack(progress));

          if (item.isPoint) {
            item.mesh.scale.set(ease, ease, ease);
            if (item.label) {
              const labelProg = Math.max(0, Math.min(1.0, (progress - 0.15) / 0.85));
              const labelScale = easeOutBack(labelProg);
              item.label.scale.set(labelScale, labelScale, labelScale);
            }
          } else {
            const currentH = ease * item.targetHeight;
            item.mesh.position.y = currentH / 2;
            item.mesh.scale.y = ease;

            if (item.label) {
              // Vertical label pops smoothly into view as the bar reaches height
              const labelProg = Math.max(0, Math.min(1.0, (progress - 0.15) / 0.85));
              const labelScale = easeOutBack(labelProg);
              item.label.scale.set(labelScale, labelScale, labelScale);

              const labelH = item.labelH || 0.13;
              if (item.isSmall) {
                item.label.position.y = currentH + labelH / 2 + 0.008;
              } else {
                item.label.position.y = Math.min(currentH * 0.5, item.labelTargetY || (labelH / 2 + 0.008));
              }
            }
          }
        }

        if (allDone) {
          anim.complete = true;
          for (let i = 0; i < anim.items.length; i++) {
            const item = anim.items[i];
            if (item.isPoint) {
              item.mesh.scale.set(1.0, 1.0, 1.0);
              if (item.label) item.label.scale.set(1.0, 1.0, 1.0);
            } else {
              item.mesh.position.y = item.targetHeight / 2;
              item.mesh.scale.y = 1.0;
              if (item.label) {
                item.label.scale.set(1.0, 1.0, 1.0);
                const labelH = item.labelH || 0.13;
                if (item.isSmall) {
                  item.label.position.y = item.targetHeight + labelH / 2 + 0.008;
                } else {
                  item.label.position.y = item.labelTargetY || (labelH / 2 + 0.008);
                }
              }
            }
          }
        }
      }
    }

    // Sync entity positions and scales back to graph when grabbed/moved
    for (const entity of this.queries.nodes.entities) {
      const nodeId = entity.getValue(WorkflowNode, 'nodeId') as string;
      if (!nodeId) continue;
      const obj = entity.object3D;
      if (obj == null) continue;
      const node = workflowGraph.getNode(nodeId);
      if (node == null) continue;

      if (entity.hasComponent(Grabbed)) {
        const pos = obj.position;
        if (
          Math.abs(pos.x - node.position[0]) > 0.002 ||
          Math.abs(pos.y - node.position[1]) > 0.002 ||
          Math.abs(pos.z - node.position[2]) > 0.002
        ) {
          node.position = [pos.x, pos.y, pos.z];
          node.manuallyMoved = true;

          // Keep all associated groups in sync at this position
          const visual = this.visuals.get(nodeId);
          if (visual && visual.group !== obj) {
            visual.group.position.copy(pos);
          }
          const visItem = this.visEntities.get(nodeId);
          if (visItem && visItem.group !== obj) {
            visItem.group.position.copy(pos);
          }
          const modelItem = this.modelEntities.get(nodeId);
          if (modelItem && modelItem.group !== obj) {
            modelItem.group.position.copy(pos);
          }
        }

        // Sync scale if entity scale changed (e.g. via two-hand stretch manipulation)
        if (obj.scale && Math.abs(obj.scale.x - (node.modelScale ?? 1.0)) > 0.02) {
          node.modelScale = obj.scale.x;
        }
      }
    }
  }
}

