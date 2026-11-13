/**
 * MeshyClient — connects to WeaVR proxy for 2D Image to 3D Model and Text to 3D Model generation via Meshy AI.
 */

export interface Generate3DRequest {
  imageUrl?: string;
  prompt?: string;
}

export interface Generate3DResponse {
  taskId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  modelUrl?: string;
  previewUrl?: string;
  error?: string;
  note?: string;
}

const BACKEND_URL =
  (typeof import.meta !== 'undefined' &&
    (import.meta as any).env?.VITE_WEAVR_API_URL) ||
  'http://localhost:3001';

export async function generate3DModel(
  request: Generate3DRequest,
): Promise<Generate3DResponse> {
  try {
    const submitRes = await fetch(`${BACKEND_URL}/api/generate-3d`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    const submitData = (await submitRes.json()) as Generate3DResponse;

    if (submitData.status === 'completed' || submitData.status === 'failed') {
      return submitData;
    }

    const taskId = submitData.taskId;
    // Poll for completion (up to ~3.5 minutes)
    for (let attempt = 0; attempt < 90; attempt++) {
      await new Promise((r) => setTimeout(r, 2500));
      const pollRes = await fetch(`${BACKEND_URL}/api/task-3d/${taskId}`);
      const pollData = (await pollRes.json()) as Generate3DResponse;
      if (pollData.status === 'completed' || pollData.status === 'failed') {
        return pollData;
      }
    }

    return { taskId, status: 'failed', error: 'Meshy 3D model generation timed out' };
  } catch (err) {
    return {
      taskId: `err-3d-${Date.now()}`,
      status: 'failed',
      error: String(err),
    };
  }
}

