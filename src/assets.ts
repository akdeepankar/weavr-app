/**
 * WeaVR asset manifest — deterministic, side-effect free.
 * Evaluated twice (runtime + editor), so no World / DOM / timers.
 */

import { AssetType, defineAssets } from '@iwsdk/core';

const publicAssetUrl = (filePath: string): string =>
  `${import.meta.env.BASE_URL}${filePath.replace(/^\/+/u, '')}`;

const uikitml = (fileName: string, name: string) => ({
  url: publicAssetUrl(`ui/${fileName}`),
  type: AssetType.UIKitML,
  name,
});

export default defineAssets({
  'welcome-panel': uikitml('welcome.uikitml', 'Welcome Panel'),
  'toolbar-panel': uikitml('toolbar.uikitml', 'Toolbar Panel'),
  'checklist-panel': uikitml('checklist.uikitml', 'Checklist Panel'),
});
