/**
 * WeaVR backend proxy — keeps the Runway API key on the server.
 *
 * Run with: npx tsx server/api.ts
 * Requires: RUNWAY_API_KEY environment variable (optional — falls
 *           back to placeholder images when missing).
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

// Automatically load .env if present
try {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [key, ...rest] = trimmed.split('=');
      if (key && rest.length > 0) {
        const val = rest.join('=').trim().replace(/^["']|["']$/g, '');
        if (!process.env[key.trim()]) {
          process.env[key.trim()] = val;
        }
      }
    }
  }
} catch {
  // Ignore .env loading errors
}

const RUNWAY_API_KEY = process.env.RUNWAY_API_KEY ?? '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const MESHY_API_KEY =
  process.env.MESHY_API_KEY ??
  'msy_Xw182r9YvZKUEHxoSYXAB4IrX4otbZVf9WIj';
const RUNWAY_BASE = 'https://api.dev.runwayml.com/v1';
const MESHY_BASE = 'https://api.meshy.ai';
const PORT = parseInt(process.env.PORT ?? '3001', 10);
const PUBLIC_DIR = path.resolve(process.cwd(), 'public');

// Map local cached URLs back to CloudFront URLs for reference-based generation
const urlMap = new Map<string, string>();

// Simple in-memory task cache
const tasks = new Map<
  string,
  { status: string; imageUrl?: string; videoUrl?: string; runwayUrl?: string; error?: string }
>();

interface Task3D {
  status: 'processing' | 'completed' | 'failed';
  modelUrl?: string;
  previewUrl?: string;
  error?: string;
  note?: string;
}

const tasks3d = new Map<string, Task3D>();

function cors(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(
  res: http.ServerResponse,
  status: number,
  data: unknown,
): void {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => resolve(body));
  });
}

function placeholderUrl(prompt: string): string {
  const seed = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40);
  return `https://picsum.photos/seed/${seed}/512/384`;
}

function detectMimeType(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return 'image/png';
  }
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return 'image/png';
}

async function handleGenerate(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  let prompt = 'a beautiful scene';
  let imageRefs: string[] = [];
  try {
    const parsed = JSON.parse(body);
    prompt = parsed.prompt ?? prompt;
    imageRefs = parsed.imageRefs ?? [];
  } catch {
    /* use defaults */
  }

  if (!RUNWAY_API_KEY) {
    // Mock: return a placeholder after a short delay
    const taskId = `mock-${Date.now()}`;
    tasks.set(taskId, { status: 'completed', imageUrl: placeholderUrl(prompt) });
    json(res, 200, {
      taskId,
      status: 'completed',
      imageUrl: placeholderUrl(prompt),
    });
    return;
  }

  try {
    const payload: Record<string, unknown> = {
      model: 'gen4_image',
      promptText: prompt,
      ratio: '1024:1024',
    };

    if (imageRefs.length > 0) {
      // Map local URLs (like /generated/xxx.png) back to CloudFront URLs or base64 data URIs
      payload.referenceImages = imageRefs
        .map((uri) => {
          if (typeof uri !== 'string') return { uri: '' };
          if (uri.startsWith('data:image/')) return { uri };
          if (urlMap.has(uri)) return { uri: urlMap.get(uri)! };

          if (uri.startsWith('/generated/')) {
            for (const t of tasks.values()) {
              if (t.imageUrl === uri && t.runwayUrl) return { uri: t.runwayUrl };
            }
            // Read local file from disk and convert to Base64 data URI
            const filePath = path.join(PUBLIC_DIR, uri.replace(/^\//, ''));
            if (fs.existsSync(filePath)) {
              const fileBuf = fs.readFileSync(filePath);
              const mime = detectMimeType(fileBuf);
              const b64 = `data:${mime};base64,${fileBuf.toString('base64')}`;
              urlMap.set(uri, b64);
              return { uri: b64 };
            }
          }
          return { uri };
        })
        .filter(
          (ref) =>
            typeof ref.uri === 'string' &&
            (ref.uri.startsWith('http') || ref.uri.startsWith('data:image/')),
        );
      console.log(
        `[WeaVR Runway] Prepared ${payload.referenceImages.length} reference image(s):`,
        payload.referenceImages.map((r: any) =>
          r.uri.startsWith('data:') ? `data:image/... (${r.uri.length} chars)` : r.uri.slice(0, 60),
        ),
      );
    }

    const apiRes = await fetch(`${RUNWAY_BASE}/text_to_image`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RUNWAY_API_KEY}`,
        'Content-Type': 'application/json',
        'X-Runway-Version': '2024-11-06',
      },
      body: JSON.stringify(payload),
    });

    const data = (await apiRes.json()) as Record<string, unknown>;

    if (!apiRes.ok || !data.id) {
      console.error('[WeaVR Runway API Error]', data);
      const errMsg =
        (data.error as string) ||
        (data.message as string) ||
        JSON.stringify(data);
      json(res, apiRes.status || 400, {
        status: 'failed',
        error: errMsg,
      });
      return;
    }

    const taskId = data.id as string;
    tasks.set(taskId, { status: 'processing' });
    json(res, 200, { taskId, status: 'processing' });

    // Start polling Runway in the background
    pollRunwayTask(taskId);
  } catch (err) {
    console.error('[WeaVR API Exception]', err);
    json(res, 500, { status: 'failed', error: String(err) });
  }
}

async function pollRunwayTask(taskId: string): Promise<void> {
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const apiRes = await fetch(`${RUNWAY_BASE}/tasks/${taskId}`, {
        headers: {
          Authorization: `Bearer ${RUNWAY_API_KEY}`,
          'X-Runway-Version': '2024-11-06',
        },
      });
      const data = (await apiRes.json()) as Record<string, unknown>;
      const status = data.status as string;

      if (status === 'SUCCEEDED') {
        const output = (data.output as string[]) ?? [];
        const imageUrl = output[0] ?? '';
        console.log(`[WeaVR Runway] Task ${taskId} succeeded → ${imageUrl}`);

        let servedUrl = imageUrl;
        try {
          const genDir = path.join(PUBLIC_DIR, 'generated');
          if (!fs.existsSync(genDir)) {
            fs.mkdirSync(genDir, { recursive: true });
          }
          const imgFetch = await fetch(imageUrl);
          if (imgFetch.ok) {
            const buf = Buffer.from(await imgFetch.arrayBuffer());
            const outPath = path.join(genDir, `${taskId}.png`);
            fs.writeFileSync(outPath, buf);
            servedUrl = `/generated/${taskId}.png`;
            console.log(`[WeaVR Cache] Cached image to ${servedUrl}`);
            urlMap.set(servedUrl, imageUrl);
          }
        } catch (downloadErr) {
          console.warn('[WeaVR Cache] Could not download image locally:', downloadErr);
        }

        tasks.set(taskId, {
          status: 'completed',
          imageUrl: servedUrl,
          runwayUrl: imageUrl,
        });
        return;
      }
      if (status === 'FAILED') {
        const errorMsg = (data.failure as string) ?? 'Generation failed';
        console.error(`[WeaVR Runway] Task ${taskId} failed:`, errorMsg);
        tasks.set(taskId, {
          status: 'failed',
          error: errorMsg,
        });
        return;
      }
    } catch (err) {
      console.warn(`[WeaVR Runway] Polling task ${taskId} error:`, err);
    }
  }
  tasks.set(taskId, { status: 'failed', error: 'Polling timed out' });
}

async function handleGenerateVideo(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  let prompt = 'a cinematic video clip with dynamic camera motion';
  let imageUrl = '';
  let duration = 5;

  try {
    const parsed = JSON.parse(body);
    prompt = parsed.prompt ?? prompt;
    imageUrl = parsed.imageUrl ?? '';
    duration = Number(parsed.duration) === 10 ? 10 : 5;
  } catch {
    /* defaults */
  }

  if (!RUNWAY_API_KEY) {
    const taskId = `mock-vid-${Date.now()}`;
    const sampleVideo = '/sample-video.mp4';
    tasks.set(taskId, {
      status: 'completed',
      videoUrl: sampleVideo,
    });
    json(res, 200, {
      taskId,
      status: 'completed',
      videoUrl: sampleVideo,
    });
    return;
  }

  try {
    let promptImageUri = imageUrl;
    if (imageUrl) {
      if (urlMap.has(imageUrl)) {
        promptImageUri = urlMap.get(imageUrl)!;
      } else if (imageUrl.startsWith('/generated/')) {
        for (const t of tasks.values()) {
          if (t.imageUrl === imageUrl && t.runwayUrl) {
            promptImageUri = t.runwayUrl;
            break;
          }
        }
        if (!promptImageUri || promptImageUri.startsWith('/generated/')) {
          const filePath = path.join(PUBLIC_DIR, imageUrl.replace(/^\//, ''));
          if (fs.existsSync(filePath)) {
            const fileBuf = fs.readFileSync(filePath);
            const mime = detectMimeType(fileBuf);
            promptImageUri = `data:${mime};base64,${fileBuf.toString('base64')}`;
          }
        }
      } else if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
        if (!imageUrl.includes('runwayml.com') && !imageUrl.includes('cloudfront.net')) {
          try {
            const imgRes = await fetch(imageUrl);
            if (imgRes.ok) {
              const fileBuf = Buffer.from(await imgRes.arrayBuffer());
              const mime = detectMimeType(fileBuf);
              promptImageUri = `data:${mime};base64,${fileBuf.toString('base64')}`;
            }
          } catch (fetchErr) {
            console.warn('[WeaVR Runway Video] Could not download image URL to base64:', fetchErr);
          }
        }
      }
    }

    const isImageToVideo = Boolean(promptImageUri);
    const endpoint = isImageToVideo
      ? `${RUNWAY_BASE}/image_to_video`
      : `${RUNWAY_BASE}/text_to_video`;

    const payload: Record<string, unknown> = {
      model: isImageToVideo ? 'gen4_turbo' : 'gen4.5',
      promptText: prompt,
      duration,
      ratio: '1280:720',
    };

    if (isImageToVideo) {
      payload.promptImage = promptImageUri;
    }

    console.log(`[WeaVR Runway Video] Sending task to Runway (${isImageToVideo ? 'gen4_turbo' : 'gen4.5'}):`, {
      endpoint,
      prompt,
      hasImage: isImageToVideo,
      duration,
    });

    const apiRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RUNWAY_API_KEY}`,
        'Content-Type': 'application/json',
        'X-Runway-Version': '2024-11-06',
      },
      body: JSON.stringify(payload),
    });

    const data = (await apiRes.json()) as Record<string, unknown>;

    if (!apiRes.ok || !data.id) {
      console.error('[WeaVR Runway Video API Error]', data);
      const errMsg =
        (data.error as string) ||
        (data.message as string) ||
        JSON.stringify(data);
      json(res, apiRes.status || 400, {
        status: 'failed',
        error: errMsg,
      });
      return;
    }

    const taskId = data.id as string;
    tasks.set(taskId, { status: 'processing' });
    json(res, 200, { taskId, status: 'processing' });

    pollRunwayVideoTask(taskId);
  } catch (err) {
    console.error('[WeaVR Runway Video Exception]', err);
    json(res, 500, { status: 'failed', error: String(err) });
  }
}

