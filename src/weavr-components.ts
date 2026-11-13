/**
 * WeaVR ECS components — lightweight markers that link entities
 * to application state in the WorkflowGraph service.
 */

import { createComponent, Types } from '@iwsdk/core';

/** Node type enum values */
export const NodeTypes = {
  Text: 'Text',
  ImageGen: 'ImageGen',
  ImageInput: 'ImageInput',
  ImageCombine: 'ImageCombine',
} as const;

/** Execution state enum values */
export const NodeStates = {
  Idle: 'Idle',
  Queued: 'Queued',
  Generating: 'Generating',
  Completed: 'Completed',
  Failed: 'Failed',
} as const;

/**
 * Marks an entity as a workflow node panel.
 * `nodeId` references the canonical NodeData in WorkflowGraph.
 */
export const WorkflowNode = createComponent('WorkflowNode', {
  nodeId: { type: Types.String, default: '' },
});

/**
 * Marks an entity as a wire visual connecting two nodes.
 * `wireId` references the canonical ConnectionData in WorkflowGraph.
 */
export const WireVisual = createComponent('WireVisual', {
  wireId: { type: Types.String, default: '' },
});

/**
 * Marks an entity as an input or output connector port on a node.
 */
export const NodeConnector = createComponent('NodeConnector', {
  nodeId: { type: Types.String, default: '' },
  isOutput: { type: Types.Boolean, default: false },
  port: { type: Types.Int32, default: 0 },
});

/**
 * Tag component indicating a node is currently selected by the user.
 */
export const SelectedNode = createComponent('SelectedNode', {
  nodeId: { type: Types.String, default: '' },
});

