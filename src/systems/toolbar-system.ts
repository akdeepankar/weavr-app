/**
 * ToolbarSystem — wires the floating toolbar UIKitML panel to
 * workflow actions: add nodes, toggle voice, run all, undo/redo.
 */

import { createSystem, UIKitMLAsset } from '@iwsdk/core';
import { workflowGraph } from '../services/workflow-graph.js';

export class ToolbarSystem extends createSystem({}) {
  init(): void {
    const toolbar = this.world.getSceneObject<UIKitMLAsset>(
      'toolbar-panel',
    ) as UIKitMLAsset | null;
    if (toolbar == null) return;

    // Helper to bind a button
    const bind = (id: string, handler: () => void) => {
      const btn = toolbar.getElementById(id);
      if (btn) {
        btn.addEventListener('click', handler);
        this.cleanupFuncs.push(() => btn.removeEventListener('click', handler));
      }
    };

    // --- Voice ---
    bind('btn-voice', () => {
      // Find VoiceSystem and toggle — use a global event for decoupling
      window.dispatchEvent(new CustomEvent('weavr:toggle-voice'));
    });

    // --- Selected Node Actions ---
    bind('btn-delete-selected', () => {
      window.dispatchEvent(new CustomEvent('weavr:delete-selected'));
    });

    // --- Reset view ---
    bind('btn-reset', () => {
      // Remove all nodes and connections
      for (const nodeId of [...workflowGraph.nodes.keys()]) {
        workflowGraph.removeNode(nodeId);
      }
    });
  }
}