async function pollRunwayVideoTask(taskId: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const apiRes = await fetch(`${RUNWAY_BASE}/tasks/${taskId}`, {
        headers: {
          Authorization: `Bearer ${RUNWAY_API_KEY}`,
          'X-Runway-Version': '2024-11-06',
        },
      });
      const data = (await apiRes.json()) as Record<string, unknown>;
      const status = data.status as string;

      if (status === 'SUCCEEDED') {
        const output = (data.output as string[]) ?? [];
        const videoUrl = output[0] ?? '';
        console.log(`[WeaVR Runway Video] Task ${taskId} succeeded → ${videoUrl}`);

        let servedUrl = videoUrl;
        try {
          const genDir = path.join(PUBLIC_DIR, 'generated');
          if (!fs.existsSync(genDir)) {
            fs.mkdirSync(genDir, { recursive: true });
          }
          const vidFetch = await fetch(videoUrl);
          if (vidFetch.ok) {
            const buf = Buffer.from(await vidFetch.arrayBuffer());
            const outPath = path.join(genDir, `${taskId}.mp4`);
            fs.writeFileSync(outPath, buf);
            servedUrl = `/generated/${taskId}.mp4`;
            console.log(`[WeaVR Cache] Cached video to ${servedUrl}`);
            urlMap.set(servedUrl, videoUrl);
          }
        } catch (downloadErr) {
          console.warn('[WeaVR Cache] Could not download video locally:', downloadErr);
        }

        tasks.set(taskId, {
          status: 'completed',
          videoUrl: servedUrl,
          runwayUrl: videoUrl,
        });
        return;
      }
      if (status === 'FAILED') {
        const errorMsg = (data.failure as string) ?? 'Video generation failed';
        console.error(`[WeaVR Runway Video] Task ${taskId} failed:`, errorMsg);
        tasks.set(taskId, {
          status: 'failed',
          error: errorMsg,
        });
        return;
      }
    } catch (err) {
      console.warn(`[WeaVR Runway Video] Polling task ${taskId} error:`, err);
    }
  }
  tasks.set(taskId, { status: 'failed', error: 'Video generation timed out' });
}

