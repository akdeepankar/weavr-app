/**
 * WeaVR — Spatial AI Workflow Workspace
 *
 * Entry point: creates the IWSDK world and registers all systems.
 */

import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { PanelSystem } from './systems/panel-system.js';
import { WorkspaceSystem } from './systems/workspace-system.js';
import { WireSystem } from './systems/wire-system.js';
import { VoiceSystem } from './systems/voice-system.js';
import { ToolbarSystem } from './systems/toolbar-system.js';
import { ChecklistSystem } from './systems/checklist-system.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  // Core UI
  world.registerSystem(PanelSystem);

  // Spatial workspace
  world.registerSystem(WorkspaceSystem);
  world.registerSystem(WireSystem);

  // Interaction
  world.registerSystem(VoiceSystem);
  world.registerSystem(ToolbarSystem);
  world.registerSystem(ChecklistSystem);

  // Wire toolbar voice button to VoiceSystem
  window.addEventListener('weavr:toggle-voice', () => {
    const voiceSystem = world.getSystem(VoiceSystem);
    if (voiceSystem) {
      (voiceSystem as VoiceSystem).toggleListening();
    }
  });

  // Wire toolbar run-all to VoiceSystem
  window.addEventListener('weavr:run-all', () => {
    const voiceSystem = world.getSystem(VoiceSystem);
    if (voiceSystem) {
      (voiceSystem as VoiceSystem).runAllNodes();
    }
  });
});
