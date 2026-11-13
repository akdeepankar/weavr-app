/**
 * WorkflowGraph — the canonical data model for the WeaVR workspace.
 *
 * Holds every node and connection, emits events so ECS systems can
 * react, and provides topological-sort execution ordering.
 */

import {
  parseCSV,
  SAMPLE_DATASETS,
  generateExportSummary,
} from './data-visualizer.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NodeType =
  | 'Text'
  | 'ImageGen'
  | 'ImageInput'
  | 'ImageCombine'
  | 'Model3D'
  | 'Data'
  | 'Visualize'
  | 'Export'
  | 'Checklist'
  | 'Video';
export type NodeState = 'Idle' | 'Queued' | 'Generating' | 'Completed' | 'Failed';

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface DataPayload {
  headers: string[];
  rows: (string | number)[][];
  types: ('number' | 'string')[];
}

export interface MathHighlight {
  element?: 'edge' | 'face' | 'vertex' | 'line' | 'point' | 'curve' | 'side';
  name: string; // e.g. 'hypotenuse', 'diagonal', 'top_face', 'leg_a', 'saddle_point'
  color: string; // e.g. 'neon green', '#22c55e', 'red', 'gold', 'cyan'
  label?: string; // e.g. 'c = √(a² + b²)'
}

export type MathConceptType =
  | 'pythagoras'
  | 'cube'
  | 'tetrahedron'
  | 'saddle'
  | 'paraboloid'
  | 'sine_surface'
  | 'unit_circle'
  | 'cross_product'
  | 'cylinder'
  | 'cone'
  | 'sphere'
  | 'torus';

export interface MathConceptConfig {
  conceptType: MathConceptType;
  title?: string;
  formula?: string;
  explanation?: string;
  highlights?: MathHighlight[];
  highlightName?: string;
  highlightColor?: string;
}

export interface VisConfig {
  chartType: 'scatter3d' | 'bar3d' | 'bar2d' | 'pie3d' | 'math3d' | 'hidden';
  xAxis: string;
  yAxis: string;
  zAxis?: string;
  filterColumn?: string;
  filterValue?: string;
  mode: '3d' | 'flat' | 'hidden';
  customColors?: Record<string, string>;
  math?: MathConceptConfig;
}

export interface NodeData {
  id: string;
  type: NodeType;
  prompt: string;
  imageUrl: string;
  videoUrl?: string;
  modelUrl?: string;
  modelScale?: number;
  csvData?: string;
  parsedData?: DataPayload;
  visConfig?: VisConfig;
  exportSummary?: string;
  checklist?: ChecklistItem[];
  state: NodeState;
  position: [number, number, number];
  error?: string;
  manuallyMoved?: boolean;
}

export interface ConnectionData {
  id: string;
  sourceNodeId: string;
  sourcePort: number;
  targetNodeId: string;
  targetPort: number;
}

export type GraphEvent =
  | { kind: 'nodeAdded'; node: NodeData }
  | { kind: 'nodeRemoved'; nodeId: string }
  | { kind: 'nodeUpdated'; node: NodeData; fields: string[] }
  | { kind: 'connectionAdded'; connection: ConnectionData }
  | { kind: 'connectionRemoved'; connectionId: string };

export type GraphListener = (event: GraphEvent) => void;

// ---------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------

/** Number of input ports per node type */
export function inputPortCount(type: NodeType): number {
  switch (type) {
    case 'Text':
      return 0;
    case 'ImageGen':
      return 3; // port 0: prompt (text/ref), port 1: reference image 1, port 2: reference image 2
    case 'ImageInput':
      return 0;
    case 'ImageCombine':
      return 2; // two image inputs
    case 'Model3D':
      return 2; // prompt text (port 0), reference image (port 1)
    case 'Data':
      return 1; // optional CSV text from Text node
    case 'Visualize':
      return 1; // tabular data stream from Data node
    case 'Export':
      return 1; // visualization scene or data from Visualize/Data node
    case 'Checklist':
      return 1; // optional upstream text
    case 'Video':
      return 2; // prompt (port 0), reference image (port 1)
  }
}