const MODEL_CATEGORIES: Array<{ keywords: RegExp; file: string; label: string }> = [
  { keywords: /\b(box|cube|crate|package|parcel|carton|cardboard|chest)\b/i, file: 'box.glb', label: 'Cardboard Box' },
  { keywords: /\b(flower|rose|tulip|daisy|sunflower|blossom|petal|flora)\b/i, file: 'flower.glb', label: 'Vibrant Flower' },
  { keywords: /\b(cake|birthday|pastry|bakery|dessert|sweet|cupcake|pie|tart)\b/i, file: 'cake.glb', label: '3-Tier Birthday Cake' },
  { keywords: /\b(car|sports\s*car|ferrari|auto|vehicle|race|truck|speed)\b/i, file: 'car.glb', label: 'Sports Supercar' },
  { keywords: /\b(robot|droid|mech|cyborg|android|ai|biped)\b/i, file: 'robot.glb', label: 'Cybernetic Robot' },
  { keywords: /\b(donut|doughnut|bagel)\b/i, file: 'donut.glb', label: 'Glazed Donut' },
  { keywords: /\b(crystal|gem|diamond|jewel|ruby|emerald|sapphire|ore|mineral)\b/i, file: 'crystal.glb', label: 'Glowing Crystal' },
  { keywords: /\b(ball|sphere|orb|globe|planet)\b/i, file: 'ball.glb', label: 'Orb Sphere' },
  { keywords: /\b(table|desk|counter|stand|bench)\b/i, file: 'table.glb', label: 'Table' },
  { keywords: /\b(sword|blade|dagger|weapon|knife|katana|saber)\b/i, file: 'sword.glb', label: 'Knight Blade' },
  { keywords: /\b(rocket|spaceship|space|shuttle|ufo|starship|craft)\b/i, file: 'rocket.glb', label: 'Sci-Fi Rocket' },
  { keywords: /\b(chair|seat|sofa|couch|stool|furniture|armchair)\b/i, file: 'chair.glb', label: 'Designer Armchair' },
  { keywords: /\b(tree|forest|wood|woods|pine|oak|bush)\b/i, file: 'tree.glb', label: 'Evergreen Tree' },
  { keywords: /\b(house|home|building|cabin|cottage|architecture|villa)\b/i, file: 'house.glb', label: 'Stylized House' },
  { keywords: /\b(bike|bicycle|cycling|cycle)\b/i, file: 'bike.glb', label: 'Carbon Bicycle' },
  { keywords: /\b(camera|photo|lens|photograph|vintage|steampunk)\b/i, file: 'camera.glb', label: 'Vintage Camera' },
  { keywords: /\b(mug|coffee|cup|tea|drink|espresso)\b/i, file: 'mug.glb', label: 'Coffee Mug' },
  { keywords: /\b(boombox|radio|speaker|music|audio|stereo)\b/i, file: 'boombox.glb', label: 'Boombox Stereo' },
  { keywords: /\b(duck|rubber\s*duck)\b/i, file: 'duck.glb', label: 'Yellow Duck' },
];

function selectBestModel(prompt: string, imageUrl = ''): { file: string; label: string } {
  const query = `${prompt} ${imageUrl}`.toLowerCase();
  for (const cat of MODEL_CATEGORIES) {
    if (cat.keywords.test(query)) {
      return { file: cat.file, label: cat.label };
    }
  }

  const defaultList = ['box.glb', 'cake.glb', 'crystal.glb', 'robot.glb', 'car.glb', 'ball.glb'];
  let hash = 0;
  for (let i = 0; i < query.length; i++) {
    hash = (hash << 5) - hash + query.charCodeAt(i);
    hash |= 0;
  }
  const chosen = defaultList[Math.abs(hash) % defaultList.length];
  const cat = MODEL_CATEGORIES.find((c) => c.file === chosen);
  return { file: chosen, label: cat?.label || '3D Model' };
}

function useSmartModel(taskId: string, prompt = '', imageUrl = '', note?: string): void {
  const best = selectBestModel(prompt, imageUrl);
  const modelSrc = path.join(PUBLIC_DIR, 'models', best.file);
  const targetName = `model-${taskId}.glb`;
  const targetPath = path.join(PUBLIC_DIR, 'generated', targetName);

  const genDir = path.join(PUBLIC_DIR, 'generated');
  if (!fs.existsSync(genDir)) {
    fs.mkdirSync(genDir, { recursive: true });
  }

  if (fs.existsSync(modelSrc)) {
    fs.copyFileSync(modelSrc, targetPath);
    console.log(`[WeaVR 3D] Selected 3D asset "${best.label}" (${best.file}) for prompt: "${prompt}"`);
  } else {
    const fallbackDuck = path.join(PUBLIC_DIR, 'models', 'duck.glb');
    if (fs.existsSync(fallbackDuck)) {
      fs.copyFileSync(fallbackDuck, targetPath);
    }
  }

  tasks3d.set(taskId, {
    status: 'completed',
    modelUrl: `/generated/${targetName}`,
    note: note || `Synthesized ${best.label} for "${prompt || '3D model'}"`,
  });
  console.log(`[WeaVR 3D] Ready model: /generated/${targetName} [${best.label}]`);
}

