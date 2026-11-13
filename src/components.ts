/**
 * WeaVR component registry — declares all components the editor
 * and runtime share. Components must be system-free and listed here.
 */

import { defineComponents } from '@iwsdk/core';
import {
  WorkflowNode,
  WireVisual,
  NodeConnector,
  SelectedNode,
} from './weavr-components.js';

export default defineComponents([
  WorkflowNode,
  WireVisual,
  NodeConnector,
  SelectedNode,
]);