/** Number of output ports per node type */
export function outputPortCount(type: NodeType): number {
  switch (type) {
    case 'Text':
      return 1; // text output
    case 'ImageGen':
      return 1; // generated image
    case 'ImageInput':
      return 1; // imported image
    case 'ImageCombine':
      return 1; // combined image
    case 'Model3D':
      return 0; // produces interactive 3D model entity in space
    case 'Data':
      return 1; // tabular dataset output
    case 'Visualize':
      return 1; // visualization spec & scene
    case 'Export':
      return 0; // final export terminal
    case 'Checklist':
      return 1; // triggers downstream nodes
    case 'Video':
      return 1; // video stream
  }
}

/** Human-readable label for a node type */
export function nodeTypeLabel(type: NodeType): string {
  switch (type) {
    case 'Text':
      return 'Text';
    case 'ImageGen':
      return 'Image Gen';
    case 'ImageInput':
      return 'Image Input';
    case 'ImageCombine':
      return 'Combine';
    case 'Model3D':
      return '3D Model';
    case 'Data':
      return 'Data Node';
    case 'Visualize':
      return 'Visualize';
    case 'Export':
      return 'Export Node';
    case 'Checklist':
      return 'Checklist';
    case 'Video':
      return 'Video Gen';
  }
}

/** Validates whether an output port of sourceType can connect to targetPort of targetType */
export function canConnect(
  sourceType: NodeType,
  targetType: NodeType,
  targetPort: number,
): boolean {
  if (sourceType === 'Text') {
    // Text can connect to ImageGen prompt, Video prompt, Model3D prompt, Data node (as CSV input), Visualize node, or Checklist node
    if (
      (targetType === 'ImageGen' ||
        targetType === 'Model3D' ||
        targetType === 'Video' ||
        targetType === 'Data' ||
        targetType === 'Visualize' ||
        targetType === 'Checklist') &&
      targetPort === 0
    ) {
      return true;
    }
  }
  if (sourceType === 'Checklist') {
    // Checklist completion can trigger or flow to downstream nodes
    if (targetPort === 0 || targetPort === 1) return true;
  }
  if (sourceType === 'Data') {
    // Data node can connect to Visualize Node or directly to Export Node
    if ((targetType === 'Visualize' || targetType === 'Export') && targetPort === 0) {
      return true;
    }
  }
  if (sourceType === 'Visualize') {
    // Visualize node connects to Export Node
    if (targetType === 'Export' && targetPort === 0) {
      return true;
    }
  }
  if (
    sourceType === 'ImageGen' ||
    sourceType === 'ImageInput' ||
    sourceType === 'ImageCombine'
  ) {
    // Images connect to Video input (port 1 for image reference, port 0 also supported)
    if (targetType === 'Video' && (targetPort === 0 || targetPort === 1)) return true;
    // Images connect to 3D Model input (port 1 for reference image, port 0 also supported)
    if (targetType === 'Model3D' && (targetPort === 0 || targetPort === 1)) return true;
    // Images connect to ImageGen reference (port 1, port 2, or port 0) or ImageCombine (port 0 or 1)
    if (targetType === 'ImageGen') return true;
    if (targetType === 'ImageCombine') return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// WorkflowGraph
// ---------------------------------------------------------------------------

export class WorkflowGraph {
  readonly nodes = new Map<string, NodeData>();
  readonly connections = new Map<string, ConnectionData>();

  private listeners: GraphListener[] = [];
  private nextId = 1;
  private historyStack: GraphEvent[][] = [];
  private historyIndex = -1;

  // ------ ID generation ------

  private generateId(prefix: string): string {
    return `${prefix}-${this.nextId++}`;
  }

  // ------ Nodes ------

  addNode(
    type: NodeType,
    prompt = '',
    position?: [number, number, number],
    initialData?: Partial<NodeData>,
  ): NodeData {
    const id = this.generateId('node');
    const node: NodeData = {
      id,
      type,
      prompt,
      imageUrl: '',
      state: 'Idle',
      position: position ?? this.findFreePosition(),
      manuallyMoved: false,
    };

    if (type === 'Data') {
      const defaultCsv = initialData?.csvData || SAMPLE_DATASETS['Iris Measurements'];
      node.csvData = defaultCsv;
      node.parsedData = initialData?.parsedData || parseCSV(defaultCsv);
      node.prompt = prompt || 'Iris Measurements';
      node.state = 'Completed';
    } else if (type === 'Visualize') {
      const defaultCsv = initialData?.csvData || SAMPLE_DATASETS['Iris Measurements'];
      const data = initialData?.parsedData || parseCSV(defaultCsv);
      node.csvData = defaultCsv;
      node.parsedData = data;
      node.prompt = prompt || '3D Scatter Plot';
      node.state = 'Completed';
      const numHeaders = data.headers.filter((_, idx) => data.types[idx] === 'number');
      const catHeaders = data.headers.filter((_, idx) => data.types[idx] === 'string');
      const isPiePrompt = /\b(pie|piechart)\b/i.test(prompt || '');
      node.visConfig = initialData?.visConfig || {
        chartType: isPiePrompt ? 'pie3d' : (numHeaders.length >= 3 ? 'scatter3d' : 'bar3d'),
        xAxis: catHeaders[0] || data.headers[0] || 'x',
        yAxis: numHeaders[0] || data.headers[1] || 'y',
        zAxis: numHeaders[1] || data.headers[2],
        mode: '3d',
      };
    } else if (type === 'Export') {
      node.prompt = prompt || 'CSV & Summary Export';
      node.state = 'Completed';
      const defaultCsv = initialData?.csvData || SAMPLE_DATASETS['Iris Measurements'];
      const data = initialData?.parsedData || parseCSV(defaultCsv);
      node.parsedData = data;
      node.exportSummary = initialData?.exportSummary || generateExportSummary(data);
    } else if (type === 'Checklist') {
      node.prompt = prompt || 'Project Tasks';
      node.state = 'Completed';
      if (initialData?.checklist) {
        node.checklist = initialData.checklist;
      } else if (prompt && (prompt.includes(',') || prompt.includes('\n') || prompt.includes(';'))) {
        node.checklist = prompt
          .split(/[\n,;]+/)
          .map((t, idx) => ({ id: `task-${idx + 1}`, text: t.trim(), done: false }))
          .filter((t) => t.text.length > 0);
      } else {
        node.checklist = [];
      }
    }

    if (initialData) {
      Object.assign(node, initialData);
      if (initialData.csvData && !initialData.parsedData) {
        node.parsedData = parseCSV(initialData.csvData);
      }
    }

    this.nodes.set(id, node);
    this.emit({ kind: 'nodeAdded', node });
    return node;
  }

  removeNode(nodeId: string): void {
    // Remove all connections touching this node first
    const toRemove: string[] = [];
    for (const [connId, conn] of this.connections) {
      if (conn.sourceNodeId === nodeId || conn.targetNodeId === nodeId) {
        toRemove.push(connId);
      }
    }
    for (const connId of toRemove) {
      this.connections.delete(connId);
      this.emit({ kind: 'connectionRemoved', connectionId: connId });
    }
    this.nodes.delete(nodeId);
    this.emit({ kind: 'nodeRemoved', nodeId });
  }

  updateNode(nodeId: string, updates: Partial<NodeData>): void {
    const node = this.nodes.get(nodeId);
    if (node == null) return;
    const fields = Object.keys(updates);
    Object.assign(node, updates);
    this.emit({ kind: 'nodeUpdated', node, fields });
  }

  getNode(nodeId: string): NodeData | undefined {
    return this.nodes.get(nodeId);
  }

  /** All nodes ordered by creation (Map insertion order). */
  allNodes(): NodeData[] {
    return [...this.nodes.values()];
  }

  /** The most recently added node, if any. */
  lastNode(): NodeData | undefined {
    const arr = this.allNodes();
    return arr[arr.length - 1];
  }

  // ------ Connections ------

  addConnection(
    sourceNodeId: string,
    sourcePort: number,
    targetNodeId: string,
    targetPort: number,
  ): ConnectionData | null {
    // Prevent duplicate and self connections
    if (sourceNodeId === targetNodeId) return null;
    for (const conn of this.connections.values()) {
      if (
        conn.sourceNodeId === sourceNodeId &&
        conn.sourcePort === sourcePort &&
        conn.targetNodeId === targetNodeId &&
        conn.targetPort === targetPort
      ) {
        return null;
      }
    }
    const id = this.generateId('conn');
    const connection: ConnectionData = {
      id,
      sourceNodeId,
      sourcePort,
      targetNodeId,
      targetPort,
    };
    this.connections.set(id, connection);

    // Propagate data flow between Data -> Visualize -> Export
    const sourceNode = this.nodes.get(sourceNodeId);
    const targetNode = this.nodes.get(targetNodeId);
    if (sourceNode && targetNode) {
      if (sourceNode.type === 'Data' && targetNode.type === 'Visualize') {
        if (sourceNode.parsedData) {
          const headers = sourceNode.parsedData.headers;
          const numHeaders = headers.filter((_, idx) => sourceNode.parsedData?.types[idx] === 'number');
          const catHeaders = headers.filter((_, idx) => sourceNode.parsedData?.types[idx] === 'string');
          const defaultX = catHeaders[0] || headers[0] || 'x';
          const defaultY = numHeaders[0] || headers[1] || 'y';
          const defaultZ = numHeaders[1] || (headers.length > 2 ? headers[2] : undefined);
          this.updateNode(targetNodeId, {
            parsedData: sourceNode.parsedData,
            visConfig: {
              chartType: targetNode.visConfig?.chartType || (defaultZ ? 'scatter3d' : 'bar3d'),
              xAxis: defaultX,
              yAxis: defaultY,
              zAxis: defaultZ,
              mode: targetNode.visConfig?.mode || '3d',
            },
          });
        }
      } else if (sourceNode.type === 'Visualize' && targetNode.type === 'Export') {
        if (sourceNode.parsedData) {
          this.updateNode(targetNodeId, {
            parsedData: sourceNode.parsedData,
            visConfig: sourceNode.visConfig,
            exportSummary: generateExportSummary(sourceNode.parsedData, sourceNode.visConfig),
          });
        }
      } else if (sourceNode.type === 'Data' && targetNode.type === 'Export') {
        if (sourceNode.parsedData) {
          this.updateNode(targetNodeId, {
            parsedData: sourceNode.parsedData,
            exportSummary: generateExportSummary(sourceNode.parsedData),
          });
        }
      } else if (sourceNode.type === 'Text' && targetNode.type === 'Checklist') {
        if (sourceNode.prompt) {
          const lines = sourceNode.prompt
            .split(/[\n,;]+/)
            .map((t) => t.trim())
            .filter((t) => t.length > 0);
          if (lines.length > 0) {
            this.updateNode(targetNodeId, {
              checklist: lines.map((text, idx) => ({
                id: `task-${idx + 1}`,
                text,
                done: false,
              })),
            });
          }
        }
      }
    }

    this.autoAlignConnectedNodes(targetNodeId, sourceNodeId);
    this.emit({ kind: 'connectionAdded', connection });
    return connection;
  }

  /**
   * Automatically aligns nodes when connected so multi-input nodes have their
   * upstream sources neatly stacked vertically ("one below one") on the left,
   * unless the nodes were manually moved by the user.
   */
  autoAlignConnectedNodes(targetNodeId: string, sourceNodeId: string): void {
    const VERTICAL_SPACING = 0.38; // 38cm spacing (node height 30cm + 8cm margin)
    const HORIZONTAL_SPACING = 0.46; // 46cm spacing (node width 40cm + 6cm margin)

    // 1. Check upstream inputs for targetNodeId (e.g. 2 or 3 nodes feeding 1 target)
    const targetNode = this.nodes.get(targetNodeId);
    if (targetNode) {
      const inConns = this.getInputConnections(targetNodeId);
      if (inConns.length >= 2) {
        // Sort by targetPort so port 0 is top, port 1 is middle, port 2 is bottom
        inConns.sort((a, b) => a.targetPort - b.targetPort);
        const sources = inConns
          .map((c) => this.nodes.get(c.sourceNodeId))
          .filter((n): n is NodeData => Boolean(n));

        const uniqueSources = [...new Map(sources.map((s) => [s.id, s])).values()];
        if (uniqueSources.length >= 2) {
          const anyManual = uniqueSources.some((s) => s.manuallyMoved);
          const [tx, ty, tz] = targetNode.position;

          if (!anyManual) {
            // Neither manually moved: stack cleanly to the left of target node ("one below one")
            const stackX = tx - HORIZONTAL_SPACING;
            const N = uniqueSources.length;
            uniqueSources.forEach((src, idx) => {
              const y = ty + ((N - 1) / 2 - idx) * VERTICAL_SPACING;
              this.updateNode(src.id, { position: [stackX, y, tz] });
            });
          }
        }
      }
    }

    // 2. Also check downstream outputs for sourceNodeId (1 source feeding 2 targets)
    const sourceNode = this.nodes.get(sourceNodeId);
    if (sourceNode) {
      const outConns = this.getOutputConnections(sourceNodeId);
      if (outConns.length === 2) {
        outConns.sort((a, b) => a.sourcePort - b.sourcePort);
        const topTarget = this.nodes.get(outConns[0].targetNodeId);
        const btmTarget = this.nodes.get(outConns[1].targetNodeId);

        if (topTarget && btmTarget && topTarget.id !== btmTarget.id) {
          const topManual = Boolean(topTarget.manuallyMoved);
          const btmManual = Boolean(btmTarget.manuallyMoved);
          const [sx, sy, sz] = sourceNode.position;

          if (!topManual && !btmManual) {
            const stackX = sx + HORIZONTAL_SPACING;
            const topY = sy + VERTICAL_SPACING / 2;
            const btmY = sy - VERTICAL_SPACING / 2;
            this.updateNode(topTarget.id, { position: [stackX, topY, sz] });
            this.updateNode(btmTarget.id, { position: [stackX, btmY, sz] });
          } else if (topManual && !btmManual) {
            const [topX, topY, topZ] = topTarget.position;
            this.updateNode(btmTarget.id, {
              position: [topX, topY - VERTICAL_SPACING, topZ],
            });
          } else if (!topManual && btmManual) {
            const [btmX, btmY, btmZ] = btmTarget.position;
            this.updateNode(topTarget.id, {
              position: [btmX, btmY + VERTICAL_SPACING, btmZ],
            });
          }
        }
      }
    }
  }

  removeConnection(connectionId: string): void {
    if (this.connections.delete(connectionId)) {
      this.emit({ kind: 'connectionRemoved', connectionId });
    }
  }

  /** All connections where this node is a target (upstream inputs). */
  getInputConnections(nodeId: string): ConnectionData[] {
    const result: ConnectionData[] = [];
    for (const conn of this.connections.values()) {
      if (conn.targetNodeId === nodeId) result.push(conn);
    }
    return result;
  }

  /** All connections where this node is a source (downstream outputs). */
  getOutputConnections(nodeId: string): ConnectionData[] {
    const result: ConnectionData[] = [];
    for (const conn of this.connections.values()) {
      if (conn.sourceNodeId === nodeId) result.push(conn);
    }
    return result;
  }

  /** Upstream source nodes for a given node. */
  getInputNodes(nodeId: string): NodeData[] {
    return this.getInputConnections(nodeId)
      .map((c) => this.nodes.get(c.sourceNodeId))
      .filter((n): n is NodeData => n != null);
  }

  // ------ Execution order ------

  /**
   * Returns node IDs in dependency order (topological sort).
   * If the graph contains a cycle the offending nodes are omitted.
   */
  getExecutionOrder(): string[] {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const order: string[] = [];

    const visit = (nodeId: string): boolean => {
      if (visiting.has(nodeId)) return false; // cycle
      if (visited.has(nodeId)) return true;
      visiting.add(nodeId);
      for (const conn of this.connections.values()) {
        if (conn.targetNodeId === nodeId) {
          if (!visit(conn.sourceNodeId)) return false;
        }
      }
      visiting.delete(nodeId);
      visited.add(nodeId);
      order.push(nodeId);
      return true;
    };

    for (const nodeId of this.nodes.keys()) {
      visit(nodeId);
    }
    return order;
  }

  // ------ Positioning ------

  /**
   * Finds an unoccupied position close to the player in front of them,
   * keeping all nodes within comfortable hand reach (~1 meter).
   */
  findFreePosition(spacingX = 0.46, spacingY = 0.38): [number, number, number] {
    const group = this.positionsForGroup(1, undefined, spacingX, spacingY);
    return group[0] ?? [0, 1.48, -0.95];
  }

  /**
   * Side-by-side positions for N nodes, placed close to the player at eye-level
   * spiraling outward from the center so nodes are never far away.
   */
  positionsForGroup(
    count: number,
    preferredCenter?: [number, number, number],
    spacingX = 0.46,
    spacingY = 0.38,
  ): Array<[number, number, number]> {
    const existing = [...this.nodes.values()].map((n) => n.position);
    const WORKSPACE_BASE_Z = -0.95;
    const WORKSPACE_BASE_Y = 1.48; // Eye-level ergonomics (~1.48m)

    // Helper: calculate comfortable cylindrical arc distance for a given x
    const arcZ = (x: number) => WORKSPACE_BASE_Z + Math.min(0.2, (x * x) * 0.08);

    // If no existing nodes and no preferredCenter, start cleanly in front of player
    if (existing.length === 0 && !preferredCenter) {
      const positions: Array<[number, number, number]> = [];
      const startX = -((count - 1) * spacingX) / 2;
      for (let i = 0; i < count; i++) {
        const x = startX + i * spacingX;
        positions.push([x, WORKSPACE_BASE_Y, arcZ(x)]);
      }
      return positions;
    }

    // If preferredCenter is given, search nearby offsets close to that target
    if (preferredCenter) {
      const [cx, cy] = preferredCenter;
      const offsetsX = [0, spacingX, -spacingX, spacingX * 2, -spacingX * 2];
      const offsetsY = [0, spacingY, -spacingY];

      for (const dy of offsetsY) {
        for (const dx of offsetsX) {
          const testX = cx + dx;
          const testY = cy + dy;
          const startX = testX - ((count - 1) * spacingX) / 2;
          let collision = false;
          const candidate: Array<[number, number, number]> = [];

          for (let i = 0; i < count; i++) {
            const x = startX + i * spacingX;
            const pos: [number, number, number] = [x, testY, arcZ(x)];
            if (
              existing.some(
                (e) =>
                  Math.abs(e[0] - pos[0]) < spacingX * 0.88 &&
                  Math.abs(e[1] - pos[1]) < spacingY * 0.82,
              )
            ) {
              collision = true;
              break;
            }
            candidate.push(pos);
          }

          if (!collision) return candidate;
        }
      }
    }

    // Search outward from center: 0, +1, -1, +2, -2, +3, -3 columns
    const colsCenterOut = [0, 1, -1, 2, -2, 3, -3];
    const rowsCenterOut = [0, 1, -1, 2, -2];

    for (const rMul of rowsCenterOut) {
      const y = WORKSPACE_BASE_Y + rMul * spacingY;
      for (const cMul of colsCenterOut) {
        const centerColX = cMul * spacingX;
        const startX = centerColX - ((count - 1) * spacingX) / 2;
        let fits = true;
        const candidate: Array<[number, number, number]> = [];

        for (let i = 0; i < count; i++) {
          const x = startX + i * spacingX;
          const pos: [number, number, number] = [x, y, arcZ(x)];
          const collides = existing.some(
            (e) =>
              Math.abs(e[0] - pos[0]) < spacingX * 0.88 &&
              Math.abs(e[1] - pos[1]) < spacingY * 0.82,
          );
          if (collides) {
            fits = false;
            break;
          }
          candidate.push(pos);
        }

        if (fits) {
          return candidate;
        }
      }
    }

    // Fallback: place close to center with slight offset
    const positions: Array<[number, number, number]> = [];
    const fallbackX = -((count - 1) * spacingX) / 2;
    for (let i = 0; i < count; i++) {
      const x = fallbackX + i * spacingX + 0.2;
      positions.push([x, WORKSPACE_BASE_Y, arcZ(x)]);
    }
    return positions;
  }

  // ------ Event system ------

  subscribe(listener: GraphListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  private emit(event: GraphEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Swallow listener errors to protect the graph
      }
    }
  }
}

/** Singleton graph instance shared across all systems. */
export const workflowGraph = new WorkflowGraph();