async function pollMeshyTask(
  taskId: string,
  meshyTaskId: string,
  mode: 'text' | 'image',
): Promise<void> {
  const pollUrl =
    mode === 'text'
      ? `${MESHY_BASE}/openapi/v2/text-to-3d/${meshyTaskId}`
      : `${MESHY_BASE}/openapi/v1/image-to-3d/${meshyTaskId}`;

  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const res = await fetch(pollUrl, {
        headers: { Authorization: `Bearer ${MESHY_API_KEY}` },
      });
      const data = (await res.json()) as any;
      const status = data?.status;

      if (status === 'SUCCEEDED') {
        const modelUrl = data.model_urls?.glb || data.model_url || '';
        const previewUrl = data.thumbnail_url || '';
        console.log(`[WeaVR Meshy] Task ${meshyTaskId} succeeded! Downloading GLB: ${modelUrl}`);

        let servedModelUrl = `/generated/model-${meshyTaskId}.glb`;
        try {
          const genDir = path.join(PUBLIC_DIR, 'generated');
          if (!fs.existsSync(genDir)) {
            fs.mkdirSync(genDir, { recursive: true });
          }
          const glbFetch = await fetch(modelUrl);
          if (glbFetch.ok) {
            const buf = Buffer.from(await glbFetch.arrayBuffer());
            const outPath = path.join(genDir, `model-${meshyTaskId}.glb`);
            fs.writeFileSync(outPath, buf);
            console.log(`[WeaVR Cache] Cached 3D model to ${servedModelUrl} (${buf.length} bytes)`);
          }
        } catch (downloadErr) {
          console.warn('[WeaVR Meshy] Could not download GLB locally, using remote URL:', downloadErr);
          servedModelUrl = modelUrl;
        }

        tasks3d.set(taskId, {
          status: 'completed',
          modelUrl: servedModelUrl,
          previewUrl,
        });
        return;
      }

      if (status === 'FAILED') {
        const errorMsg = data.task_error?.message || data.message || 'Meshy 3D generation failed';
        console.error(`[WeaVR Meshy] Task ${meshyTaskId} failed:`, errorMsg);
        tasks3d.set(taskId, {
          status: 'failed',
          error: `Meshy 3D Task Failed: ${errorMsg}`,
        });
        return;
      }
    } catch (err) {
      console.warn(`[WeaVR Meshy] Polling task ${meshyTaskId} error:`, err);
    }
  }
  tasks3d.set(taskId, {
    status: 'failed',
    error: 'Meshy 3D generation timed out after 3.5 minutes',
  });
}

async function executeMeshyTextToModel(
  taskId: string,
  prompt: string,
): Promise<void> {
  if (!MESHY_API_KEY) {
    tasks3d.set(taskId, {
      status: 'failed',
      error: 'Meshy API key not configured',
    });
    return;
  }

  try {
    console.log(`[WeaVR Meshy] Submitting text-to-model task to Meshy API (prompt: "${prompt}")...`);
    const genRes = await fetch(`${MESHY_BASE}/openapi/v2/text-to-3d`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MESHY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mode: 'preview',
        prompt,
        art_style: 'realistic',
        should_remesh: true,
      }),
    });

    const genData = (await genRes.json()) as any;
    console.log('[WeaVR Meshy Text API Response]:', genData);

    const meshyTaskId = genData?.result;
    if (!meshyTaskId) {
      const errMsg = `Meshy API Error: ${genData?.message || JSON.stringify(genData)}`;
      console.warn(`[WeaVR Meshy] ${errMsg}`, genData);
      tasks3d.set(taskId, {
        status: 'failed',
        error: errMsg,
      });
      return;
    }

    console.log(`[WeaVR Meshy] Task created: ${meshyTaskId}. Polling for completion...`);
    pollMeshyTask(taskId, meshyTaskId, 'text');
  } catch (err) {
    console.error('[WeaVR Meshy Text-to-Model Exception]', err);
    tasks3d.set(taskId, {
      status: 'failed',
      error: `Meshy Connection Error: ${String(err)}`,
    });
  }
}

async function executeMeshyImageToModel(
  taskId: string,
  imageUrl: string,
  prompt: string,
): Promise<void> {
  if (!MESHY_API_KEY) {
    tasks3d.set(taskId, {
      status: 'failed',
      error: 'Meshy API key not configured',
    });
    return;
  }

  try {
    let resolvedImageUrl = '';

    // Handle base64 data URLs directly (Meshy supports data:image/png;base64,... natively)
    if (imageUrl.startsWith('data:image/')) {
      resolvedImageUrl = imageUrl;
    } else if (imageUrl.startsWith('/')) {
      // Local server file -> convert to base64 data URI so Meshy can process it
      const diskPath = path.join(
        PUBLIC_DIR,
        imageUrl.replace(/^\//, '').split('?')[0],
      );
      if (fs.existsSync(diskPath)) {
        const buffer = fs.readFileSync(diskPath);
        const ext = path.extname(diskPath).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        resolvedImageUrl = `data:${mime};base64,${buffer.toString('base64')}`;
        console.log(`[WeaVR Meshy] Converted local image ${diskPath} to base64 data URI (${buffer.length} bytes)`);
      }
    } else if (imageUrl.startsWith('http')) {
      resolvedImageUrl = imageUrl;
    }

    if (!resolvedImageUrl) {
      if (prompt && prompt !== '3D model') {
        console.log('[WeaVR Meshy] No image resolved, routing to Meshy text-to-model API');
        executeMeshyTextToModel(taskId, prompt);
      } else {
        tasks3d.set(taskId, {
          status: 'failed',
          error: 'Could not resolve image for Meshy API and no text prompt provided',
        });
      }
      return;
    }

    console.log(`[WeaVR Meshy] Submitting image-to-model task to Meshy API...`);
    const genRes = await fetch(`${MESHY_BASE}/openapi/v1/image-to-3d`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MESHY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        image_url: resolvedImageUrl,
        enable_pbr: true,
        should_remesh: true,
      }),
    });

    const genData = (await genRes.json()) as any;
    console.log('[WeaVR Meshy Image API Response]:', genData);

    const meshyTaskId = genData?.result;
    if (!meshyTaskId) {
      const errMsg = `Meshy API Error: ${genData?.message || JSON.stringify(genData)}`;
      console.warn(`[WeaVR Meshy] ${errMsg}`, genData);
      tasks3d.set(taskId, {
        status: 'failed',
        error: errMsg,
      });
      return;
    }

    console.log(`[WeaVR Meshy] Task created: ${meshyTaskId}. Polling for completion...`);
    pollMeshyTask(taskId, meshyTaskId, 'image');
  } catch (err) {
    console.error('[WeaVR Meshy Exception]', err);
    tasks3d.set(taskId, {
      status: 'failed',
      error: `Meshy Connection Error: ${String(err)}`,
    });
  }
}

async function handleGenerate3D(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  let imageUrl = '';
  let prompt = '';
  try {
    const parsed = JSON.parse(body);
    imageUrl = parsed.imageUrl ?? '';
    prompt = parsed.prompt ?? '';
  } catch {
    /* defaults */
  }

  if (!imageUrl && !prompt) {
    json(res, 400, { error: 'imageUrl or prompt required' });
    return;
  }

  const taskId = `meshy-${Date.now()}`;
  tasks3d.set(taskId, { status: 'processing' });
  json(res, 200, { taskId, status: 'processing' });

  if (imageUrl) {
    executeMeshyImageToModel(taskId, imageUrl, prompt || '3D model');
  } else {
    executeMeshyTextToModel(taskId, prompt);
  }
}

