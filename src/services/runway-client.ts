/**
 * RunwayClient — calls the WeaVR backend proxy for image generation.
 *
 * When no backend is available (or the API key is missing) it falls
 * back to placeholder images from picsum.photos so the full
 * interaction flow still works during development.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GenerateRequest {
  prompt: string;
  imageRefs?: string[]; // URLs of reference images
}

export interface GenerateResponse {
  taskId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  imageUrl?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const BACKEND_URL =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_WEAVR_API_URL) ||
  'http://localhost:3001';

let backendAvailable: boolean | null = null;

async function checkBackend(): Promise<boolean> {
  if (backendAvailable !== null) return backendAvailable;
  try {
    const res = await fetch(`${BACKEND_URL}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    });
    backendAvailable = res.ok;
  } catch {
    backendAvailable = false;
  }
  return backendAvailable;
}

/**
 * Generates a deterministic placeholder image URL from a prompt.
 * Uses picsum.photos with a seed derived from the text.
 */
function placeholderUrl(prompt: string): string {
  const seed = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40);
  return `https://picsum.photos/seed/${seed}/512/384`;
}

/**
 * Submit an image-generation request. Resolves once the image is
 * ready (or immediately with a placeholder when the backend is offline).
 */
export async function generateImage(
  request: GenerateRequest,
): Promise<GenerateResponse> {
  const hasBackend = await checkBackend();

  if (!hasBackend) {
    // Simulate generation delay
    await new Promise((r) => setTimeout(r, 1500 + Math.random() * 1500));
    return {
      taskId: `mock-${Date.now()}`,
      status: 'completed',
      imageUrl: placeholderUrl(request.prompt),
    };
  }

  try {
    // Submit task
    const submitRes = await fetch(`${BACKEND_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    const submitData = (await submitRes.json()) as GenerateResponse;

    if (!submitRes.ok || !submitData.taskId) {
      return {
        taskId: '',
        status: 'failed',
        error: submitData.error || `HTTP ${submitRes.status}: Image generation request failed`,
      };
    }

    if (submitData.status === 'completed') {
      return submitData;
    }
    if (submitData.status === 'failed') {
      return submitData;
    }

    // Poll until completion
    const taskId = submitData.taskId;
    for (let attempt = 0; attempt < 60; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      const pollRes = await fetch(`${BACKEND_URL}/api/task/${taskId}`);
      const pollData = (await pollRes.json()) as GenerateResponse;
      if (pollData.status === 'completed' || pollData.status === 'failed') {
        return pollData;
      }
    }
    return { taskId, status: 'failed', error: 'Generation timed out' };
  } catch (err) {
    return {
      taskId: `err-${Date.now()}`,
      status: 'failed',
      error: String(err),
    };
  }
}

/**
 * Combines multiple images by passing them as references to
 * a new generation request with the user's prompt.
 */
export async function combineImages(
  imageUrls: string[],
  prompt = 'Combine these images into a cohesive composition',
): Promise<GenerateResponse> {
  return generateImage({ prompt, imageRefs: imageUrls });
}

export interface GenerateVideoRequest {
  prompt: string;
  imageUrl?: string;
  duration?: number;
}

export interface GenerateVideoResponse {
  taskId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  videoUrl?: string;
  error?: string;
}

/**
 * Generates a video using Runway Gen-3 Alpha (Image-to-Video or Text-to-Video).
 */
export async function generateVideo(
  request: GenerateVideoRequest,
): Promise<GenerateVideoResponse> {
  const hasBackend = await checkBackend();

  if (!hasBackend) {
    await new Promise((r) => setTimeout(r, 2000));
    return {
      taskId: `mock-vid-${Date.now()}`,
      status: 'completed',
      videoUrl: '/sample-video.mp4',
    };
  }

  try {
    const submitRes = await fetch(`${BACKEND_URL}/api/generate-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    const submitData = (await submitRes.json()) as GenerateVideoResponse;

    if (!submitRes.ok || !submitData.taskId) {
      return {
        taskId: '',
        status: 'failed',
        error: submitData.error || `HTTP ${submitRes.status}: Video generation request failed`,
      };
    }

    if (submitData.status === 'completed' || submitData.status === 'failed') {
      return submitData;
    }

    const taskId = submitData.taskId;
    for (let attempt = 0; attempt < 90; attempt++) {
      await new Promise((r) => setTimeout(r, 2500));
      const pollRes = await fetch(`${BACKEND_URL}/api/task/${taskId}`);
      const pollData = (await pollRes.json()) as GenerateVideoResponse;
      if (pollData.status === 'completed' || pollData.status === 'failed') {
        return pollData;
      }
    }
    return { taskId, status: 'failed', error: 'Video generation timed out' };
  } catch (err) {
    return {
      taskId: `err-${Date.now()}`,
      status: 'failed',
      error: String(err),
    };
  }
}


