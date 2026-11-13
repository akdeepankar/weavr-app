/**
 * ImageUploader — opens system file dialog to select an image from local storage,
 * reads as base64 Data URL, and uploads to the local WeaVR backend for serving.
 */

export interface UploadResult {
  imageUrl: string;
  dataUrl: string;
  filename: string;
}

export function pickAndUploadLocalImage(): Promise<UploadResult | null> {
  return new Promise((resolve) => {
    let input = document.getElementById('weavr-file-picker') as HTMLInputElement | null;
    if (!input) {
      input = document.createElement('input');
      input.id = 'weavr-file-picker';
      input.type = 'file';
      input.accept = 'image/png,image/jpeg,image/webp,image/gif';
      input.style.display = 'none';
      document.body.appendChild(input);
    }

    input.value = '';

    const onChange = async () => {
      cleanup();
      const file = input?.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }

      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = reader.result as string;
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
            resolve({
              imageUrl: data.imageUrl,
              dataUrl,
              filename: file.name,
            });
            return;
          }
        } catch {
          // Backend unreachable — use data URL directly
        }

        resolve({
          imageUrl: dataUrl,
          dataUrl,
          filename: file.name,
        });
      };

      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    };

    const cleanup = () => {
      input?.removeEventListener('change', onChange);
    };

    input.addEventListener('change', onChange, { once: true });
    input.click();
  });
}