async function handleAssistant(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  let payload: any = {};
  try {
    payload = JSON.parse(body);
  } catch {
    json(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const { transcript, nodes = [], connections = [], selectedNodeId } = payload;
  if (!transcript || typeof transcript !== 'string') {
    json(res, 400, { error: 'Transcript required' });
    return;
  }

  if (!OPENAI_API_KEY) {
    json(res, 503, { error: 'OpenAI API key not configured' });
    return;
  }

  const systemPrompt = `You are WeaVR Spatial Assistant, an expert AI workflow architect for Meta Quest in mixed reality.
The user speaks natural voice commands in spatial XR to create, connect, modify, and execute generative AI workflows, 3D asset generation, and spatial data visualizations.
Image generation uses Runway Gen-4 AI. 3D Model generation uses Meshy AI (supporting both Image-to-3D and Text-to-3D).
Data visualization uses an offline procedural Three.js engine for interactive 3D and 2D charts in VR.

### ABSOLUTE SPEECH & CONVERSATIONAL RULES:
- NEVER read aloud raw CSV rows, coordinates, code blocks, or JSON syntax.
- The "explanation" field must be a short, natural 1-sentence plain English confirmation (e.g. "I created your 3D bar chart for EV sales." or "I've added that task to your checklist.").
- NEVER mention JSON, parameters, column names, format layouts, raw CSV data, coordinates, or code blocks in the explanation.

### Node Types & Port Specifications:
1. "Text": Holds editable text prompt.
   - Output port 0: prompt text.
2. "ImageGen": Generates high-fidelity images with Runway AI.
   - Input port 0: prompt text from a Text node (or reference image).
   - Input port 1: reference image 1 from upstream ImageGen, ImageInput, or ImageCombine.
   - Input port 2: reference image 2 from upstream ImageGen, ImageInput, or ImageCombine.
   - Output port 0: generated image.
3. "ImageCombine": Blends two images into a new synthesis.
   - Input port 0: First image.
   - Input port 1: Second image.
   - Output port 0: Combined image.
4. "ImageInput": Imported local or desktop image.
   - Output port 0: image.
5. "Model3D": Reconstructs an interactive 3D model (GLB) via Meshy AI that spawns in VR for the user to hold, rotate, and move.
   - Input port 0: prompt text from a Text node (for direct Text-to-3D generation).
   - Input port 1: reference image from ImageGen, ImageInput, or ImageCombine (for Image-to-3D generation).
   - Can also run standalone with its own prompt.
6. "Visualize": Standalone offline procedural 3D & 2D data visualization engine (3D Scatter Plots, 3D Bar Charts, 2D Flat comparative charts). Spawns interactive grabbable visualizations in VR. It is completely self-contained (no separate Data node needed!). It embeds its own dataset and specialized chart configuration.
   - Input port 0: optional upstream text/CSV data stream.
   - Output port 0: visualization specification to Export node.
7. "Export": Terminal node for inspecting dataset summary statistics and downloading CSV exports.
   - Input port 0: from Visualize node.
8. "Checklist": Interactive task checklist card in VR where users can track steps, add items, and mark tasks as completed.
   - Input port 0: optional prompt text from a Text node (converts comma/newline separated tasks into checklist items).
   - Output port 0: triggers downstream workflows upon task completion.
9. "Video": Generates cinematic video using Runway Gen-3 Alpha (supporting both Image-to-Video and Text-to-Video).
   - Input port 0: optional prompt text from a Text node.
   - Input port 1: reference image from an ImageGen, ImageInput, or ImageCombine node.
   - Output port 0: video stream.

### Valid Connection Rules:
- Text (port 0) -> Checklist (port 0) [converts text items into checklist tasks]
- Text (port 0) -> ImageGen (port 0) [passes text prompt]
- Text (port 0) -> Video (port 0) [passes motion prompt]
- Text (port 0) -> Model3D (port 0) [passes text prompt for direct Text-to-3D]
- Text (port 0) -> Visualize (port 0) [passes custom CSV data string]
- ImageGen / ImageInput / ImageCombine (port 0) -> Video (port 1) [passes reference image for Runway Image-to-Video!]
- ImageGen / ImageInput / ImageCombine (port 0) -> ImageGen (port 1 or 2) [passes reference image 1 or reference image 2 — two images can connect to one ImageGen node as references for generation!]
- ImageGen / ImageInput / ImageCombine (port 0) -> ImageCombine (port 0 or 1) [passes images to combine]
- ImageGen / ImageInput / ImageCombine (port 0) -> Model3D (port 1) [passes reference image for Image-to-3D]
- Visualize (port 0) -> Export (port 0) [passes visualization dataset to export]

### Deep Reasoning Guidelines (Think Step-by-Step):
1. **Analyze User Intent & Context**:
   - Inspect currentNodes in the workspace. Notice what is already completed, generating, or selected.
   - **DATA VISUALIZATION & SPECIALIZED CHARTS**:
     - Whenever the user asks to visualize data, see charts, or asks ANY informational / factual query with data or charts (e.g. "show me smartphone market share", "compare tech giant market caps in 3D", "visualize planet sizes and distances in a 3D scatter plot", "show EV sales over the last 5 years in 3D bar chart", "show quarterly revenue in 2D flat chart", "visualize world population by continent", "compare programming language popularity", "what are the fastest animals in 3D bar chart"):
       - Create a "Visualize" node (tempId e.g. "new-1"). Do NOT create a separate Data node!
       - Synthesize a realistic, fact-based CSV string in "csvData" with a clean header row and 5 to 15 relevant rows.
       - Select the optimal "visConfig":
         - "scatter3d" with mode "3d": for continuous multi-variable correlation (e.g., 3 continuous numerical metrics like distance, mass, diameter; or price, horsepower, mpg).
         - "bar3d" with mode "3d": for categorical multi-series or multi-axis comparisons in 3D space.
         - "bar2d" with mode "flat": for clean 2D comparative clarity (e.g. quarterly revenue, market share rankings, financial metrics). (Design rule: don't use 3D just for decoration! If it's a simple comparison, flat 2D is often clearer).
         - "xAxis": first column or category name (e.g. "Company", "Planet", "Year", "Language").
         - "yAxis": primary numerical column (e.g. "MarketCapBillion", "Revenue", "DistanceAU", "UsersMillion").
         - "zAxis": secondary numerical column (for 3D charts, e.g. "DiameterKm", "GrowthPct", "Expenses").
       - Set "prompt" to a clean, descriptive title (e.g. "Tech Giant Market Capitalization 2024").
       - Set "autoRun": true.
       - If the user also asks to export, download, or save the data: create an "Export" node (tempId "new-2") and connect new-1 (port 0) -> new-2 (port 0).
   - **MATHEMATICS CONCEPTS, GEOMETRIC THEOREMS & 3D SURFACES**:
     - If user asks to learn or visualize mathematical concepts, geometric theorems, 3D function plots, or shapes (e.g. "explain Pythagorean theorem in 3D", "show a cube and highlight the diagonal", "visualize a hyperbolic saddle surface", "show the unit circle and highlight sine and cosine", "visualize vector cross product"):
       - Create a "Visualize" node (tempId "new-1") with:
         {
           "chartType": "math3d",
           "mode": "3d",
           "xAxis": "x",
           "yAxis": "y",
           "zAxis": "z",
           "math": {
             "conceptType": "pythagoras" | "cube" | "saddle" | "paraboloid" | "unit_circle" | "cross_product" | "torus",
             "title": "<Concept Title>",
             "formula": "<Mathematical Formula, e.g. a² + b² = c²>",
             "explanation": "<Educational explanation>",
             "highlightName": "<element_to_highlight, e.g. hypotenuse, diagonal, saddle_point, sine, cosine>",
             "highlightColor": "<color name, e.g. neon green, gold, cyan, red>"
           }
         }
     - If user asks to highlight a specific side, edge, face, line, or point on an existing math visual (e.g. "highlight the hypotenuse", "highlight the top face in cyan", "glow the saddle point"):
       - In "nodesToUpdate", update the Visualize node's visConfig.math highlightName and highlightColor.
   - **CHART BAR COLORING & STYLING**:
     - If user asks to color specific chart bars or points (e.g. "make the Tesla bar neon green", "color Apple red", "change the Amazon bar to gold"):
       - Identify the Visualize node in currentNodes.
       - In "nodesToUpdate", provide:
         {
           "id": "<vis-node-id>",
           "visConfig": {
             "customColors": {
               "<CategoryName>": "<color_name_or_hex>"
             }
           }
         }
   - **TASK LIST & CHECKLIST VOICE CONTROL (CREATE, EDIT, CHECK, UNCHECK, DELETE)**:
     - The user can fully control tasks by voice.
     - If user asks to create or add a task (e.g. "add task to review EV model", "create task: inspect charts", "new task write report"):
       - If a Checklist node exists in currentNodes: in "nodesToUpdate", append the new task { "id": "task-new", "text": "<task>", "done": false } to its checklist.
       - If NO Checklist node exists: in "nodesToCreate", create a "Checklist" node (tempId "new-1") with prompt "Project Tasks" and checklist: [{ "id": "1", "text": "<task>", "done": false }].
     - If user asks to edit a task (e.g. "edit task 1 to review WebXR", "change task 2 to test grab"):
       - In "nodesToUpdate", find the task by number or text in the Checklist node and update its "text".
     - If user asks to check, complete, or mark a task as done (e.g. "check task 1", "mark task 1 as done", "complete task review EV model"):
       - In "nodesToUpdate", find the task in the Checklist node and set "done": true.
     - If user asks to uncheck or mark a task as incomplete (e.g. "uncheck task 1", "mark task 1 as undone"):
       - In "nodesToUpdate", find the task in the Checklist node and set "done": false.
     - If user asks to delete or remove a task (e.g. "delete task 1", "remove task 2"):
       - In "nodesToUpdate", remove that item from the checklist array.
     - If user asks to clear all tasks (e.g. "clear all tasks", "clear checklist"):
       - In "nodesToUpdate", set checklist: [].
   - **DELETE ALL vs DELETE SINGLE/LAST**:
     - If user asks to "delete all", "clear everything", "clear all nodes", or "empty workspace":
       - Put ALL current node IDs into "nodesToDelete".
     - If user asks to "delete this", "delete last node", "remove model", or "delete chart":
       - Put only the specific node ID (or the last created node ID) into "nodesToDelete".
   - **3D MODEL GENERATION**:
     - If user asks for a 3D model directly (e.g. "make a 3D model of a sports car", "create a 3d model of X"):
       - If an image node already exists in workspace (especially one with an image or selected), and user says "turn this into 3D", connect that image node to Model3D port 1!
       - If NO image node exists, or user asks for 3D model from text: create a "Model3D" node with a descriptive prompt and set autoRun: true!
     - If user says "generate an image of X and make a 3d model":
       - Create an ImageGen node for X, create a Model3D node, connect ImageGen (port 0) -> Model3D (port 1), and mark both autoRun: true!
     - If user asks to resize, shrink, enlarge, or scale a 3D model (e.g. "make the 3D model bigger", "shrink it", "make it smaller", "double size", "reset size"):
       - Identify the Model3D node in currentNodes, and in "nodesToUpdate" provide { "id": "<model-node-id>", "modelScale": <new_scale> }.
       - For bigger/larger/grow: (current modelScale ?? 1.0) * 1.4
       - For smaller/shrink/tiny: (current modelScale ?? 1.0) * 0.7
       - For double/2x: 2.0
       - For half size: 0.5
       - For reset/default: 1.0
   - **RUNWAY VIDEO GENERATION (IMAGE-TO-VIDEO & TEXT-TO-VIDEO)**:
     - If user asks to turn an image into a video, animate an image, or create a video from an image (e.g. "turn this image into a video", "animate this", "make a video from this image with prompt X", "generate a video based on our prompt using runway"):
       - Identify the image node in currentNodes (prefer selected image node, or last completed image).
       - Create a "Video" node in "nodesToCreate" (tempId e.g. "new-1") with the user's prompt (or "cinematic camera pan and motion").
       - In "connectionsToCreate", connect image node (port 0) -> Video node (port 1).
       - Mark Video node autoRun: true!
     - If user asks for video generation directly from prompt (e.g. "make a video of ocean waves", "create video node"):
       - Create a "Video" node with prompt and mark autoRun: true!
   - **IMAGE GENERATION & COMBINATION**:
     - For images: Expand user intent into rich, production-grade descriptions (lighting, composition, style, details).
     - If user asks for multiple images (e.g. "generate two images of X", "create 3 image nodes", "give me multiple variations"):
       - Create the requested count of separate ImageGen nodes in "nodesToCreate" (tempId "new-1", "new-2", etc.), each with rich distinct variations, and set autoRun: true!
     - If user asks to use two images as reference for a new or existing image (e.g. "connect two image nodes to one image node as reference for generation"):
       - Connect image 1 (port 0) -> ImageGen (port 1) AND image 2 (port 0) -> ImageGen (port 2), then mark ImageGen autoRun: true!
     - If user says "combine these two images": create ImageCombine node, connect image 1 -> port 0 and image 2 -> port 1.
   - **SHIFTING & REPOSITIONING NODES IN 3D SPACE (UP, DOWN, LEFT, RIGHT, SIDEWAYS, CLOSER, FURTHER)**:
     - If user asks to shift, move, reposition, or nudge a specific node (or all nodes) up, down, left, right, sideways, closer, or further (e.g. "shift video node up", "move the 3d model to the right", "move node 2 down by 20cm", "shift this sideways", "move all nodes closer"):
       - Identify the target node in currentNodes (by type, name, prompt, or number), or "all" if workspace-wide.
       - In "nodesToUpdate", provide:
         {
           "id": "<node-id>",
           "shift": {
             "direction": "up" | "down" | "left" | "right" | "sideways" | "closer" | "further",
             "distance": 0.30
           }
         }
       - In "explanation", provide a short, natural confirmation in plain English (e.g. "I shifted the video node up." or "Moved the 3D model to the right.").
   - **INTELLIGENT DE-DUPLICATION & EXISTING NODE AWARENESS**:
     - For 3D Models and Data Visualizations: inspect currentNodes in workspace. If a 3D model or chart for the exact concept already exists, select or update it instead of creating duplicates.
     - FOR IMAGES: Users frequently want multiple images, multiple variations, or fresh image generations. NEVER block image generation when the user requests multiple images or a new image!
2. **Execution Order**:
   - In "nodesToExecute", list upstream generator nodes first (e.g. ImageGen before Model3D).

Response format must be strictly valid JSON:
{
  "explanation": "Natural, friendly 1-sentence confirmation in plain conversational English (e.g. 'I created your 3D bar chart for EV sales.'). NEVER mention JSON, parameters, column names, or format layouts in explanation. NEVER read aloud raw CSV rows, coordinates, code blocks, or JSON syntax.",
  "nodesToCreate": [
    {
      "tempId": "new-1",
      "type": "ImageGen" | "Text" | "ImageCombine" | "ImageInput" | "Model3D" | "Visualize" | "Export" | "Checklist" | "Video",
      "prompt": "detailed descriptive title or prompt",
      "csvData": "Entity,MarketCapBillion,RevenueBillion\nApple,3050,383\nMicrosoft,3120,211\n...",
      "visConfig": {
        "chartType": "scatter3d" | "bar3d" | "bar2d",
        "xAxis": "Entity",
        "yAxis": "MarketCapBillion",
        "zAxis": "RevenueBillion",
        "mode": "3d" | "flat"
      },
      "autoRun": true
    }
  ],
  "nodesToUpdate": [
    {
      "id": "existing-node-id",
      "prompt": "new prompt text",
      "modelScale": 1.5,
      "autoRun": false
    }
  ],
  "nodesToDelete": ["node-id-to-delete"],
  "connectionsToCreate": [
    {
      "sourceId": "existing-node-id or tempId (e.g. new-1)",
      "sourcePort": 0,
      "targetId": "existing-node-id or tempId",
      "targetPort": 0 or 1
    }
  ],
  "connectionsToDelete": ["conn-id"],
  "nodesToExecute": ["tempId or existing-node-id"]
}`;

  const userContent = JSON.stringify({
    userVoiceTranscript: transcript,
    selectedNodeId: selectedNodeId || null,
    currentNodes: nodes.map((n: any) => ({
      id: n.id,
      type: n.type,
      prompt: n.prompt,
      state: n.state,
      hasImage: Boolean(n.imageUrl),
      hasModel: Boolean(n.modelUrl),
      modelScale: n.modelScale ?? 1.0,
      checklist: n.checklist,
      visConfig: n.visConfig,
    })),
    currentConnections: connections.map((c: any) => ({
      id: c.id,
      sourceId: c.sourceNodeId,
      sourcePort: c.sourcePort,
      targetId: c.targetNodeId,
      targetPort: c.targetPort,
    })),
  });

  try {
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.2,
      }),
    });

    const aiData = (await aiRes.json()) as any;
    if (!aiRes.ok || !aiData.choices?.[0]?.message?.content) {
      console.error('[WeaVR OpenAI Error]', aiData);
      json(res, 502, { error: 'OpenAI API call failed', details: aiData });
      return;
    }

    const parsed = JSON.parse(aiData.choices[0].message.content);
    console.log('[WeaVR OpenAI Assistant Action]:', parsed.explanation);
    json(res, 200, parsed);
  } catch (err) {
    console.error('[WeaVR OpenAI Exception]', err);
    json(res, 500, { error: String(err) });
  }
}

async function handleUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  let payload: any = {};
  try {
    payload = JSON.parse(body);
  } catch {
    json(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const { dataUrl, filename = 'upload.png' } = payload;
  if (!dataUrl || typeof dataUrl !== 'string') {
    json(res, 400, { error: 'dataUrl required' });
    return;
  }

  try {
    const uploadId = `upload-${Date.now()}`;
    const base64Data = dataUrl.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    const mime = detectMimeType(buffer);
    const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';

    const genDir = path.join(PUBLIC_DIR, 'generated');
    if (!fs.existsSync(genDir)) {
      fs.mkdirSync(genDir, { recursive: true });
    }
    const outPath = path.join(genDir, `${uploadId}.${ext}`);
    fs.writeFileSync(outPath, buffer);

    const localUrl = `/generated/${uploadId}.${ext}`;
    const standardDataUrl = `data:${mime};base64,${base64Data}`;
    urlMap.set(localUrl, standardDataUrl); // store verified base64 dataUrl so Runway API can receive it as a reference

    console.log(
      `[WeaVR Upload] Saved local image (${mime}): ${localUrl} (${buffer.length} bytes)`,
    );
    json(res, 200, {
      imageUrl: localUrl,
      dataUrl: standardDataUrl,
      filename,
    });
  } catch (err) {
    console.error('[WeaVR Upload Error]', err);
    json(res, 500, { error: String(err) });
  }
}

async function handleVisionDescribe(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  let payload: any = {};
  try {
    payload = JSON.parse(body);
  } catch {
    json(res, 400, { error: 'Invalid JSON body' });
    return;
  }

  const { image, environmentContext = '', workspaceContext = '' } = payload;
  const envContext = environmentContext || workspaceContext || 'Simulated 3D living room with bookshelf and furniture';
  if (!image) {
    json(res, 400, { error: 'Image data URL required' });
    return;
  }

  if (!OPENAI_API_KEY) {
    json(res, 503, { error: 'OPENAI_API_KEY not configured on server' });
    return;
  }

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              'You are a real-time visual environment observer for a user in a 3D simulated room or WebXR space. You receive a captured camera frame of what the user is currently looking at, along with the camera gaze direction. Describe ONLY what is directly in front of the user in their immediate camera view (such as the specific structure or furniture they are facing, like the bookshelf, sofa, or window). Do NOT mention parts of the room that are behind them or outside this frame. Do NOT mention workspaces, nodes, panels, or digital graphs. Provide a concise, vivid 1-2 sentence description of what they are looking at right now.',
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Camera gaze direction & facing context: ${envContext}\n\nExamine the captured image and describe ONLY what is directly in front of the user in their current line of sight.`,
              },
              {
                type: 'image_url',
                image_url: {
                  url: image,
                  detail: 'low',
                },
              },
            ],
          },
        ],
        max_tokens: 120,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('[WeaVR Vision API Error]', response.status, errText);
      json(res, response.status, { error: `OpenAI Vision error: ${errText}` });
      return;
    }

    const data = (await response.json()) as any;
    const description =
      data.choices?.[0]?.message?.content?.trim() ||
      'You are looking at your spatial workspace.';

    console.log('[WeaVR Vision] Real-time description:', description);
    json(res, 200, { description });
  } catch (err: any) {
    console.error('[WeaVR Vision Error]', err);
    json(res, 500, { error: String(err?.message || err) });
  }
}

const server = http.createServer(async (req, res) => {
  cors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url ?? '';

  if (req.method === 'GET' && url === '/health') {
    json(res, 200, { ok: true, hasKey: RUNWAY_API_KEY.length > 0 });
    return;
  }

  if (req.method === 'POST' && url === '/api/generate') {
    await handleGenerate(req, res);
    return;
  }

  if (req.method === 'POST' && url === '/api/generate-video') {
    await handleGenerateVideo(req, res);
    return;
  }

  if (req.method === 'POST' && url === '/api/assistant') {
    await handleAssistant(req, res);
    return;
  }

  if (req.method === 'POST' && url === '/api/upload-image') {
    await handleUpload(req, res);
    return;
  }

  if (req.method === 'POST' && url === '/api/vision-describe') {
    await handleVisionDescribe(req, res);
    return;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && url.startsWith('/generated/')) {
    const filename = url.replace(/^\/generated\//, '').split('?')[0];
    const filePath = path.join(PUBLIC_DIR, 'generated', filename);
    if (fs.existsSync(filePath)) {
      try {
        const stat = fs.statSync(filePath);
        const fileSize = stat.size;
        let mime = 'application/octet-stream';
        if (filename.endsWith('.glb')) {
          mime = 'model/gltf-binary';
        } else if (filename.endsWith('.mp4')) {
          mime = 'video/mp4';
        } else {
          const buf = fs.readFileSync(filePath);
          mime = detectMimeType(buf);
        }

        cors(res);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', mime);
        res.setHeader('Access-Control-Allow-Origin', '*');

        const range = req.headers.range;
        if (range && mime === 'video/mp4') {
          const parts = range.replace(/bytes=/, '').split('-');
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
          const chunksize = end - start + 1;
          const file = fs.createReadStream(filePath, { start, end });

          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Content-Length': chunksize,
          });
          if (req.method === 'HEAD') {
            res.end();
          } else {
            file.pipe(res);
          }
          return;
        }

        res.writeHead(200, {
          'Content-Length': fileSize,
          'Cache-Control': 'public, max-age=86400',
        });
        if (req.method === 'HEAD') {
          res.end();
        } else {
          fs.createReadStream(filePath).pipe(res);
        }
        return;
      } catch (readErr) {
        console.warn('[WeaVR Static Serve Error]', readErr);
      }
    }
  }

  if (req.method === 'POST' && url === '/api/generate-3d') {
    await handleGenerate3D(req, res);
    return;
  }

  if (req.method === 'GET' && url.startsWith('/api/task-3d/')) {
    const taskId = url.replace('/api/task-3d/', '');
    const task = tasks3d.get(taskId);
    if (task) {
      json(res, 200, { taskId, ...task });
    } else {
      json(res, 404, { error: '3D Task not found' });
    }
    return;
  }

  if (req.method === 'GET' && url.startsWith('/api/task/')) {
    const taskId = url.replace('/api/task/', '');
    const task = tasks.get(taskId);
    if (task) {
      json(res, 200, { taskId, ...task });
    } else {
      json(res, 404, { error: 'Task not found' });
    }
    return;
  }

  if (req.method === 'GET' && url.startsWith('/api/image-proxy')) {
    const queryIdx = url.indexOf('?');
    const params = new URLSearchParams(queryIdx >= 0 ? url.slice(queryIdx) : '');
    const rawUrl = params.get('url');
    if (!rawUrl) {
      json(res, 400, { error: 'Missing url parameter' });
      return;
    }
    try {
      const imgRes = await fetch(rawUrl);
      const contentType = imgRes.headers.get('content-type') || 'image/png';
      cors(res);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
      });
      const arrayBuf = await imgRes.arrayBuffer();
      res.end(Buffer.from(arrayBuf));
    } catch (err) {
      json(res, 502, { error: 'Proxy failed: ' + String(err) });
    }
    return;
  }

  if (
    req.method === 'GET' &&
    (url === '/api/meshy-balance' ||
      url === '/api/meshy-balance/' ||
      url === '/api/tripo-balance' ||
      url === '/api/tripo-balance/')
  ) {
    try {
      const resBal = await fetch(`${MESHY_BASE}/openapi/v1/balance`, {
        headers: { Authorization: `Bearer ${MESHY_API_KEY}` },
      });
      const data = await resBal.json();
      json(res, 200, data);
    } catch (balErr) {
      json(res, 500, { error: String(balErr) });
    }
    return;
  }

  json(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`\n  WeaVR API proxy → http://localhost:${PORT}`);
  console.log(
    RUNWAY_API_KEY
      ? '  Runway API key: configured ✓'
      : '  Runway API key: not set — using placeholder images',
  );
  console.log(
    MESHY_API_KEY
      ? '  Meshy 3D API key: configured ✓'
      : '  Meshy 3D API key: not set — using procedural 3D assets',
  );
  console.log();
});

