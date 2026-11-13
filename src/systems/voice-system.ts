/**
 * VoiceSystem — integrates the ElevenLabs Conversational Voice Agent
 * for voice-driven spatial workflow creation in Meta Quest XR.
 *
 * Connects to ElevenLabs Agent: agent_6401m729bgp2fe0sear65vdzdgch
 * Supports bidirectional real-time audio, client tools, and spoken responses.
 */

import {
  Color,
  createSystem,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  UIKitMLAsset,
  Vector3,
} from '@iwsdk/core';
import { Conversation } from '@elevenlabs/client';
import { parseCommand, type WorkflowAction } from '../services/command-parser.js';
import {
  workflowGraph,
  nodeTypeLabel,
  type ConnectionData,
  type NodeData,
  type NodeType,
  type VisConfig,
} from '../services/workflow-graph.js';
import {
  generateImage,
  combineImages,
  generateVideo,
} from '../services/runway-client.js';
import { generate3DModel } from '../services/meshy-client.js';
import { parseCSV } from '../services/data-visualizer.js';

// Default ElevenLabs Agent ID
const ELEVENLABS_AGENT_ID = 'agent_6401m729bgp2fe0sear65vdzdgch';

// SpeechRecognition type shim for fallback
type SpeechRecognitionType = any;

// ---------------------------------------------------------------------------
// Intelligent Prompt & Topic Semantic Matching Helpers
// ---------------------------------------------------------------------------

function normalizePrompt(text: string): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(
      /\b(a|an|the|of|in|for|on|with|to|and|create|make|show|generate|visualize|model|3d|chart|graph|plot|please|node|image)\b/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSubjectKeywords(text: string): string[] {
  if (!text) return [];
  const stopWords = new Set([
    'a', 'an', 'the', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by',
    'and', 'or', 'is', 'are', 'was', 'were', 'it', 'this', 'that', 'these', 'those',
    'node', 'nodes', 'image', 'images', 'picture', 'pictures', 'photo', 'photos',
    'video', 'videos', 'clip', 'animation', 'motion', 'create', 'make', 'generate',
    'turn', 'convert', 'connect', 'wire', 'into', 'from', 'using', 'based',
    'please', 'can', 'you', 'i', 'want', 'need', 'show', 'give'
  ]);
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w));
}

function calculateWordOverlap(a: string, b: string): number {
  const normA = normalizePrompt(a);
  const normB = normalizePrompt(b);
  if (!normA || !normB) return 0;
  if (normA === normB || normA.includes(normB) || normB.includes(normA)) return 1.0;

  const wordsA = new Set(normA.split(' ').filter((w) => w.length > 2));
  const wordsB = new Set(normB.split(' ').filter((w) => w.length > 2));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let matches = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) matches++;
  }
  return matches / Math.min(wordsA.size, wordsB.size);
}

function cleanSpokenText(text: string): string {
  if (!text) return '';
  return text
    // 1. Strip XML / HTML tags like <action>...</action>
    .replace(/<action[\s\S]*?<\/action>/gi, '')
    .replace(/<[^>]+>/g, '')
    // 2. Strip code blocks and inline code
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '')
    // 3. Strip JSON objects, arrays, and syntax
    .replace(/\{[\s\S]*?\}/g, '')
    .replace(/\[[\s\S]*?\]/g, '')
    .replace(/["'][a-zA-Z0-9_-]+["']\s*:\s*[^,\n}]+/g, '')
    // 4. Strip 3D coordinates and vector positions e.g. (x, y, z), [1.2, -0.4, 0.0], x=0, y=1
    .replace(/\b(?:position|coords?|coordinates?|vector)\s*[:=]?\s*\(?\[?-?[\d.,\s]+\]?\)?/gi, '')
    .replace(/\b[xyz]\s*[:=]\s*-?[\d.]+/gi, '')
    .replace(/\(?-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?(?:\s*,\s*-?\d+(?:\.\d+)?)?\)?/g, '')
    // 5. Strip raw CSV rows (lines with 2+ commas and numbers/data)
    .replace(/^(?:[^\n,]+,){2,}[^\n,]+$/gm, '')
    // 6. Strip technical keywords and schema parameter names
    .replace(
      /\b(json|visConfig|xAxis|yAxis|zAxis|csvData|tempId|autoRun|nodesToCreate|nodesToUpdate|nodesToDelete|connectionsToCreate|connectionsToDelete|chartType|conceptType|modelUrl|imageUrl|modelScale)\b/gi,
      '',
    )
    // 7. Strip leftover syntax characters and collapse spaces
    .replace(/[{}()[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export class VoiceSystem extends createSystem({}) {
  private conversation: any = null;
  private recognition: SpeechRecognitionType | null = null;
  private welcomePanel: UIKitMLAsset | null = null;
  readonly agentId = ELEVENLABS_AGENT_ID;

  // Interactive Voice Visualizer above Voice Agent Button
  private visualizerGroup: Group | null = null;
  private visualizerBars: Mesh[] = [];
  private visualizerMat: MeshBasicMaterial | null = null;
  private visualizerAnimTime = 0;
  private currentAgentState: 'idle' | 'connecting' | 'listening' | 'speaking' | 'disconnecting' = 'idle';
  private tempVec = new Vector3();
  private lastUserTranscript = '';

  // Real-time spatial visual awareness (on-demand tool calls)
  private latestUserView = 'User is looking at their spatial workspace.';
  private lastVisionCaptureTime = 0;
  private isCapturingVision = false;

  /** Sliding window of recent node creations to debounce echoed/repeated speech */
  private recentCreations: Array<{ id: string; type: NodeType; prompt: string; time: number }> = [];

  recordNodeCreation(id: string, type: NodeType, prompt: string): void {
    const now = Date.now();
    this.recentCreations.push({ id, type, prompt, time: now });
    this.recentCreations = this.recentCreations.filter((c) => now - c.time < 15000).slice(-10);
  }

  formatLayoutSummary(
    nodes: NodeData[],
    connections: ConnectionData[],
    selectedId?: string | null,
  ): string {
    const nodesData = this.getActiveNodesData();
    const checklistInfo = this.getChecklistData();

    if (nodesData.totalCount === 0 && checklistInfo.totalCount === 0) {
      return 'The VR workspace is currently empty. No nodes or tasks exist.';
    }

    const sections: string[] = [
      `Workspace Summary: ${nodesData.naturalSummary}`,
      `Selected Node: ${selectedId || 'none'}`,
      '',
      nodesData.activeNodesText,
      '',
      `Connections: ${nodesData.connectionsText}`,
      '',
      '=== Active Tasks & Checklist ===',
      checklistInfo.formattedSummary,
      '================================',
    ];

    return sections.join('\n');
  }

  getChecklistData(): {
    totalCount: number;
    completedCount: number;
    pendingCount: number;
    allTasks: { index: number; text: string; done: boolean }[];
    pendingTasks: { index: number; text: string }[];
    completedTasks: { index: number; text: string }[];
    formattedSummary: string;
    pendingText: string;
    completedText: string;
    naturalSummary: string;
  } {
    // 1. Gather tasks from ChecklistSystem sidebar if running
    let rawTasks: { text: string; done: boolean }[] = [];
    const getSidebarTasks = (window as any).__weavrGetChecklistTasks;
    if (typeof getSidebarTasks === 'function') {
      const sidebarTasks = getSidebarTasks();
      if (Array.isArray(sidebarTasks) && sidebarTasks.length > 0) {
        rawTasks = sidebarTasks.map((t: any) => ({
          text: String(t.text || '').trim(),
          done: Boolean(t.done),
        }));
      }
    }

    // 2. Fallback or combine with Checklist nodes in workflowGraph
    if (rawTasks.length === 0) {
      const checklistNodes = workflowGraph.allNodes().filter((n) => n.type === 'Checklist');
      for (const node of checklistNodes) {
        if (Array.isArray(node.checklist) && node.checklist.length > 0) {
          for (const item of node.checklist) {
            rawTasks.push({
              text: String(item.text || '').trim(),
              done: Boolean(item.done),
            });
          }
        }
      }
    }

    const allTasks = rawTasks.map((t, i) => ({
      index: i + 1,
      text: t.text,
      done: t.done,
    }));

    const pendingTasks = allTasks
      .filter((t) => !t.done)
      .map((t) => ({ index: t.index, text: t.text }));

    const completedTasks = allTasks
      .filter((t) => t.done)
      .map((t) => ({ index: t.index, text: t.text }));

    const totalCount = allTasks.length;
    const completedCount = completedTasks.length;
    const pendingCount = pendingTasks.length;

    let formattedSummary = '';
    let pendingText = '';
    let completedText = '';
    let naturalSummary = '';

    if (totalCount === 0) {
      formattedSummary = 'No tasks currently in the checklist.';
      pendingText = 'No pending tasks.';
      completedText = 'No completed tasks.';
      naturalSummary = 'The user has no tasks on their checklist.';
    } else {
      const pLines = pendingTasks.map((t) => `  ${t.index}. [PENDING] ${t.text}`);
      const cLines = completedTasks.map((t) => `  ${t.index}. [COMPLETED] ${t.text}`);

      pendingText = pendingTasks.length > 0
        ? pendingTasks.map((t) => `#${t.index}: "${t.text}"`).join('; ')
        : 'None (all tasks completed)';

      completedText = completedTasks.length > 0
        ? completedTasks.map((t) => `#${t.index}: "${t.text}"`).join('; ')
        : 'None yet';

      formattedSummary = [
        `Checklist (${completedCount}/${totalCount} completed, ${pendingCount} pending):`,
        pendingTasks.length > 0 ? `Pending Tasks (${pendingCount}):\n${pLines.join('\n')}` : 'All tasks are completed!',
        completedTasks.length > 0 ? `Completed Tasks (${completedCount}):\n${cLines.join('\n')}` : '',
      ].filter(Boolean).join('\n');

      if (pendingCount === 0) {
        naturalSummary = `The user has completed all ${totalCount} tasks on their checklist.`;
      } else {
        const pendingNames = pendingTasks.map((t) => `"${t.text}"`).slice(0, 3).join(', ');
        const more = pendingCount > 3 ? ` and ${pendingCount - 3} more` : '';
        naturalSummary = `The user has ${totalCount} total tasks: ${completedCount} completed, ${pendingCount} pending (${pendingNames}${more}).`;
      }
    }

    return {
      totalCount,
      completedCount,
      pendingCount,
      allTasks,
      pendingTasks,
      completedTasks,
      formattedSummary,
      pendingText,
      completedText,
      naturalSummary,
    };
  }

  getActiveNodesData(): {
    totalCount: number;
    nodes: NodeData[];
    activeNodesText: string;
    naturalSummary: string;
    typesSummary: string;
    connectionsText: string;
    nodeList: { index: number; id: string; type: string; prompt: string; details: string }[];
  } {
    const nodes = workflowGraph.allNodes();
    const connections = [...workflowGraph.connections.values()];
    const selectedId = (window as any).__weavrSelectedNodeId || null;

    if (nodes.length === 0) {
      return {
        totalCount: 0,
        nodes: [],
        activeNodesText: 'No nodes are currently active in the workspace. It is completely empty.',
        naturalSummary: 'The workspace is currently empty with no active nodes.',
        typesSummary: 'None',
        connectionsText: 'No wire connections exist between nodes.',
        nodeList: [],
      };
    }

    const typeCounts: Record<string, number> = {};
    const nodeList = nodes.map((node, i) => {
      typeCounts[node.type] = (typeCounts[node.type] || 0) + 1;

      let details = `State: ${node.state}`;
      if (node.type === 'Visualize') {
        if (node.visConfig?.math?.conceptType) {
          details += ` | 3D Math: ${node.visConfig.math.conceptType}${node.visConfig.math.highlightName ? ` (highlighted: ${node.visConfig.math.highlightName})` : ''}`;
        } else if (node.visConfig) {
          const chartName = node.visConfig.chartType === 'pie3d'
            ? '3D Pie Chart'
            : node.visConfig.chartType === 'bar3d'
              ? '3D Bar Chart'
              : node.visConfig.chartType === 'bar2d'
                ? '2D Flat Bar'
                : '3D Scatter Plot';
          details += ` | ${chartName} (${node.visConfig.yAxis} by ${node.visConfig.xAxis})`;
        }
      } else if (node.type === 'Model3D') {
        details += ` | Scale: ${node.modelScale ?? 1.0}${node.modelUrl ? ' (3D Model Ready)' : ' (Generating 3D Model...)'}`;
      } else if (node.type === 'Video') {
        details += node.videoUrl ? ' (Runway Video Ready)' : ' (Generating Runway Video...)';
      } else if (node.type === 'ImageGen' || node.type === 'ImageInput' || node.type === 'ImageCombine') {
        details += node.imageUrl ? ' (Image Ready)' : ' (Generating Image...)';
      } else if (node.type === 'Checklist' && node.checklist) {
        const done = node.checklist.filter((t) => t.done).length;
        details += ` | ${done}/${node.checklist.length} tasks completed`;
      }

      // Check wire connections
      const incoming = connections.filter((c) => c.targetNodeId === node.id);
      const outgoing = connections.filter((c) => c.sourceNodeId === node.id);
      if (incoming.length > 0) {
        details += ` | Connected from: Node "${incoming.map((c) => c.sourceNodeId).join(', ')}"`;
      }
      if (outgoing.length > 0) {
        details += ` | Connected to: Node "${outgoing.map((c) => c.targetNodeId).join(', ')}"`;
      }

      return {
        index: i + 1,
        id: node.id,
        type: node.type,
        prompt: node.prompt || 'Untitled',
        details,
      };
    });

    const lines = nodeList.map((n) => {
      const isSel = selectedId === n.id ? ' [SELECTED]' : '';
      return `  #${n.index}: [${n.type}] "${n.prompt}"${isSel} (${n.details})`;
    });

    const activeNodesText = [
      `Active Nodes in Workspace (${nodes.length} total):`,
      lines.join('\n'),
    ].join('\n');

    // Natural summary
    const typeSummaries = Object.entries(typeCounts).map(([type, count]) => {
      const label = count === 1 ? nodeTypeLabel(type as NodeType) : `${count} ${nodeTypeLabel(type as NodeType)}s`;
      return label;
    });
    const typesSummary = typeSummaries.join(', ');

    const promptNames = nodes.map((n) => `"${n.prompt || n.type}"`).slice(0, 4).join(', ');
    const more = nodes.length > 4 ? ` and ${nodes.length - 4} more` : '';
    const naturalSummary = `The workspace currently has ${nodes.length} node(s) (${typesSummary}), including ${promptNames}${more}.`;

    const connectionsText = connections.length > 0
      ? connections.map((c) => `Wire from Node "${c.sourceNodeId}" to Node "${c.targetNodeId}"`).join('; ')
      : 'No wire connections exist between nodes.';

    return {
      totalCount: nodes.length,
      nodes,
      activeNodesText,
      naturalSummary,
      typesSummary,
      connectionsText,
      nodeList,
    };
  }

  findRelatedNode(
    type: NodeType,
    prompt = '',
    extraParams?: any,
  ): { node: NodeData; reason: string } | null {
    const now = Date.now();
    const allNodes = workflowGraph.allNodes();
    if (allNodes.length === 0) return null;

    // 1. Debounce rapid repeat speech / interim audio repeats (within 3 seconds) for exact same prompt
    for (const rec of this.recentCreations) {
      if (now - rec.time < 3000) {
        if (rec.type === type) {
          const overlap = calculateWordOverlap(prompt, rec.prompt);
          if (overlap >= 0.85 && prompt.trim().length > 3) {
            const existing = workflowGraph.getNode(rec.id);
            if (existing) {
              return {
                node: existing,
                reason: `recently created ${nodeTypeLabel(type)} for "${existing.prompt}"`,
              };
            }
          }
        }
      }
    }

    // 2. Specialized Check: 3D Models
    if (type === 'Model3D') {
      const modelNodes = allNodes.filter((n) => n.type === 'Model3D');
      for (const node of modelNodes) {
        if (!prompt || prompt.toLowerCase().includes('3d model') || prompt.toLowerCase().includes('model')) {
          return { node, reason: `3D model "${node.prompt}"` };
        }
        const overlap = calculateWordOverlap(prompt, node.prompt);
        if (overlap >= 0.45) {
          return { node, reason: `3D model of "${node.prompt}"` };
        }
      }
    }

    // 3. Specialized Check: Visualize Nodes (Math Concepts & Data Charts)
    if (type === 'Visualize') {
      const visNodes = allNodes.filter((n) => n.type === 'Visualize');
      const isMath = extraParams?.isMath || extraParams?.chartType === 'math3d' || extraParams?.math;
      const concept = extraParams?.concept || extraParams?.conceptType || extraParams?.math?.conceptType;

      if (isMath && concept) {
        const conceptStr = String(concept).toLowerCase();
        for (const node of visNodes) {
          const existingConcept = node.visConfig?.math?.conceptType?.toLowerCase();
          if (existingConcept && (existingConcept === conceptStr || conceptStr.includes(existingConcept) || existingConcept.includes(conceptStr))) {
            return {
              node,
              reason: `3D mathematical concept "${node.visConfig?.math?.title || existingConcept}"`,
            };
          }
        }
      }

      // Check general data visualization topic overlap
      const queryTopic = prompt || extraParams?.title || extraParams?.xAxis || '';
      if (queryTopic) {
        for (const node of visNodes) {
          const existingTitle = node.prompt || (node.visConfig as any)?.title || '';
          const overlap = calculateWordOverlap(queryTopic, existingTitle);
          if (overlap >= 0.45) {
            return { node, reason: `data visualization for "${existingTitle}"` };
          }
        }
      }
    }

    // 4. Text Nodes
    if (type === 'Text' && prompt) {
      const textNodes = allNodes.filter((n) => n.type === 'Text');
      for (const node of textNodes) {
        const overlap = calculateWordOverlap(prompt, node.prompt);
        if (overlap >= 0.6) {
          return { node, reason: `prompt text "${node.prompt}"` };
        }
      }
    }

    return null;
  }

  informUser(node: NodeData, message: string): void {
    console.log(`[WeaVR Intelligent Agent] Informed user: "${message}" (Node: ${node.id})`);

    // 1. Highlight / Select existing node in VR workspace
    (window as any).__weavrSelectedNodeId = node.id;
    window.dispatchEvent(
      new CustomEvent('weavr:select-node', { detail: { nodeId: node.id } }),
    );

    // 2. Display visual notification on Welcome Panel / HUD
    const listeningText = this.welcomePanel?.getElementById('listening-text');
    if (listeningText) {
      listeningText.setProperties({
        text: `💡 Notice: ${message}`,
        display: 'flex',
      });
      setTimeout(() => {
        if (listeningText) {
          listeningText.setProperties({
            text: '',
            display: 'none',
          });
        }
      }, 5000);
    }

    // 3. Fallback speech synthesis if ElevenLabs agent is not currently connected
    if (
      !this.conversation &&
      typeof window !== 'undefined' &&
      'speechSynthesis' in window
    ) {
      try {
        window.speechSynthesis.cancel();
        const spoken = cleanSpokenText(message);
        if (spoken) {
          const utter = new SpeechSynthesisUtterance(spoken);
          utter.rate = 1.05;
          utter.pitch = 1.0;
          window.speechSynthesis.speak(utter);
        }
      } catch {}
    }
  }

  // ---------------------------------------------------------------------------
  // Real-Time Spatial Vision & View Analysis
  // ---------------------------------------------------------------------------

  getSpatialFieldOfView(): {
    directlyInFront: string[];
    periphery: string[];
    behind: string[];
    summary: string;
  } {
    const camera = (this.world as any)?.camera;
    const allNodes = workflowGraph.allNodes();
    const directlyInFront: string[] = [];
    const periphery: string[] = [];
    const behind: string[] = [];

    if (!camera) {
      const names = allNodes.map((n) => `${nodeTypeLabel(n.type)} "${n.prompt || n.type}"`);
      return {
        directlyInFront: names,
        periphery: [],
        behind: [],
        summary: allNodes.length > 0 ? `Active objects in workspace: ${names.join(', ')}.` : 'Open creative workspace with spatial controls.',
      };
    }

    const camPos = new Vector3();
    const camDir = new Vector3();
    camera.getWorldPosition(camPos);
    camera.getWorldDirection(camDir);

    for (const node of allNodes) {
      const nodePos = new Vector3(node.position[0], node.position[1], node.position[2]);
      const toNode = nodePos.clone().sub(camPos);
      const distance = toNode.length();
      toNode.normalize();

      const dot = camDir.dot(toNode);
      const crossY = camDir.clone().cross(toNode).y;
      const side = crossY > 0 ? 'left' : 'right';
      const label = `${nodeTypeLabel(node.type)} "${node.prompt || node.type}" (${distance.toFixed(1)}m away)`;

      if (dot > 0.6) {
        directlyInFront.push(label);
      } else if (dot > 0.05) {
        periphery.push(`${label} on the ${side}`);
      } else {
        behind.push(`${label} (behind you)`);
      }
    }

    const checklistInfo = this.getChecklistData();
    if (checklistInfo.totalCount > 0) {
      directlyInFront.push(`Checklist Panel (${checklistInfo.pendingCount} pending task${checklistInfo.pendingCount === 1 ? '' : 's'})`);
    }

    const summaryParts: string[] = [];
    const sem = (window as any)?.IWER_DEVICE?.sem;
    if (sem) {
      summaryParts.push(
        'Simulated Environment: 3D Sunlit Living Room featuring a large wooden bookshelf with books and decor, sofa, furniture, hardwood floor, and sunny windows.',
      );
    }

    if (directlyInFront.length > 0) {
      summaryParts.push(`Directly in front of user: ${directlyInFront.join(', ')}.`);
    } else {
      summaryParts.push('Directly in front: open workspace view facing the room environment and spatial controls.');
    }
    if (periphery.length > 0) {
      summaryParts.push(`In periphery: ${periphery.join(', ')}.`);
    }
    if (behind.length > 0) {
      summaryParts.push(`Behind user: ${behind.join(', ')}.`);
    }

    return {
      directlyInFront,
      periphery,
      behind,
      summary: summaryParts.join(' '),
    };
  }

  captureCanvasFrame(): string | null {
    if (typeof document === 'undefined') return null;

    try {
      const renderer = (this.world as any)?.renderer;
      const scene = (this.world as any)?.scene;
      const camera = (this.world as any)?.camera;

      // Identify emulator environment canvas (SEM) and Three.js application canvas
      const sem = (window as any)?.IWER_DEVICE?.sem;
      const envCanvas: HTMLCanvasElement | null = sem?.environmentCanvas || null;
      const appCanvas: HTMLCanvasElement | null =
        (renderer?.domElement as HTMLCanvasElement) ||
        (document.querySelector('canvas') as HTMLCanvasElement | null);

      // Collect all canvas elements in the document
      const allCanvases = Array.from(document.querySelectorAll('canvas')) as HTMLCanvasElement[];

      const baseCanvas = appCanvas || envCanvas || allCanvases[0];
      if (!baseCanvas || baseCanvas.width === 0 || baseCanvas.height === 0) return null;

      // Downscale to 640px width for fast upload and low token latency
      const targetW = 640;
      const scale = targetW / baseCanvas.width;
      const targetH = Math.max(1, Math.round(baseCanvas.height * scale));

      const thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = targetW;
      thumbCanvas.height = targetH;
      const ctx = thumbCanvas.getContext('2d');
      if (!ctx) return null;

      // Neutral background base
      ctx.fillStyle = '#222226';
      ctx.fillRect(0, 0, targetW, targetH);

      // 1. Draw IWER SEM environment canvas first (the 3D room, bookshelf, sofa, walls)
      if (envCanvas && envCanvas.width > 0 && envCanvas.height > 0) {
        try {
          ctx.drawImage(envCanvas, 0, 0, targetW, targetH);
        } catch {}
      }

      // 2. Draw any background/emulator canvases in the DOM
      for (const c of allCanvases) {
        if (c !== appCanvas && c !== envCanvas && c.width > 100 && c.height > 100) {
          try {
            ctx.drawImage(c, 0, 0, targetW, targetH);
          } catch {}
        }
      }

      // 3. Draw application 3D WebXR canvas on top
      if (appCanvas && appCanvas.width > 0 && appCanvas.height > 0) {
        try {
          ctx.drawImage(appCanvas, 0, 0, targetW, targetH);
        } catch {}
      }

      return thumbCanvas.toDataURL('image/jpeg', 0.72);
    } catch (err) {
      console.warn('[WeaVR Vision] captureCanvasFrame error:', err);
      try {
        const canvas = document.querySelector('canvas') as HTMLCanvasElement | null;
        if (canvas) return canvas.toDataURL('image/jpeg', 0.6);
      } catch {}
      return null;
    }
  }

  getFacingEnvironmentDescription(): string {
    const camera = (this.world as any)?.camera;
    if (!camera) return 'Facing the 3D room environment.';

    const camDir = new Vector3();
    camera.getWorldDirection(camDir);

    // Living room layout angles:
    // +X: Bookshelf and media console
    // -Z: Sofa, lamp, and wall art
    // -X: Sunny window, armchair, and fig plant
    // +Z: Dining table, chairs, and entrance door
    if (camDir.x > 0.45 && camDir.z >= -0.25) {
      return 'Directly facing the tall wooden bookshelf with shelves of books, ceramics, and decor on the right wall.';
    } else if (camDir.x > 0.45 && camDir.z < -0.25) {
      return 'Facing the media console with TV and the bookshelf on the right wall.';
    } else if (camDir.z < -0.45) {
      return 'Facing the sofa with pillows and framed art on the back wall.';
    } else if (camDir.x < -0.45) {
      return 'Facing the large sunlit window with curtains, armchair, and fig tree on the left wall.';
    } else if (camDir.z > 0.45) {
      return 'Facing the dining table with chairs and the entrance door on the front wall.';
    }

    return 'Looking forward across the living room.';
  }

  async analyzeCurrentView(force = false): Promise<string> {
    const now = Date.now();
    if (this.isCapturingVision) return this.latestUserView;
    if (!force && now - this.lastVisionCaptureTime < 2500) return this.latestUserView;

    const frameData = this.captureCanvasFrame();
    const facingContext = this.getFacingEnvironmentDescription();

    if (!frameData) {
      this.latestUserView = facingContext;
      return this.latestUserView;
    }

    this.isCapturingVision = true;
    try {
      const res = await fetch('http://localhost:3001/api/vision-describe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: frameData,
          environmentContext: facingContext,
        }),
      });

      if (res.ok) {
        const json = await res.json();
        if (json.description) {
          this.latestUserView = json.description;
          this.lastVisionCaptureTime = Date.now();
          (window as any).__weavrLatestUserView = json.description;
          console.log('[WeaVR Vision] Real-time view analyzed:', this.latestUserView);
          return json.description;
        }
      }
    } catch (err) {
      console.warn('[WeaVR Vision] Analyze view error:', err);
    } finally {
      this.isCapturingVision = false;
    }

    return this.latestUserView || facingContext;
  }

  init(): void {
    // Get reference to welcome panel for listening indicator
    this.welcomePanel = this.world.getSceneObject<UIKitMLAsset>(
      'welcome-panel',
    ) as UIKitMLAsset | null;

    // Wire up mic button on welcome panel
    const micButton = this.welcomePanel?.getElementById('mic-button');
    if (micButton) {
      const onClick = () => this.toggleListening();
      micButton.addEventListener('click', onClick);
      this.cleanupFuncs.push(() =>
        micButton.removeEventListener('click', onClick),
      );
    }

    // Initialize small voice visualizer above the Voice Agent button
    this.initVisualizer();

    // Initialise Speech Recognition as graceful fallback
    this.initSpeechRecognition();

    // Listen for single node execution requests
    const onExecSingle = (e: any) => {
      const nodeId = e.detail?.nodeId;
      if (nodeId) {
        const node = workflowGraph.getNode(nodeId);
        if (node?.type === 'ImageCombine') {
          this.runCombineNode(nodeId);
        } else if (node?.type === 'Model3D') {
          this.runModel3DNode(nodeId);
        } else if (node?.type === 'Video') {
          this.runVideoNode(nodeId);
        } else if (node?.type === 'ImageGen' || node?.type === 'ImageInput') {
          this.runSingleNode(nodeId);
        }
      }
    };
    window.addEventListener('weavr:execute-single', onExecSingle);
    this.cleanupFuncs.push(() =>
      window.removeEventListener('weavr:execute-single', onExecSingle),
    );

    // Listen for ElevenLabs Conversational Voice Agent actions & messages
    const onAgentMessage = (e: any) => {
      const text = e.detail?.text || e.detail?.message;
      if (typeof text === 'string') {
        this.processAgentText(text);
      } else if (e.detail?.action) {
        this.executeAgentAction(e.detail.action);
      }
    };
    const onAgentAction = (e: any) => {
      if (e.detail) this.executeAgentAction(e.detail);
    };
    const onShiftNode = (e: any) => {
      if (e.detail) this.shiftNodePosition(e.detail);
    };
    window.addEventListener('weavr:agent-message', onAgentMessage);
    window.addEventListener('weavr:agent-action', onAgentAction);
    window.addEventListener('weavr:shift-node', onShiftNode);
    this.cleanupFuncs.push(() => {
      window.removeEventListener('weavr:agent-message', onAgentMessage);
      window.removeEventListener('weavr:agent-action', onAgentAction);
      window.removeEventListener('weavr:shift-node', onShiftNode);
    });
  }

  private initSpeechRecognition(): void {
    const SpeechRecognition =
      (window as any).SpeechRecognition ??
      (window as any).webkitSpeechRecognition;
    if (SpeechRecognition == null) {
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US';
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: any) => {
      const transcript: string = event.results[0][0].transcript;
      console.log('[WeaVR WebSpeech Fallback] Voice:', transcript);
      this.handleTranscript(transcript);
    };

    recognition.onerror = (event: any) => {
      console.warn('[WeaVR WebSpeech Fallback] Speech error:', event.error);
      this.setListeningState('idle');
    };

    recognition.onend = () => {
      this.setListeningState('idle');
    };

    this.recognition = recognition;
  }

  async toggleListening(): Promise<void> {
    // If ElevenLabs conversation is active, disconnect it
    if (this.conversation) {
      console.log('[WeaVR ElevenLabs] Disconnecting voice session...');
      this.setListeningState('disconnecting');
      try {
        await this.conversation.endSession();
      } catch (err) {
        console.warn('[WeaVR ElevenLabs] Error ending session:', err);
      }
      this.conversation = null;
      this.setListeningState('idle');
      return;
    }

    try {
      console.log('[WeaVR ElevenLabs] Starting session with agent:', this.agentId);
      this.setListeningState('connecting');

      // Request microphone permissions
      if (navigator.mediaDevices?.getUserMedia) {
        await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      const allCurrentNodes = workflowGraph.allNodes();
      const allCurrentConns = [...workflowGraph.connections.values()];
      const activeSelectedId = (window as any).__weavrSelectedNodeId || 'none';
      const layoutSummary = this.formatLayoutSummary(allCurrentNodes, allCurrentConns, activeSelectedId);
      const checklistData = this.getChecklistData();
      const nodesData = this.getActiveNodesData();

      const conversation = await Conversation.startSession({
        agentId: this.agentId,
        dynamicVariables: {
          current_layout: layoutSummary,
          active_nodes: nodesData.activeNodesText,
          workspace_summary: nodesData.naturalSummary,
          nodes_summary: nodesData.naturalSummary,
          node_types: nodesData.typesSummary,
          connections: nodesData.connectionsText,
          node_count: allCurrentNodes.length,
          selected_node: activeSelectedId,
          checklist: checklistData.formattedSummary,
          tasks: checklistData.formattedSummary,
          pending_tasks: checklistData.pendingText,
          completed_tasks: checklistData.completedText,
          task_summary: checklistData.naturalSummary,
          pending_count: checklistData.pendingCount,
          completed_count: checklistData.completedCount,
          total_tasks: checklistData.totalCount,
        },
        onConnect: ({ conversationId }) => {
          console.log('[WeaVR ElevenLabs] Connected! Conversation ID:', conversationId);
          this.setListeningState('listening');
        },
        onDisconnect: (details) => {
          console.log('[WeaVR ElevenLabs] Disconnected:', details);
          this.conversation = null;
          this.setListeningState('idle');
        },
        onError: (message, context) => {
          console.error('[WeaVR ElevenLabs] Error:', message, context);
        },
        onModeChange: ({ mode }) => {
          console.log('[WeaVR ElevenLabs] Mode:', mode);
          this.setListeningState(mode as any);
        },
        onStatusChange: ({ status }) => {
          console.log('[WeaVR ElevenLabs] Status:', status);
        },
        onMessage: (payload) => {
          console.log(`[WeaVR ElevenLabs ${payload.source}]:`, payload.message);
          if (payload.source === 'ai' && payload.message) {
            const handled = this.processAgentText(payload.message);
            // If AI message did not contain an action, but user gave a task command:
            if (!handled && this.lastUserTranscript) {
              const cmd = parseCommand(this.lastUserTranscript);
              if (
                cmd.action === 'shiftNode' ||
                cmd.action === 'moveNodes' ||
                cmd.action === 'addChecklistItem' ||
                cmd.action === 'checkTask' ||
                cmd.action === 'editTask' ||
                cmd.action === 'deleteTask' ||
                cmd.action === 'clearTasks'
              ) {
                console.log('[WeaVR Voice] Executing user command as AI fallback:', cmd);
                this.executeCommand(cmd);
              }
              this.lastUserTranscript = '';
            }
          } else if (payload.source === 'user' && payload.message) {
            this.lastUserTranscript = payload.message;
            // Immediate optimistic execution for direct user commands
            const cmd = parseCommand(payload.message);
            if (
              cmd.action === 'shiftNode' ||
              cmd.action === 'moveNodes' ||
              cmd.action === 'addChecklistItem' ||
              cmd.action === 'checkTask' ||
              cmd.action === 'editTask' ||
              cmd.action === 'deleteTask' ||
              cmd.action === 'clearTasks'
            ) {
              console.log('[WeaVR Voice] Immediate user voice command:', cmd);
              this.executeCommand(cmd);
              this.lastUserTranscript = '';
            }
          }
        },
        clientTools: {
          get_user_view: async () => {
            console.log('[WeaVR ElevenLabs Client Tool] get_user_view called');
            const viewDesc = await this.analyzeCurrentView(true);
            return `What the User is Currently Facing:
${viewDesc || this.getFacingEnvironmentDescription()}

Spoken instruction: In 1-2 natural conversational sentences, describe ONLY what the user is currently facing in their direct line of sight (such as the bookshelf, furniture, or view directly in front). Do NOT describe other parts of the room or workspace nodes. NEVER read aloud code, coordinates, or JSON.`;
          },
          inspect_surroundings: async () => {
            console.log('[WeaVR ElevenLabs Client Tool] inspect_surroundings called');
            const viewDesc = await this.analyzeCurrentView(true);
            return `What the User is Currently Facing:
${viewDesc || this.getFacingEnvironmentDescription()}

Spoken instruction: In 1-2 natural conversational sentences, describe ONLY what the user is currently facing in their direct line of sight. Do NOT describe other parts of the room or workspace nodes. NEVER read aloud code, coordinates, or JSON.`;
          },
          look_around: async () => {
            console.log('[WeaVR ElevenLabs Client Tool] look_around called');
            const viewDesc = await this.analyzeCurrentView(true);
            return `What the User is Currently Facing:
${viewDesc || this.getFacingEnvironmentDescription()}

Spoken instruction: In 1-2 natural conversational sentences, describe what is directly in front of the user. Do NOT mention workspace nodes. NEVER read aloud code, coordinates, or JSON.`;
          },
          get_active_nodes: async () => {
            console.log('[WeaVR ElevenLabs Client Tool] get_active_nodes called');
            const data = this.getActiveNodesData();
            return `Current Workspace Active Nodes:\n${data.activeNodesText}\nSummary: ${data.naturalSummary}\nConnections: ${data.connectionsText}\nSpoken instruction: Summarize what nodes are currently in the workspace in one natural conversational sentence. NEVER read aloud raw JSON, coordinates, or code syntax.`;
          },
          get_nodes: async () => {
            console.log('[WeaVR ElevenLabs Client Tool] get_nodes called');
            const data = this.getActiveNodesData();
            return `Current Workspace Active Nodes:\n${data.activeNodesText}\nSummary: ${data.naturalSummary}\nConnections: ${data.connectionsText}\nSpoken instruction: Summarize what nodes are currently in the workspace in one natural conversational sentence. NEVER read aloud raw JSON, coordinates, or code syntax.`;
          },
          get_workspace_layout: async () => {
            console.log('[WeaVR ElevenLabs Client Tool] get_workspace_layout called');
            const nodes = workflowGraph.allNodes();
            const conns = [...workflowGraph.connections.values()];
            const selected = (window as any).__weavrSelectedNodeId || null;
            const summary = this.formatLayoutSummary(nodes, conns, selected);
            return `Current VR Workspace Layout:\n${summary}\nSpoken instruction: Summarize or refer to these nodes naturally in conversation. NEVER read aloud raw CSV rows, coordinates, code blocks, or JSON syntax.`;
          },
          visualize_data: async (params: any) => {
            console.log('[WeaVR ElevenLabs Client Tool] visualize_data:', params);
            const isPie = params.chartType === 'pie3d' || /\b(pie|piechart)\b/i.test(params.title || '');
            const targetType = isPie ? 'pie3d' : (params.chartType || 'bar3d');
            const related = this.findRelatedNode('Visualize', params.title || params.xAxis, { isData: true, ...params });
            if (related) {
              if (related.node.visConfig && related.node.visConfig.chartType !== targetType) {
                this.executeAgentAction({ type: 'toggle_vis_mode', chartType: targetType, mode: params.mode || '3d' });
                return `Success: Switched existing chart to ${targetType === 'pie3d' ? '3D pie chart' : targetType}. Spoken instruction: Tell the user in one natural sentence that the chart has been updated. NEVER read aloud raw CSV rows, coordinates, code blocks, or JSON syntax.`;
              }
              this.informUser(related.node, `You already have a chart for "${related.node.prompt}" in your workspace.`);
              return `A related chart for "${related.node.prompt}" is already present in the workspace. Spoken instruction: Tell the user in one natural sentence: "You already have a chart for ${related.node.prompt} in your workspace! I have selected it for you." NEVER read aloud raw CSV rows, coordinates, code blocks, or JSON syntax.`;
            }
            this.executeAgentAction({ type: 'visualize_data', ...params });
            return 'Success: 3D data visualization spawned in VR workspace. Spoken instruction: Tell the user in one natural conversational sentence that their 3D chart has been created. NEVER read aloud raw CSV rows, coordinates, code blocks, or JSON syntax.';
          },
          create_3d_model: async (params: any) => {
            console.log('[WeaVR ElevenLabs Client Tool] create_3d_model:', params);
            const related = this.findRelatedNode('Model3D', params.prompt, params);
            if (related) {
              this.informUser(related.node, `You already have a 3D model for "${related.node.prompt}" in your workspace.`);
              return `A related 3D model for "${related.node.prompt}" is already present in the workspace. Spoken instruction: Tell the user in one natural sentence: "You already have a 3D model for ${related.node.prompt} in your workspace! I have selected it for you." NEVER read aloud raw CSV rows, coordinates, code blocks, or JSON syntax.`;
            }
            this.executeAgentAction({ type: 'create_3d_model', ...params });
            return 'Success: Started generating 3D model with Meshy AI. Spoken instruction: Tell the user in one natural conversational sentence that you are generating their 3D model. NEVER read aloud raw CSV rows, coordinates, code blocks, or JSON syntax.';
          },
          create_video: async (params: any) => {
            console.log('[WeaVR ElevenLabs Client Tool] create_video:', params);
            this.executeAgentAction({ type: 'create_video', ...params });
            const subject = params.sourceNodeId || params.imageNode || params.subject || params.image || '';
            const subjectLabel = subject ? ` from the ${subject} image` : '';
            return `Success: Generating Runway video${subjectLabel} in VR workspace. Spoken instruction: Tell the user in one natural conversational sentence that their video is being generated with Runway based on the requested image. NEVER read aloud raw CSV rows, coordinates, code blocks, or JSON syntax.`;
          },
          create_image_nodes: async (params: any) => {
            console.log('[WeaVR ElevenLabs Client Tool] create_image_nodes:', params);
            const count = Math.max(1, Math.min(5, Number(params.count) || Number(params.numberOfImages) || Number(params.numImages) || 1));
            this.executeAgentAction({ type: 'create_image_nodes', ...params, count });
            const label = count > 1 ? `${count} image generation nodes` : 'image generation node';
            return `Success: Spawned ${label} in VR workspace. Spoken instruction: Tell the user in one natural conversational sentence that their ${label} are generating. NEVER read aloud raw CSV rows, coordinates, code blocks, or JSON syntax.`;
          },
          connect_image_references: async (params: any) => {
            console.log('[WeaVR ElevenLabs Client Tool] connect_image_references:', params);
            this.executeAgentAction({ type: 'connect_image_references', ...params });
            return 'Success: Connected reference images to a new image generation node in VR workspace. Spoken instruction: Tell the user in one natural sentence. NEVER read aloud raw CSV rows, coordinates, code blocks, or JSON syntax.';
          },
          combine_images: async (params: any) => {
            console.log('[WeaVR ElevenLabs Client Tool] combine_images:', params);
            this.executeAgentAction({ type: 'combine_images', ...params });
            return 'Success: Initiated image blending in VR workspace. Spoken instruction: Tell the user in one natural sentence. NEVER read aloud raw CSV rows, coordinates, code blocks, or JSON syntax.';
          },
          resize_3d_model: async (params: any) => {
            console.log('[WeaVR ElevenLabs Client Tool] resize_3d_model:', params);
            this.executeAgentAction({ type: 'resize_3d_model', ...params });
            return 'Success: Scaled 3D model in VR. Spoken instruction: Tell the user in one natural sentence that the 3D model has been resized. NEVER read aloud raw CSV rows, coordinates, code blocks, or JSON syntax.';
          },
          toggle_vis_mode: async (params: any) => {
            console.log('[WeaVR ElevenLabs Client Tool] toggle_vis_mode:', params);
            this.executeAgentAction({ type: 'toggle_vis_mode', ...params });
            const label = params.chartType || params.mode || '3D';
            return `Success: Switched visualization to ${label}. Spoken instruction: Tell the user in one natural sentence. NEVER read aloud raw CSV rows, coordinates, code blocks, or JSON syntax.`;
          },
          workspace_control: async (params: any) => {
            console.log('[WeaVR ElevenLabs Client Tool] workspace_control:', params);
            this.executeAgentAction({ type: 'workspace_control', ...params });
            return `Success: Executed workspace action. Spoken instruction: Tell the user in one natural sentence. NEVER read aloud raw CSV rows, coordinates, code blocks, or JSON syntax.`;
          },
          remove_chart: async () => {
            console.log('[WeaVR ElevenLabs Client Tool] remove_chart called');
            this.executeAgentAction({ type: 'remove_chart' });
            return 'Success: Removed chart visualization from VR workspace. Spoken instruction: Tell the user in one natural sentence. NEVER read aloud raw CSV rows, coordinates, code blocks, or JSON syntax.';
          },
          color_chart: async (params: any) => {
            console.log('[WeaVR ElevenLabs Client Tool] color_chart:', params);
            this.executeAgentAction({ type: 'color_chart', ...params });
            return `Success: Updated chart color. Spoken instruction: Tell the user in one natural sentence. NEVER read aloud raw CSV rows, coordinates, code blocks, or JSON syntax.`;
          },
          get_tasks: async () => {
            console.log('[WeaVR ElevenLabs Client Tool] get_tasks called');
            const data = this.getChecklistData();
            return `Current User Tasks:\n${data.formattedSummary}\nSpoken instruction: Summarize the user's tasks and clearly tell them what is pending or completed in one natural conversational sentence. NEVER read aloud raw JSON or code syntax.`;
          },
          get_checklist: async () => {
            console.log('[WeaVR ElevenLabs Client Tool] get_checklist called');
            const data = this.getChecklistData();
            return `Current User Tasks:\n${data.formattedSummary}\nSpoken instruction: Summarize the user's tasks and clearly tell them what is pending or completed in one natural conversational sentence. NEVER read aloud raw JSON or code syntax.`;
          },
          manage_checklist: async (params: any) => {
            console.log('[WeaVR ElevenLabs Client Tool] manage_checklist:', params);
            return this.handleManageChecklist(params);
          },
          manage_tasks: async (params: any) => {
            console.log('[WeaVR ElevenLabs Client Tool] manage_tasks:', params);
            return this.handleManageChecklist(params);
          },
          update_task: async (params: any) => {
            console.log('[WeaVR ElevenLabs Client Tool] update_task:', params);
            return this.handleManageChecklist(params);
          },
          delete_all: async () => {
            console.log('[WeaVR ElevenLabs Client Tool] delete_all called');
            this.executeAgentAction({ type: 'delete_all' });
            return 'Success: Cleared all nodes and visualizations from VR workspace. Spoken instruction: Tell the user in one natural sentence that the workspace is cleared. NEVER read aloud raw CSV rows, coordinates, code blocks, or JSON syntax.';
          },
          delete_node: async (params: any) => {
            console.log('[WeaVR ElevenLabs Client Tool] delete_node:', params);
            const query = params.nodeId || params.target || params.nodeType || params.title || params.prompt || 'this';
            this.executeAgentAction({ type: 'delete_node', target: query });
            return `Success: Deleted node "${query}" from VR workspace. Spoken instruction: Tell the user in one natural sentence that the node was removed. NEVER read aloud raw CSV rows, coordinates, code blocks, or JSON syntax.`;
          },
          visualize_math: async (params: any) => {
            console.log('[WeaVR ElevenLabs Client Tool] visualize_math:', params);
            const related = this.findRelatedNode('Visualize', params.concept || params.title, { isMath: true, concept: params.concept, ...params });
            if (related) {
              if (params.highlight || params.highlightName || params.color) {
                this.executeAgentAction({ type: 'highlight_math', ...params });
                return `Success: Updated highlight on existing ${related.node.prompt} in VR workspace. Spoken instruction: Tell the user in one natural sentence. NEVER read aloud raw CSV rows, coordinates, code blocks, or JSON syntax.`;
              }
              this.informUser(related.node, `You already have a 3D visualization for "${related.node.prompt}" in your workspace.`);
              return `A related 3D mathematical visualization for "${related.node.prompt}" is already present in the workspace. Spoken instruction: Tell the user in one natural sentence: "You already have a 3D visualization for ${related.node.prompt} in your workspace! I have selected it for you." NEVER read aloud raw CSV rows, coordinates, code blocks, or JSON syntax.`;
            }
            this.executeAgentAction({ type: 'visualize_math', ...params });
            return `Success: Visualized ${params.concept || params.title || 'mathematical concept'} in 3D. Spoken instruction: Tell the user in one natural conversational sentence that their 3D math visualization has been created. NEVER read aloud raw CSV rows, coordinates, code blocks, or JSON syntax.`;
          },
          highlight_math: async (params: any) => {
            console.log('[WeaVR ElevenLabs Client Tool] highlight_math:', params);
            this.executeAgentAction({ type: 'highlight_math', ...params });
            return `Success: Highlighted mathematical element. Spoken instruction: Tell the user in one natural sentence. NEVER read aloud raw CSV rows, coordinates, code blocks, or JSON syntax.`;
          },
          shift_node_position: async (params: any) => {
            console.log('[WeaVR ElevenLabs Client Tool] shift_node_position:', params);
            const res = this.shiftNodePosition(params);
            return `${res.success ? 'Success' : 'Notice'}: ${res.message} Spoken instruction: Tell the user in one natural conversational sentence that you shifted the node. NEVER read aloud raw coordinates, code blocks, or JSON syntax.`;
          },
          move_node: async (params: any) => {
            console.log('[WeaVR ElevenLabs Client Tool] move_node:', params);
            const res = this.shiftNodePosition(params);
            return `${res.success ? 'Success' : 'Notice'}: ${res.message} Spoken instruction: Tell the user in one natural conversational sentence that you moved the node. NEVER read aloud raw coordinates, code blocks, or JSON syntax.`;
          },
          shift_node: async (params: any) => {
            console.log('[WeaVR ElevenLabs Client Tool] shift_node:', params);
            const res = this.shiftNodePosition(params);
            return `${res.success ? 'Success' : 'Notice'}: ${res.message} Spoken instruction: Tell the user in one natural conversational sentence that you shifted the node. NEVER read aloud raw coordinates, code blocks, or JSON syntax.`;
          },
          reposition_node: async (params: any) => {
            console.log('[WeaVR ElevenLabs Client Tool] reposition_node:', params);
            const res = this.shiftNodePosition(params);
            return `${res.success ? 'Success' : 'Notice'}: ${res.message} Spoken instruction: Tell the user in one natural conversational sentence that you repositioned the node. NEVER read aloud raw coordinates, code blocks, or JSON syntax.`;
          },
        },
      });

      this.conversation = conversation;
    } catch (err) {
      console.error('[WeaVR ElevenLabs] Failed to start ElevenLabs session:', err);
      this.setListeningState('idle');

      // Graceful fallback to Web Speech API
      if (this.recognition) {
        try {
          this.recognition.start();
          this.setListeningState('listening');
          console.log('[WeaVR] Web Speech fallback active');
        } catch {}
      }
    }
  }

  private updateVisualizerPosition(): void {
    const micButton = this.welcomePanel?.getElementById('mic-button');
    if (!micButton || !this.visualizerGroup || !this.welcomePanel) return;

    micButton.updateMatrixWorld();
    micButton.getWorldPosition(this.tempVec);
    this.welcomePanel.worldToLocal(this.tempVec);
    // Sit directly above the Voice Agent button (Y = +0.38 above button center, Z = +0.02)
    this.visualizerGroup.position.set(this.tempVec.x, this.tempVec.y + 0.38, this.tempVec.z + 0.02);
  }

  private initVisualizer(): void {
    if (!this.welcomePanel) return;

    this.visualizerGroup = new Group();
    this.visualizerGroup.name = 'voice-visualizer-group';
    this.visualizerGroup.visible = false;

    // Small rounded equalizer bar geometry: 5px diameter, bottom pivot
    const barGeom = new CylinderGeometry(0.025, 0.025, 1, 16);
    barGeom.translate(0, 0.5, 0); // Scale upwards from bottom

    this.visualizerMat = new MeshBasicMaterial({
      color: new Color(0x38BDF8),
      transparent: true,
      opacity: 0.95,
      side: DoubleSide,
    });

    this.visualizerBars = [];
    for (let i = 0; i < 5; i++) {
      const bar = new Mesh(barGeom, this.visualizerMat);
      const x = (i - 2) * 0.12;
      bar.position.set(x, 0, 0);
      bar.scale.set(1, 0.06, 1);
      this.visualizerGroup.add(bar);
      this.visualizerBars.push(bar);
    }

    this.welcomePanel.add(this.visualizerGroup);
    this.updateVisualizerPosition();

    this.cleanupFuncs.push(() => {
      barGeom.dispose();
      this.visualizerMat?.dispose();
      this.visualizerGroup?.removeFromParent();
    });
  }

  private setListeningState(
    state: 'idle' | 'connecting' | 'listening' | 'speaking' | 'disconnecting',
  ): void {
    this.currentAgentState = state;
    this.updateVisualizerPosition();

    const micLabel = this.welcomePanel?.getElementById('mic-label');
    const listeningText = this.welcomePanel?.getElementById('listening-text');
    const toolbar = this.world.getSceneObject<UIKitMLAsset>('toolbar-panel');
    const voiceLabel = toolbar?.getElementById('voice-label');

    let labelText = 'Voice Agent';
    let indicatorText = '';
    let showIndicator = false;
    let toolbarText = 'Voice';

    switch (state) {
      case 'connecting':
        labelText = 'Connecting...';
        indicatorText = 'Connecting...';
        showIndicator = true;
        toolbarText = 'Connecting...';
        if (this.visualizerGroup) {
          this.visualizerGroup.visible = true;
          this.visualizerMat?.color.setHex(0x38BDF8);
        }
        break;

      case 'listening':
        labelText = 'Disconnect';
        indicatorText = '';
        showIndicator = false;
        toolbarText = 'Listening...';
        if (this.visualizerGroup) {
          this.visualizerGroup.visible = true;
          this.visualizerMat?.color.setHex(0x00D2FF);
        }
        break;

      case 'speaking':
        labelText = 'Disconnect';
        indicatorText = '';
        showIndicator = false;
        toolbarText = 'Speaking...';
        if (this.visualizerGroup) {
          this.visualizerGroup.visible = true;
          this.visualizerMat?.color.setHex(0x00FF88);
        }
        break;

      case 'disconnecting':
        labelText = 'Disconnecting...';
        indicatorText = '';
        showIndicator = false;
        toolbarText = 'Disconnecting...';
        if (this.visualizerGroup) {
          this.visualizerGroup.visible = false;
        }
        break;

      case 'idle':
      default:
        labelText = 'Voice Agent';
        indicatorText = '';
        showIndicator = false;
        toolbarText = 'Voice';
        if (this.visualizerGroup) {
          this.visualizerGroup.visible = false;
        }
        break;
    }

    if (micLabel) {
      micLabel.setProperties({ text: labelText });
    }
    if (listeningText) {
      listeningText.setProperties({
        text: indicatorText,
        display: showIndicator ? 'flex' : 'none',
      });
    }
    if (voiceLabel) {
      voiceLabel.setProperties({ text: toolbarText });
    }
  }

  // -----------------------------------------------------------------------
  // ElevenLabs / Agent Action Processing
  // -----------------------------------------------------------------------

  processAgentText(text: string): boolean {
    let executed = false;

    // 1. XML <action>...</action>
    const match = text.match(/<action>([\s\S]*?)<\/action>/i);
    if (match) {
      try {
        const parsed = JSON.parse(match[1].trim());
        this.executeAgentAction(parsed);
        executed = true;
      } catch (err) {
        console.warn('[WeaVR] Failed to parse agent action JSON from <action> tag:', err);
      }
    }

    // 2. Markdown codeblock ```json ... ```
    if (!executed) {
      const codeMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
      if (codeMatch) {
        try {
          const parsed = JSON.parse(codeMatch[1].trim());
          this.executeAgentAction(parsed);
          executed = true;
        } catch (err) {
          console.warn('[WeaVR] Failed to parse agent action JSON from codeblock:', err);
        }
      }
    }

    // 3. Embedded JSON object with known keys
    if (!executed) {
      const jsonMatch = text.match(/(\{(?:[^{}]|"(?:\\.|[^"\\])*")*\})/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[1].trim());
          if (parsed.action || parsed.type || parsed.csvData || parsed.prompt || parsed.text) {
            this.executeAgentAction(parsed);
            executed = true;
          }
        } catch {}
      }
    }

    return executed;
  }

  executeAgentAction(action: any): void {
    if (!action || typeof action !== 'object') return;
    console.log('[WeaVR Agent Action]:', action);

    // Normalize action type
    let actionType = action.type;
    const rawAct = String(action.action || '').toLowerCase();

    if (!actionType) {
      if (
        ['create', 'add', 'edit', 'modify', 'rename', 'update', 'check', 'complete', 'uncheck', 'undone', 'delete', 'clear', 'toggle'].includes(rawAct) &&
        (action.text || action.target || action.task || rawAct === 'clear')
      ) {
        actionType = 'manage_checklist';
      } else if (['delete_all', 'clear_all', 'undo', 'redo', 'reset_view'].includes(rawAct)) {
        actionType = 'workspace_control';
      } else if (['visualize_data', 'chart', 'plot'].includes(rawAct) || action.csvData || action.chartType || action.visConfig) {
        actionType = 'visualize_data';
      } else if (['visualize_math', 'math'].includes(rawAct) || action.concept || action.math) {
        actionType = 'visualize_math';
      } else if (['resize_3d_model', 'scale', 'resize'].includes(rawAct) || action.scale || action.scaleMultiplier || action.multiplier) {
        actionType = 'resize_3d_model';
      } else if (['create_3d_model', '3d_model', 'model3d'].includes(rawAct) || (action.prompt && (rawAct.includes('3d') || rawAct.includes('model')))) {
        actionType = 'create_3d_model';
      } else if (
        ['shift_node', 'shift_node_position', 'move_node', 'reposition_node', 'shift', 'move', 'translate', 'nudge', 'reposition'].includes(rawAct) ||
        (action.direction && (rawAct.includes('shift') || rawAct.includes('move') || rawAct.includes('node') || rawAct.includes('position'))) ||
        action.dx != null ||
        action.dy != null ||
        action.dz != null
      ) {
        actionType = 'shift_node';
      } else if (['create_video', 'generate_video', 'video'].includes(rawAct) || (action.prompt && rawAct.includes('video'))) {
        actionType = 'create_video';
      } else if (['create_image_nodes', 'image', 'imagegen'].includes(rawAct) || action.prompt) {
        actionType = 'create_image_nodes';
      }
    }

    if (
      actionType === 'create_task' ||
      actionType === 'add_task' ||
      actionType === 'edit_task' ||
      actionType === 'check_task' ||
      actionType === 'checklist' ||
      actionType === 'task' ||
      actionType === 'manage_checklist' ||
      Boolean(action.checklist)
    ) {
      actionType = 'manage_checklist';
    }

    switch (actionType) {
      case 'visualize_data': {
        const isPie = action.chartType === 'pie3d' || /\b(pie|piechart)\b/i.test(action.title || '') || /\b(pie|piechart)\b/i.test(action.prompt || '');
        const targetType = isPie ? 'pie3d' : (action.chartType || 'bar3d');
        const related = this.findRelatedNode('Visualize', action.title || action.xAxis, { isData: true, ...action });
        if (related) {
          if (related.node.visConfig && related.node.visConfig.chartType !== targetType) {
            workflowGraph.updateNode(related.node.id, {
              visConfig: {
                ...related.node.visConfig,
                chartType: targetType,
                mode: action.mode || '3d',
              },
            });
            console.log(`[WeaVR Agent] Updated existing Visualize node ${related.node.id} to chartType: ${targetType}`);
            return;
          }
          this.informUser(related.node, `You already have a data visualization for "${related.node.prompt}" in your workspace.`);
          return;
        }

        const pos = workflowGraph.findFreePosition();
        const initialData: Record<string, any> = {};
        if (action.csvData) {
          initialData.csvData = action.csvData;
          initialData.parsedData = parseCSV(action.csvData);
        }
        initialData.visConfig = {
          chartType: targetType,
          mode: action.mode || '3d',
          xAxis: action.xAxis || 'x',
          yAxis: action.yAxis || 'y',
          zAxis: action.zAxis,
        };
        const newNode = workflowGraph.addNode(
          'Visualize',
          action.title || 'Data Visualization',
          pos,
          initialData,
        );
        this.recordNodeCreation(newNode.id, 'Visualize', action.title || 'Data Visualization');
        console.log(`[WeaVR Agent] Created Visualize node ${newNode.id} for "${action.title}"`);
        break;
      }

      case 'visualize_math': {
        const related = this.findRelatedNode('Visualize', action.concept || action.title, { isMath: true, ...action });
        if (related) {
          if (action.highlight || action.highlightName || action.color) {
            this.executeAgentAction({ type: 'highlight_math', ...action });
          } else {
            this.informUser(related.node, `You already have a 3D visualization for "${related.node.prompt}" in your workspace.`);
          }
          return;
        }

        const pos = workflowGraph.findFreePosition();
        const concept = String(action.concept || action.conceptType || 'pythagoras').toLowerCase();
        let conceptType: any = 'pythagoras';
        let defaultTitle = 'Pythagorean Theorem (3D)';
        let defaultFormula = 'a² + b² = c²';

        if (concept.includes('cube') || concept.includes('euler') || concept.includes('polyhedr')) {
          conceptType = 'cube';
          defaultTitle = 'Cube & Euler Formula (V - E + F = 2)';
          defaultFormula = 'V=8, E=12, F=6';
        } else if (concept.includes('saddle') || concept.includes('hyperbolic')) {
          conceptType = 'saddle';
          defaultTitle = 'Hyperbolic Paraboloid (Saddle Surface)';
          defaultFormula = 'z = x² - y²';
        } else if (concept.includes('paraboloid') || concept.includes('bowl')) {
          conceptType = 'paraboloid';
          defaultTitle = 'Elliptic Paraboloid';
          defaultFormula = 'z = x² + y²';
        } else if (concept.includes('circle') || concept.includes('trig') || concept.includes('sine') || concept.includes('cosine')) {
          conceptType = 'unit_circle';
          defaultTitle = 'Trigonometric Unit Circle';
          defaultFormula = 'sin²(θ) + cos²(θ) = 1';
        } else if (concept.includes('cross') || concept.includes('vector')) {
          conceptType = 'cross_product';
          defaultTitle = 'Vector Cross Product (A × B)';
          defaultFormula = 'C = A × B ⟂ A, B';
        } else if (concept.includes('torus') || concept.includes('donut')) {
          conceptType = 'torus';
          defaultTitle = 'Torus Surface & Curvature';
          defaultFormula = '(R - √(x²+y²))² + z² = r²';
        }

        const initialData: Record<string, any> = {
          visConfig: {
            chartType: 'math3d',
            mode: '3d',
            xAxis: 'x',
            yAxis: 'y',
            zAxis: 'z',
            math: {
              conceptType,
              title: action.title || defaultTitle,
              formula: action.formula || defaultFormula,
              explanation: action.explanation || '3D mathematical concept visualization with highlights.',
              highlightName: action.highlight || action.highlightName || (conceptType === 'pythagoras' ? 'hypotenuse' : undefined),
              highlightColor: action.highlightColor || action.color || 'neon green',
            },
          },
        };

        const newNode = workflowGraph.addNode(
          'Visualize',
          action.title || defaultTitle,
          pos,
          initialData,
        );
        this.recordNodeCreation(newNode.id, 'Visualize', action.title || defaultTitle);
        console.log(`[WeaVR Agent] Created 3D Math Visualization node ${newNode.id} for "${defaultTitle}"`);
        break;
      }

      case 'highlight_math': {
        const visNodes = workflowGraph.allNodes().filter((n) => n.type === 'Visualize');
        const selectedId = (window as any).__weavrSelectedNodeId;
        const selectedNode = selectedId ? workflowGraph.getNode(selectedId) : null;
        const targetNode = (selectedNode?.type === 'Visualize' ? selectedNode : null) || visNodes.pop();
        if (targetNode && targetNode.visConfig) {
          const currentMath = targetNode.visConfig.math || { conceptType: 'pythagoras' };
          const highlightName = action.target || action.element || action.name || 'hypotenuse';
          const highlightColor = action.color || action.highlightColor || 'neon green';

          workflowGraph.updateNode(targetNode.id, {
            visConfig: {
              ...targetNode.visConfig,
              chartType: 'math3d',
              math: {
                ...currentMath,
                highlightName,
                highlightColor,
              },
            },
          });
          console.log(`[WeaVR Agent] Highlighted math element "${highlightName}" in ${highlightColor} on node ${targetNode.id}`);
        }
        break;
      }

      case 'create_3d_model': {
        const related = this.findRelatedNode('Model3D', action.prompt, action);
        if (related) {
          this.informUser(related.node, `You already have a 3D model for "${related.node.prompt}" in your workspace.`);
          return;
        }

        const pos = workflowGraph.findFreePosition();
        const newNode = workflowGraph.addNode(
          'Model3D',
          action.prompt || '3D Model',
          pos,
        );
        this.recordNodeCreation(newNode.id, 'Model3D', action.prompt || '3D Model');
        if (action.fromSelectedImage) {
          const imageNodes = workflowGraph
            .allNodes()
            .filter((n) => n.type === 'ImageGen' || n.type === 'ImageInput' || n.type === 'ImageCombine');
          const lastImage = imageNodes.pop();
          if (lastImage) {
            workflowGraph.addConnection(lastImage.id, 0, newNode.id, 1);
          }
        }
        this.runModel3DNode(newNode.id);
        break;
      }

      case 'create_video':
      case 'generate_video': {
        const srcId =
          action.sourceNodeId ||
          action.sourceId ||
          action.nodeId ||
          action.imageNode ||
          action.referenceNodeId ||
          action.targetNodeId ||
          action.source ||
          action.subject ||
          action.image;
        this.connectVideoNode(
          srcId,
          action.prompt ||
            action.promptText ||
            'cinematic motion with dynamic camera movement',
        );
        break;
      }

      case 'create_image_nodes': {
        if (
          action.fromReferences ||
          action.useReferences ||
          action.fromImages ||
          action.referenceImages
        ) {
          const imageNodes = workflowGraph
            .allNodes()
            .filter(
              (n) =>
                n.type === 'ImageGen' ||
                n.type === 'ImageInput' ||
                n.type === 'ImageCombine',
            );
          const count = Math.max(1, Math.min(3, Number(action.referenceCount) || 2));
          const sources = imageNodes.slice(-count);
          if (sources.length > 0) {
            this.connectNewImageNode(
              sources.map((s) => s.id),
              action.prompt || 'a creative composition using reference images',
            );
            break;
          }
        }
        const count = Math.max(
          1,
          Math.min(
            5,
            Number(action.count) ||
              Number(action.numberOfImages) ||
              Number(action.numImages) ||
              1,
          ),
        );
        this.createNodes(count, 'ImageGen', action.prompt || 'a beautiful scene');
        break;
      }

      case 'connect_image_references': {
        const imageNodes = workflowGraph
          .allNodes()
          .filter(
            (n) =>
              n.type === 'ImageGen' ||
              n.type === 'ImageInput' ||
              n.type === 'ImageCombine',
          );
        let sourceIds: string[] = [];
        if (Array.isArray(action.sourceNodeIds) && action.sourceNodeIds.length > 0) {
          sourceIds = action.sourceNodeIds;
        } else if (Array.isArray(action.sources) && action.sources.length > 0) {
          sourceIds = action.sources;
        } else if (imageNodes.length >= 3) {
          sourceIds = imageNodes.slice(0, 2).map((n) => n.id);
        } else if (imageNodes.length >= 2) {
          sourceIds = imageNodes.slice(-2).map((n) => n.id);
        } else if (imageNodes.length === 1) {
          sourceIds = [imageNodes[0].id];
        }

        if (sourceIds.length > 0) {
          this.connectNewImageNode(
            sourceIds,
            action.prompt || 'a cohesive new composition combining reference images',
          );
        }
        break;
      }

      case 'combine_images': {
        const imageNodes = workflowGraph
          .allNodes()
          .filter((n) => n.type === 'ImageGen' || n.type === 'ImageInput' || n.type === 'ImageCombine');
        if (imageNodes.length >= 2) {
          const ids = imageNodes.slice(-2).map((n) => n.id);
          this.combineImageNodes(ids);
        }
        break;
      }

      case 'resize_3d_model': {
        const candidateNodes = workflowGraph
          .allNodes()
          .filter((n) => n.type === 'Model3D' || n.type === 'Visualize');
        const selectedId = (window as any).__weavrSelectedNodeId;
        const selectedNode = selectedId ? workflowGraph.getNode(selectedId) : null;
        const targetNode =
          (selectedNode && (selectedNode.type === 'Model3D' || selectedNode.type === 'Visualize')
            ? selectedNode
            : null) ||
          candidateNodes.find((n) => n.type === 'Visualize') ||
          candidateNodes.pop();
        if (targetNode) {
          const currentScale = targetNode.modelScale ?? 1.0;
          let newScale = currentScale;
          const mult = Number(action.scaleMultiplier) || Number(action.multiplier);
          if (mult != null && !isNaN(mult) && mult > 0) {
            newScale = Math.max(0.1, Math.min(8.0, currentScale * mult));
          } else if (action.scale != null && !isNaN(Number(action.scale))) {
            newScale = Math.max(0.1, Math.min(8.0, Number(action.scale)));
          } else {
            newScale = 1.0;
          }
          workflowGraph.updateNode(targetNode.id, { modelScale: newScale });
          console.log(`[WeaVR 3D] Agent resized ${targetNode.type} ${targetNode.id} to scale: ${newScale.toFixed(2)}`);
        }
        break;
      }

      case 'toggle_vis_mode': {
        const visNodes = workflowGraph.allNodes().filter((n) => n.type === 'Visualize');
        const target = visNodes.pop();
        if (target && target.visConfig) {
          const isTargetPie = action.chartType === 'pie3d' || /\b(pie|piechart)\b/i.test(action.title || action.prompt || '');
          const mode = isTargetPie ? '3d' : (action.mode === 'flat' ? 'flat' : '3d');
          const newChartType =
            isTargetPie
              ? 'pie3d'
              : action.chartType ||
                (mode === 'flat'
                  ? 'bar2d'
                  : target.visConfig.chartType === 'bar2d'
                    ? 'scatter3d'
                    : target.visConfig.chartType);
          workflowGraph.updateNode(target.id, {
            visConfig: {
              ...target.visConfig,
              mode,
              chartType: newChartType,
            },
          });
        }
        break;
      }

      case 'manage_checklist': {
        this.handleManageChecklist(action);
        break;
      }

      case 'workspace_control': {
        if (action.action === 'undo') {
          window.dispatchEvent(new CustomEvent('weavr:undo'));
        } else if (action.action === 'redo') {
          window.dispatchEvent(new CustomEvent('weavr:redo'));
        } else if (action.action === 'run_all') {
          this.runAllNodes();
        } else if (action.action === 'delete_last') {
          this.deleteNode('last');
        } else if (action.action === 'delete_all' || action.action === 'clear_all') {
          this.deleteAllNodes();
        }
        break;
      }

      case 'remove_chart': {
        const visNodes = workflowGraph.allNodes().filter((n) => n.type === 'Visualize');
        const targetNode = visNodes.pop();
        if (targetNode) {
          workflowGraph.removeNode(targetNode.id);
          console.log(`[WeaVR Agent] Removed chart node ${targetNode.id}`);
        }
        break;
      }

      case 'color_chart': {
        const visNodes = workflowGraph.allNodes().filter((n) => n.type === 'Visualize');
        const targetNode = visNodes.pop();
        if (targetNode && targetNode.visConfig) {
          const currentColors: Record<string, string> = { ...(targetNode.visConfig.customColors || {}) };
          if (action.colors && typeof action.colors === 'object') {
            for (const [key, val] of Object.entries(action.colors)) {
              currentColors[key] = String(val);
              currentColors[key.toLowerCase()] = String(val);
            }
          }
          if (action.target && action.color) {
            currentColors[action.target] = action.color;
            currentColors[action.target.toLowerCase()] = action.color;
          } else if (action.color && !action.target) {
            // Apply color to all categories or first column
            currentColors['*'] = action.color;
          }
          workflowGraph.updateNode(targetNode.id, {
            visConfig: {
              ...targetNode.visConfig,
              customColors: currentColors,
            },
          });
          console.log(`[WeaVR Agent] Updated chart colors for node ${targetNode.id}:`, currentColors);
        }
        break;
      }

      case 'delete_all': {
        this.deleteAllNodes();
        break;
      }

      case 'delete_node': {
        const query = action.nodeId || action.target || action.nodeType || action.title || action.prompt || 'this';
        this.deleteNode(query);
        break;
      }

      case 'shift_node':
      case 'shift_node_position':
      case 'move_node':
      case 'reposition_node': {
        this.shiftNodePosition(action);
        break;
      }
    }
  }

  // -----------------------------------------------------------------------
  // Command dispatch (OpenAI Assistant first, local fallback)
  // -----------------------------------------------------------------------

  private async handleTranscript(transcript: string): Promise<void> {
    console.log('[WeaVR Voice] User said:', transcript);

    // Collect all existing nodes and connections from workflowGraph
    const nodes = workflowGraph.allNodes();
    const connections = [...workflowGraph.connections.values()];

    try {
      const BACKEND_URL =
        (typeof import.meta !== 'undefined' &&
          (import.meta as any).env?.VITE_WEAVR_API_URL) ||
        'http://localhost:3001';

      const res = await fetch(`${BACKEND_URL}/api/assistant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript,
          nodes,
          connections,
          selectedNodeId: (window as any).__weavrSelectedNodeId || null,
        }),
      });

      if (res.ok) {
        const plan = await res.json();
        console.log('[WeaVR AI Assistant Plan]:', plan);
        await this.applyAIPlan(plan);
        return;
      }
    } catch (err) {
      console.warn(
        '[WeaVR AI Assistant] AI endpoint unavailable, falling back to local NLP parser:',
        err,
      );
    }

    // Fallback: local pattern-matching command parser
    const command = parseCommand(transcript);
    console.log('[WeaVR Local Parser] Command:', command);
    this.executeCommand(command);
  }

  private async applyAIPlan(plan: {
    explanation?: string;
    nodesToCreate?: Array<{
      tempId: string;
      type: NodeType;
      prompt: string;
      csvData?: string;
      visConfig?: VisConfig;
      autoRun?: boolean;
    }>;
    nodesToUpdate?: Array<{
      id: string;
      prompt?: string;
      modelScale?: number;
      visConfig?: VisConfig;
      autoRun?: boolean;
    }>;
    nodesToDelete?: string[];
    connectionsToCreate?: Array<{
      sourceId: string;
      sourcePort: number;
      targetId: string;
      targetPort: number;
    }>;
    connectionsToDelete?: string[];
    nodesToExecute?: string[];
  }): Promise<void> {
    // Map to translate tempId -> real nodeId
    const idMap = new Map<string, string>();

    // 1. Delete nodes & connections
    if (plan.nodesToDelete && plan.nodesToDelete.length > 0) {
      for (const id of plan.nodesToDelete) {
        workflowGraph.removeNode(id);
      }
    }
    if (plan.connectionsToDelete && plan.connectionsToDelete.length > 0) {
      for (const connId of plan.connectionsToDelete) {
        workflowGraph.removeConnection(connId);
      }
    }

    // 2. Update existing nodes
    if (plan.nodesToUpdate && plan.nodesToUpdate.length > 0) {
      for (const upd of plan.nodesToUpdate) {
        const existing = workflowGraph.getNode(upd.id);
        if (existing) {
          const patch: Partial<any> = {};
          if (upd.prompt != null) patch.prompt = upd.prompt;
          if (upd.modelScale != null) patch.modelScale = upd.modelScale;
          if (upd.visConfig != null) patch.visConfig = upd.visConfig;
          if ((upd as any).checklist != null) patch.checklist = (upd as any).checklist;
          if ((upd as any).position != null) {
            patch.position = (upd as any).position;
            patch.manuallyMoved = true;
          }
          if ((upd as any).shift != null) {
            this.shiftNodePosition({
              target: upd.id,
              ...((upd as any).shift),
            });
          }
          if (Object.keys(patch).length > 0) {
            workflowGraph.updateNode(upd.id, patch);
          }
        }
      }
    }

    if ((plan as any).nodesToShift && Array.isArray((plan as any).nodesToShift)) {
      for (const shiftSpec of (plan as any).nodesToShift) {
        this.shiftNodePosition(shiftSpec);
      }
    }

    // 3. Create new nodes with intelligent spatial positioning close to user
    if (plan.nodesToCreate && plan.nodesToCreate.length > 0) {
      const remainingSpecs: typeof plan.nodesToCreate = [];
      for (const spec of plan.nodesToCreate) {
        const related =
          spec.type === 'ImageGen' || spec.type === 'Video'
            ? null
            : this.findRelatedNode(spec.type, spec.prompt, spec);
        if (related) {
          idMap.set(spec.tempId, related.node.id);
          this.informUser(
            related.node,
            `You already have a related ${nodeTypeLabel(related.node.type)} for "${related.node.prompt}" in your workspace.`,
          );
        } else {
          remainingSpecs.push(spec);
        }
      }

      if (remainingSpecs.length > 0) {
        const count = remainingSpecs.length;
        const positions = workflowGraph.positionsForGroup(count);

        for (let i = 0; i < count; i++) {
          const spec = remainingSpecs[i];
          const pos = positions[i];
          const initialData: Record<string, any> = {};
          if (spec.csvData) {
            initialData.csvData = spec.csvData;
            initialData.parsedData = parseCSV(spec.csvData);
          }
          if (spec.visConfig) {
            initialData.visConfig = spec.visConfig;
          }
          if ((spec as any).checklist) {
            initialData.checklist = (spec as any).checklist;
          }

          const newNode = workflowGraph.addNode(
            spec.type,
            spec.prompt,
            pos,
            Object.keys(initialData).length > 0 ? initialData : undefined,
          );
          idMap.set(spec.tempId, newNode.id);
          this.recordNodeCreation(newNode.id, spec.type, spec.prompt);
          console.log(
            `[WeaVR AI] Created ${spec.type} (${newNode.id}) with prompt: "${spec.prompt}"`,
          );
        }
      }
    }

    // 4. Wire connections
    if (plan.connectionsToCreate && plan.connectionsToCreate.length > 0) {
      for (const conn of plan.connectionsToCreate) {
        const sourceRealId = idMap.get(conn.sourceId) ?? conn.sourceId;
        const targetRealId = idMap.get(conn.targetId) ?? conn.targetId;
        if (sourceRealId && targetRealId && sourceRealId !== targetRealId) {
          console.log(
            `[WeaVR AI] Connecting ${sourceRealId}:${conn.sourcePort} -> ${targetRealId}:${conn.targetPort}`,
          );
          workflowGraph.addConnection(
            sourceRealId,
            conn.sourcePort,
            targetRealId,
            conn.targetPort,
          );
        }
      }
    }

    // 5. Execute nodes requested by AI
    const nodesToRun = new Set<string>();

    if (plan.nodesToCreate) {
      for (const spec of plan.nodesToCreate) {
        if (
          spec.autoRun ??
          (spec.type === 'ImageGen' ||
            spec.type === 'Model3D' ||
            spec.type === 'Video')
        ) {
          const realId = idMap.get(spec.tempId);
          if (realId) nodesToRun.add(realId);
        }
      }
    }

    if (plan.nodesToExecute) {
      for (const target of plan.nodesToExecute) {
        const realId = idMap.get(target) ?? target;
        nodesToRun.add(realId);
      }
    }

    // Run in dependency order
    const executionOrder = workflowGraph.getExecutionOrder();
    const sortedNodesToRun = executionOrder.filter((id) => nodesToRun.has(id));
    for (const id of nodesToRun) {
      if (!sortedNodesToRun.includes(id)) {
        sortedNodesToRun.push(id);
      }
    }

    for (const nodeId of sortedNodesToRun) {
      const node = workflowGraph.getNode(nodeId);
      if (node?.type === 'ImageCombine') {
        this.runCombineNode(nodeId);
      } else if (node?.type === 'Model3D') {
        this.runModel3DNode(nodeId);
      } else if (node?.type === 'Video') {
        this.runVideoNode(nodeId);
      } else if (node?.type === 'ImageGen' || node?.type === 'ImageInput') {
        this.runSingleNode(nodeId);
      }
    }
  }

  private executeCommand(command: WorkflowAction): void {
    switch (command.action) {
      case 'createNodes':
        this.createNodes(command.count, command.type, command.prompt);
        break;

      case 'combineImages':
        this.combineImageNodes(command.nodeIds);
        break;

      case 'createVideo':
        this.connectVideoNode(command.sourceNodeId, command.prompt);
        break;

      case 'modifyImage':
        this.modifyImageNode(command.nodeId, command.prompt);
        break;

      case 'connectNewImage':
        this.connectNewImageNode(
          command.sourceNodeIds || command.sourceNodeId || '',
          command.prompt,
        );
        break;

      case 'connectNodes': {
        const srcNode = this.findTargetNode(command.sourceId);
        const tgtNode = this.findTargetNode(command.targetId);
        if (srcNode && tgtNode && srcNode.id !== tgtNode.id) {
          const inConns = workflowGraph.getInputConnections(tgtNode.id);
          let targetPort = 0;
          if (tgtNode.type === 'ImageGen') {
            if (srcNode.type === 'Text') targetPort = 0;
            else if (!inConns.some((c) => c.targetPort === 1)) targetPort = 1;
            else if (!inConns.some((c) => c.targetPort === 2)) targetPort = 2;
            else targetPort = 0;
          } else if (tgtNode.type === 'ImageCombine') {
            targetPort = inConns.some((c) => c.targetPort === 0) ? 1 : 0;
          } else if (tgtNode.type === 'Model3D') {
            targetPort =
              srcNode.type === 'Text'
                ? 0
                : inConns.some((c) => c.targetPort === 1)
                  ? 0
                  : 1;
          } else if (tgtNode.type === 'Video') {
            targetPort = srcNode.type === 'Text' ? 0 : 1;
          }
          workflowGraph.addConnection(srcNode.id, 0, tgtNode.id, targetPort);
          console.log(
            `[WeaVR Voice] Connected ${srcNode.id} -> ${tgtNode.id} port ${targetPort}`,
          );
        }
        break;
      }

      case 'variation':
        this.createVariation(command.sourceNodeId);
        break;

      case 'undo':
        window.dispatchEvent(new CustomEvent('weavr:undo'));
        break;

      case 'redo':
        window.dispatchEvent(new CustomEvent('weavr:redo'));
        break;

      case 'deleteNode':
        this.deleteNode(command.nodeId);
        break;

      case 'deleteAll':
        this.deleteAllNodes();
        break;

      case 'colorChart': {
        const visNodes = workflowGraph.allNodes().filter((n) => n.type === 'Visualize');
        const targetNode = visNodes.pop();
        if (targetNode && targetNode.visConfig) {
          const currentColors: Record<string, string> = { ...(targetNode.visConfig.customColors || {}) };
          if (command.colors) {
            for (const [key, val] of Object.entries(command.colors)) {
              currentColors[key] = String(val);
              currentColors[key.toLowerCase()] = String(val);
            }
          }
          if (command.target && command.color) {
            currentColors[command.target] = command.color;
            currentColors[command.target.toLowerCase()] = command.color;
          } else if (command.color && !command.target) {
            currentColors['*'] = command.color;
          }
          workflowGraph.updateNode(targetNode.id, {
            visConfig: {
              ...targetNode.visConfig,
              customColors: currentColors,
            },
          });
          console.log(`[WeaVR Voice] Colored chart bars:`, currentColors);
        }
        break;
      }

      case 'removeChart': {
        const visNodes = workflowGraph.allNodes().filter((n) => n.type === 'Visualize');
        const targetNode = visNodes.pop();
        if (targetNode) {
          workflowGraph.removeNode(targetNode.id);
          console.log(`[WeaVR Voice] Removed chart node ${targetNode.id}`);
        }
        break;
      }

      case 'toggleChecklist': {
        window.dispatchEvent(
          new CustomEvent('weavr:task-action', {
            detail: { action: 'toggle', target: command.target },
          }),
        );
        break;
      }

      case 'addChecklistItem': {
        window.dispatchEvent(
          new CustomEvent('weavr:task-action', {
            detail: { action: 'create', text: command.text },
          }),
        );
        break;
      }

      case 'checkTask': {
        window.dispatchEvent(
          new CustomEvent('weavr:task-action', {
            detail: { action: command.done ? 'check' : 'uncheck', target: command.target, done: command.done },
          }),
        );
        break;
      }

      case 'editTask': {
        window.dispatchEvent(
          new CustomEvent('weavr:task-action', {
            detail: { action: 'edit', target: command.target, text: command.newText },
          }),
        );
        break;
      }

      case 'deleteTask': {
        window.dispatchEvent(
          new CustomEvent('weavr:task-action', {
            detail: { action: 'delete', target: command.target },
          }),
        );
        break;
      }

      case 'clearTasks': {
        window.dispatchEvent(
          new CustomEvent('weavr:task-action', {
            detail: { action: 'clear' },
          }),
        );
        break;
      }

      case 'runAll':
        this.runAllNodes();
        break;

      case 'runNode':
        this.runSingleNode(command.nodeId);
        break;

      case 'resizeModel': {
        const candidateNodes = workflowGraph
          .allNodes()
          .filter((n) => n.type === 'Model3D' || n.type === 'Visualize');
        const selectedId = (window as any).__weavrSelectedNodeId;
        const selectedNode = selectedId ? workflowGraph.getNode(selectedId) : null;
        const targetNode =
          (selectedNode && (selectedNode.type === 'Model3D' || selectedNode.type === 'Visualize')
            ? selectedNode
            : null) ||
          (command.nodeId ? workflowGraph.getNode(command.nodeId) : null) ||
          candidateNodes.find((n) => n.type === 'Visualize') ||
          candidateNodes.pop();
        if (targetNode) {
          const currentScale = targetNode.modelScale ?? 1.0;
          const newScale =
            command.scaleMultiplier === 1.0
              ? 1.0
              : Math.max(0.1, Math.min(8.0, currentScale * command.scaleMultiplier));
          workflowGraph.updateNode(targetNode.id, { modelScale: newScale });
          console.log(
            `[WeaVR 3D] Voice resized ${targetNode.type} (${targetNode.id}) scale to: ${newScale.toFixed(2)}`,
          );
        }
        break;
      }

      case 'createDataPipeline': {
        const posGroup = workflowGraph.positionsForGroup(2);
        const visNode = workflowGraph.addNode('Visualize', '3D Scatter Plot', posGroup[0]);
        const exportNode = workflowGraph.addNode('Export', 'CSV & Summary Export', posGroup[1]);
        workflowGraph.addConnection(visNode.id, 0, exportNode.id, 0);
        console.log('[WeaVR] Created Visualize Node ➔ Export Node pipeline');
        break;
      }

      case 'toggleVisMode': {
        const visNodes = workflowGraph.allNodes().filter((n) => n.type === 'Visualize');
        const target = visNodes.pop();
        if (target && target.visConfig) {
          const isTargetPie = command.chartType === 'pie3d';
          const currentMode = target.visConfig.mode;
          const newMode = isTargetPie ? '3d' : (command.mode || (currentMode === '3d' ? 'flat' : '3d'));
          const newChartType =
            command.chartType ||
            (newMode === 'flat'
              ? 'bar2d'
              : target.visConfig.chartType === 'bar2d'
                ? 'scatter3d'
                : target.visConfig.chartType);
          workflowGraph.updateNode(target.id, {
            visConfig: {
              ...target.visConfig,
              mode: newMode,
              chartType: newChartType,
            },
          });
          console.log(`[WeaVR Vis] Toggled visualization mode to: ${newMode}, chartType: ${newChartType}`);
        }
        break;
      }

      case 'visualizeMath':
        this.executeAgentAction({
          type: 'visualize_math',
          conceptType: command.conceptType,
          highlightName: command.highlightName,
          highlightColor: command.highlightColor,
          title: command.title,
        });
        break;

      case 'highlightMath':
        this.executeAgentAction({
          type: 'highlight_math',
          target: command.target,
          color: command.color,
        });
        break;

      case 'shiftNode':
        this.shiftNodePosition(command);
        break;

      case 'moveNodes':
        this.shiftNodePosition({
          target: 'all',
          direction: command.direction === 'closer' ? 'closer' : 'further',
        });
        break;

      case 'unknown':
        console.log('[WeaVR] Unknown command:', command.transcript);
        break;
    }
  }

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  private createNodes(
    count: number,
    type: NodeType,
    prompt: string,
  ): void {
    if (type !== 'ImageGen' && type !== 'Video') {
      const related = this.findRelatedNode(type, prompt);
      if (related) {
        this.informUser(
          related.node,
          `You already have a related ${nodeTypeLabel(related.node.type)} for "${related.node.prompt}" in your workspace.`,
        );
        return;
      }
    }

    const positions = workflowGraph.positionsForGroup(count);
    const nodes = [];
    for (let i = 0; i < count; i++) {
      const node = workflowGraph.addNode(type, prompt, positions[i]);
      nodes.push(node);
      this.recordNodeCreation(node.id, type, prompt);

      if (type === 'Model3D') {
        const lastImage = workflowGraph
          .allNodes()
          .filter(
            (n) =>
              n.id !== node.id &&
              (n.type === 'ImageGen' ||
                n.type === 'ImageInput' ||
                n.type === 'ImageCombine'),
          )
          .pop();
        if (lastImage) {
          workflowGraph.addConnection(lastImage.id, 0, node.id, 1);
        } else {
          const lastText = workflowGraph
            .allNodes()
            .filter((n) => n.id !== node.id && n.type === 'Text')
            .pop();
          if (lastText) {
            workflowGraph.addConnection(lastText.id, 0, node.id, 0);
          }
        }
        this.runModel3DNode(node.id);
      }

      if (type === 'Video') {
        let sourceImage = this.findBestSourceImageNode(undefined, prompt);
        if (!sourceImage) {
          const imgPos = workflowGraph.findFreePosition();
          sourceImage = workflowGraph.addNode('ImageGen', prompt, imgPos);
          this.recordNodeCreation(sourceImage.id, 'ImageGen', prompt);
          this.runSingleNode(sourceImage.id);
        }
        if (sourceImage) {
          workflowGraph.addConnection(sourceImage.id, 0, node.id, 1);
          console.log(
            `[WeaVR Video] createNodes connected Image ${sourceImage.id} ("${sourceImage.prompt}") -> Video ${node.id} (port 1)`,
          );
        }
        this.runVideoNode(node.id);
      }
    }

    // Auto-execute image generation nodes
    if (type === 'ImageGen') {
      for (const node of nodes) {
        this.runSingleNode(node.id);
      }
    }
  }

  private combineImageNodes(nodeIds: string[]): void {
    if (nodeIds.length < 2) {
      console.warn('[WeaVR] Need at least 2 nodes to combine');
      return;
    }

    const inputNodes = nodeIds
      .map((id) => workflowGraph.getNode(id))
      .filter((n) => n != null);
    if (inputNodes.length < 2) return;

    const avgX =
      inputNodes.reduce((sum, n) => sum + n!.position[0], 0) /
      inputNodes.length;
    const avgY =
      inputNodes.reduce((sum, n) => sum + n!.position[1], 0) /
      inputNodes.length;

    // Use non-overlapping placement close to inputs
    const candidate: [number, number, number] = [
      avgX + 0.48,
      avgY,
      inputNodes[0]!.position[2],
    ];
    const pos =
      workflowGraph.positionsForGroup(1, candidate)[0] ??
      workflowGraph.findFreePosition();

    const combineNode = workflowGraph.addNode(
      'ImageCombine',
      'Combined image',
      pos,
    );

    // Connect input nodes to the combine node
    for (let i = 0; i < Math.min(inputNodes.length, 2); i++) {
      workflowGraph.addConnection(inputNodes[i]!.id, 0, combineNode.id, i);
    }

    // Execute the combine
    this.runCombineNode(combineNode.id);
  }

  private modifyImageNode(sourceNodeId: string, prompt: string): void {
    const sourceNode = workflowGraph.getNode(sourceNodeId);
    if (sourceNode == null) return;

    const candidate: [number, number, number] = [
      sourceNode.position[0] + 0.48,
      sourceNode.position[1],
      sourceNode.position[2],
    ];
    const pos =
      workflowGraph.positionsForGroup(1, candidate)[0] ??
      workflowGraph.findFreePosition();

    const newNode = workflowGraph.addNode('ImageGen', prompt, pos);
    workflowGraph.addConnection(sourceNodeId, 0, newNode.id, 1);
    this.runSingleNode(newNode.id);
  }

  private connectNewImageNode(
    sourceNodeIds: string[] | string,
    prompt = 'a cohesive new composition combining reference images',
  ): void {
    const ids = Array.isArray(sourceNodeIds) ? sourceNodeIds : [sourceNodeIds];
    const sourceNodes = ids
      .map((id) => workflowGraph.getNode(id))
      .filter((n): n is NodeData => Boolean(n));
    if (sourceNodes.length === 0) return;

    const allImageNodes = workflowGraph
      .allNodes()
      .filter((n) => n.type === 'ImageGen' || n.type === 'ImageInput' || n.type === 'ImageCombine');

    // Check if an unoccupied target ImageGen node already exists (e.g. user selected it or created a 3rd empty node)
    const selectedId = (window as any).__weavrSelectedNodeId;
    const selectedNode = selectedId ? workflowGraph.getNode(selectedId) : null;
    let targetNode: NodeData | null = null;

    if (selectedNode && selectedNode.type === 'ImageGen' && !sourceNodes.some((s) => s.id === selectedNode.id)) {
      targetNode = selectedNode;
    } else {
      // If there is an existing ImageGen node that has 0 input connections and is not one of the sources
      const candidate = allImageNodes.find(
        (n) => n.type === 'ImageGen' && !sourceNodes.some((s) => s.id === n.id) && workflowGraph.getInputConnections(n.id).length === 0,
      );
      if (candidate) {
        targetNode = candidate;
      }
    }

    if (!targetNode) {
      const avgX =
        sourceNodes.reduce((sum, n) => sum + n.position[0], 0) / sourceNodes.length;
      const avgY =
        sourceNodes.reduce((sum, n) => sum + n.position[1], 0) / sourceNodes.length;
      const candidate: [number, number, number] = [
        avgX + 0.48,
        avgY,
        sourceNodes[0].position[2],
      ];
      const pos =
        workflowGraph.positionsForGroup(1, candidate)[0] ??
        workflowGraph.findFreePosition();

      targetNode = workflowGraph.addNode('ImageGen', prompt, pos);
      this.recordNodeCreation(targetNode.id, 'ImageGen', prompt);
    } else if (prompt) {
      workflowGraph.updateNode(targetNode.id, { prompt });
    }

    let imagePort = 1;
    for (const source of sourceNodes) {
      if (source.type === 'Text') {
        workflowGraph.addConnection(source.id, 0, targetNode.id, 0);
      } else {
        workflowGraph.addConnection(source.id, 0, targetNode.id, imagePort);
        imagePort++;
      }
    }
    this.runSingleNode(targetNode.id);
  }

  /**
   * Intelligently resolves the best matching image node based on:
   * 1. Exact node ID match
   * 2. Semantic & keyword matching on subject words (e.g. "bird", "flower", "car")
   * 3. Numerical / ordinal matches ("first", "second", "node 1")
   * 4. Currently selected node in VR
   * 5. Most recent valid image node
   */
  findBestSourceImageNode(query?: string, prompt?: string): NodeData | null {
    const allImageNodes = workflowGraph
      .allNodes()
      .filter(
        (n) =>
          n.type === 'ImageGen' ||
          n.type === 'ImageInput' ||
          n.type === 'ImageCombine',
      );

    if (allImageNodes.length === 0) return null;

    const selectedId = (window as any).__weavrSelectedNodeId;
    const selectedNode = selectedId ? workflowGraph.getNode(selectedId) : null;
    const isImageSelected =
      selectedNode &&
      (selectedNode.type === 'ImageGen' ||
        selectedNode.type === 'ImageInput' ||
        selectedNode.type === 'ImageCombine');

    // 1. Direct ID match if query is an exact nodeId
    if (query) {
      const byId = workflowGraph.getNode(query);
      if (
        byId &&
        (byId.type === 'ImageGen' ||
          byId.type === 'ImageInput' ||
          byId.type === 'ImageCombine')
      ) {
        return byId;
      }
    }

    // 2. Index / Ordinal match if query contains "first", "second", "node 1", "#2", etc.
    if (query) {
      const lower = query.toLowerCase();
      const numMatch = lower.match(/(?:node\s*|#\s*)?([0-9]+)/);
      if (numMatch) {
        const idx = parseInt(numMatch[1], 10) - 1;
        if (idx >= 0 && idx < allImageNodes.length) {
          return allImageNodes[idx];
        }
      }
      if (lower.includes('first') && allImageNodes.length >= 1)
        return allImageNodes[0];
      if (lower.includes('second') && allImageNodes.length >= 2)
        return allImageNodes[1];
      if (lower.includes('third') && allImageNodes.length >= 3)
        return allImageNodes[2];
    }

    // 3. Keyword & semantic matching on query and/or prompt
    const queryKeywords = extractSubjectKeywords(query || '');
    const promptKeywords = extractSubjectKeywords(prompt || '');
    const allKeywords = Array.from(
      new Set([...queryKeywords, ...promptKeywords]),
    );

    if (allKeywords.length > 0) {
      let bestNode: NodeData | null = null;
      let highestScore = 0;

      for (const node of allImageNodes) {
        let score = 0;
        const nodePrompt = (node.prompt || '').toLowerCase();
        const nodeId = node.id.toLowerCase();
        const nodeType = node.type.toLowerCase();

        // Exact query substring match in prompt
        if (
          query &&
          query.length >= 3 &&
          nodePrompt.includes(query.toLowerCase())
        ) {
          score += 40;
        }

        for (const kw of allKeywords) {
          if (nodePrompt.includes(kw)) {
            score += 15;
            if (queryKeywords.includes(kw)) score += 10;
          }
          if (nodeType.includes(kw)) {
            score += 10;
          }
          if (nodeId.includes(kw)) {
            score += 20;
          }
        }

        if (score > 0) {
          // Slight bonus if selected
          if (isImageSelected && selectedNode.id === node.id) {
            score += 2;
          }

          // Bonus if the image has already generated
          if (node.imageUrl) {
            score += 1;
          }
        }

        if (score > highestScore) {
          highestScore = score;
          bestNode = node;
        }
      }

      if (bestNode && highestScore > 0) {
        console.log(
          `[WeaVR Video] Matched source image node ${bestNode.id} ("${bestNode.prompt}") with score ${highestScore} for query="${query}", prompt="${prompt}"`,
        );
        return bestNode;
      }
    }

    // 4. Selected node if it's an image
    if (isImageSelected) {
      return selectedNode;
    }

    // 5. Fallback: most recent image node that already has an image, or last created
    return (
      allImageNodes.filter((n) => n.imageUrl).pop() ||
      allImageNodes[allImageNodes.length - 1]
    );
  }

  private connectVideoNode(
    sourceNodeId?: string,
    prompt = 'cinematic motion with dynamic camera movement',
  ): void {
    let sourceNode = this.findBestSourceImageNode(sourceNodeId, prompt);

    // If no image node exists yet in the workspace, create one so there's always an image reference & wire
    if (!sourceNode) {
      const imgPos = workflowGraph.findFreePosition();
      sourceNode = workflowGraph.addNode('ImageGen', prompt, imgPos);
      this.recordNodeCreation(sourceNode.id, 'ImageGen', prompt);
      this.runSingleNode(sourceNode.id);
    }

    const candidate: [number, number, number] = [
      sourceNode.position[0] + 0.48,
      sourceNode.position[1],
      sourceNode.position[2],
    ];
    const pos =
      workflowGraph.positionsForGroup(1, candidate)[0] ??
      workflowGraph.findFreePosition();

    const videoNode = workflowGraph.addNode('Video', prompt, pos);
    this.recordNodeCreation(videoNode.id, 'Video', prompt);

    // Connect image to Port 1 (reference image for Runway Image-to-Video)
    workflowGraph.addConnection(sourceNode.id, 0, videoNode.id, 1);
    console.log(
      `[WeaVR Video] Connected Image ${sourceNode.id} ("${sourceNode.prompt}") -> Video ${videoNode.id} (port 1)`,
    );

    this.runVideoNode(videoNode.id);
  }

  private createVariation(sourceNodeId: string): void {
    const sourceNode = workflowGraph.getNode(sourceNodeId);
    if (!sourceNode) return;

    const prompt = sourceNode.prompt || 'a creative variation';
    const candidate: [number, number, number] = [
      sourceNode.position[0] + 0.48,
      sourceNode.position[1],
      sourceNode.position[2],
    ];
    const pos =
      workflowGraph.positionsForGroup(1, candidate)[0] ??
      workflowGraph.findFreePosition();

    const newNode = workflowGraph.addNode('ImageGen', prompt, pos);
    if (sourceNode.imageUrl) {
      workflowGraph.addConnection(sourceNodeId, 0, newNode.id, 1);
    }
    this.runSingleNode(newNode.id);
  }

  findTargetNode(query?: string, filterTypes?: NodeType[]): NodeData | undefined {
    let all = workflowGraph.allNodes();
    if (filterTypes && filterTypes.length > 0) {
      all = all.filter((n) => filterTypes.includes(n.type));
    }
    if (all.length === 0) return undefined;

    const selectedId = (window as any).__weavrSelectedNodeId;
    const selectedNode = selectedId ? workflowGraph.getNode(selectedId) : undefined;
    const validSelected =
      selectedNode && (!filterTypes || filterTypes.includes(selectedNode.type))
        ? selectedNode
        : undefined;

    if (!query || query === 'selected' || query === 'this' || query === 'current' || query === 'active') {
      return validSelected ?? all[all.length - 1];
    }

    if (query === 'last' || query === 'latest' || query === 'recent') {
      return all[all.length - 1];
    }

    if (query === 'first') {
      return all[0];
    }

    // Direct ID match
    const byId = workflowGraph.getNode(query);
    if (byId && (!filterTypes || filterTypes.includes(byId.type))) return byId;

    const lower = query.toLowerCase().trim();

    // Check for "node 1", "node 2", "#1", "#2", or pure number
    const indexMatch = lower.match(/(?:node\s*|#\s*)?([0-9]+)/);
    if (indexMatch) {
      const idx = parseInt(indexMatch[1], 10) - 1; // 1-based index
      if (idx >= 0 && idx < all.length) {
        return all[idx];
      }
    }

    // Check for ordinal words
    const ordinals: Record<string, number> = {
      first: 0,
      second: 1,
      third: 2,
      fourth: 3,
      fifth: 4,
    };
    for (const [ord, idx] of Object.entries(ordinals)) {
      if (lower.includes(ord) && idx < all.length) {
        return all[idx];
      }
    }

    // Prioritize prompt & subject keyword semantic matching over generic type words!
    const keywords = extractSubjectKeywords(lower);
    if (keywords.length > 0) {
      let bestNode: NodeData | undefined = undefined;
      let highestScore = 0;

      for (const node of all) {
        let score = 0;
        const promptLower = (node.prompt || '').toLowerCase();
        const typeLower = node.type.toLowerCase();

        if (promptLower.includes(lower)) score += 40;

        for (const kw of keywords) {
          if (promptLower.includes(kw)) score += 15;
          if (typeLower.includes(kw)) score += 10;
        }

        if (score > highestScore) {
          highestScore = score;
          bestNode = node;
        }
      }

      if (bestNode && highestScore > 0) {
        return bestNode;
      }
    }

    // Generic node type match ONLY IF no specific keyword matched
    if (!filterTypes || filterTypes.length === 0) {
      if (/\b(video|clip|movie|runway)\b/i.test(lower)) {
        const vidNode = all.filter((n) => n.type === 'Video').pop();
        if (vidNode) return vidNode;
      }
      if (/\b(model|3d|mesh)\b/i.test(lower)) {
        const modelNode = all.filter((n) => n.type === 'Model3D').pop();
        if (modelNode) return modelNode;
      }
      if (/\b(chart|visualize|visualization|plot|graph|scatter|pie|bar)\b/i.test(lower)) {
        const visNode = all.filter((n) => n.type === 'Visualize').pop();
        if (visNode) return visNode;
      }
      if (/\b(combine|blend)\b/i.test(lower)) {
        const combineNode = all.filter((n) => n.type === 'ImageCombine').pop();
        if (combineNode) return combineNode;
      }
      if (/\b(export|download|summary)\b/i.test(lower)) {
        const exportNode = all.filter((n) => n.type === 'Export').pop();
        if (exportNode) return exportNode;
      }
      if (/\b(checklist|task|todo)\b/i.test(lower)) {
        const checkNode = all.filter((n) => n.type === 'Checklist').pop();
        if (checkNode) return checkNode;
      }
      if (/\b(data|dataset|csv|table)\b/i.test(lower)) {
        const dataNode = all.filter((n) => n.type === 'Data').pop();
        if (dataNode) return dataNode;
      }
      if (/\b(image|picture|photo)\b/i.test(lower)) {
        const imgNode = all.filter((n) => n.type === 'ImageGen' || n.type === 'ImageInput').pop();
        if (imgNode) return imgNode;
      }
      if (/\b(text|prompt)\b/i.test(lower)) {
        const textNode = all.filter((n) => n.type === 'Text').pop();
        if (textNode) return textNode;
      }
    }

    return validSelected ?? all[all.length - 1];
  }

  private handleManageChecklist(params: any): string {
    const rawAct = String(params.action || (params.complete ? 'check' : params.edit ? 'edit' : params.text ? 'add' : 'toggle')).toLowerCase();
    let text = params.text || params.newText || params.task || '';
    text = text.replace(/^["'\s,:]+|["'\s,?.!]+$/g, '');
    let target = params.target ?? params.number ?? params.index ?? params.task ?? '1';
    if (typeof target === 'string') {
      target = target.replace(/^["'\s,:]+|["'\s,?.!]+$/g, '');
    }
    const done = params.done != null ? Boolean(params.done) : (rawAct === 'check' || rawAct === 'complete');

    let action = rawAct;
    if (rawAct === 'add' || rawAct === 'create' || rawAct === 'new') action = 'create';
    else if (rawAct === 'edit' || rawAct === 'modify' || rawAct === 'change' || rawAct === 'rename' || rawAct === 'update') action = 'edit';
    else if (rawAct === 'check' || rawAct === 'complete' || rawAct === 'done') action = 'check';
    else if (rawAct === 'uncheck' || rawAct === 'undone' || rawAct === 'incomplete') action = 'uncheck';
    else if (rawAct === 'delete' || rawAct === 'remove') action = 'delete';
    else if (rawAct === 'clear' || rawAct === 'clear_all' || rawAct === 'delete_all') action = 'clear';

    console.log('[WeaVR Voice] Dispatching task action:', { action, text, target, done });
    window.dispatchEvent(
      new CustomEvent('weavr:task-action', {
        detail: { action, text, target, done },
      }),
    );

    let confirmMsg = 'Task list updated in VR.';
    if (action === 'create') {
      confirmMsg = `Created task "${text || target}".`;
    } else if (action === 'edit') {
      confirmMsg = `Updated task ${target} to "${text}".`;
    } else if (action === 'check') {
      confirmMsg = `Checked task ${target} as completed.`;
    } else if (action === 'uncheck') {
      confirmMsg = `Unchecked task ${target}.`;
    } else if (action === 'delete') {
      confirmMsg = `Deleted task ${target}.`;
    } else if (action === 'clear') {
      confirmMsg = 'Cleared all tasks from your list.';
    }

    return `Success: ${confirmMsg} Spoken instruction: Tell the user in one natural conversational sentence that their task list has been updated. NEVER read aloud raw CSV rows, coordinates, code blocks, or JSON syntax.`;
  }

  private deleteNode(query?: string): void {
    const target = this.findTargetNode(query);
    if (target) {
      workflowGraph.removeNode(target.id);
      console.log(`[WeaVR Voice] Deleted node ${target.id} (${target.type} - "${target.prompt}")`);
    } else {
      console.warn(`[WeaVR Voice] Could not find node to delete for query: "${query}"`);
    }
  }

  private deleteAllNodes(): void {
    const nodeIds = [...workflowGraph.nodes.keys()];
    for (const id of nodeIds) {
      workflowGraph.removeNode(id);
    }
    console.log(`[WeaVR Voice] Cleared all ${nodeIds.length} nodes from workspace`);
  }

  private shiftNodePosition(params: {
    target?: string;
    nodeId?: string;
    direction?: string;
    distance?: number | string;
    dx?: number;
    dy?: number;
    dz?: number;
    axis?: 'x' | 'y' | 'z';
  }): { success: boolean; message: string; nodesMoved: number } {
    const rawTarget = String(params.target || params.nodeId || 'selected').trim();
    const isAll = /\b(all|everything|all\s+nodes|workspace)\b/i.test(rawTarget);

    // Parse distance
    let dist = 0.30; // default 30cm (ergonomic spatial step)
    if (params.distance != null) {
      if (typeof params.distance === 'number' && !isNaN(params.distance)) {
        dist = Math.abs(params.distance);
      } else if (typeof params.distance === 'string') {
        const lowerDist = params.distance.toLowerCase().trim();
        const numMatch = lowerDist.match(/([0-9.]+)/);
        if (numMatch) {
          const val = parseFloat(numMatch[1]);
          if (lowerDist.includes('cm')) {
            dist = val / 100;
          } else if (lowerDist.includes('inch') || lowerDist.includes('in')) {
            dist = val * 0.0254;
          } else {
            dist = val;
          }
        } else if (/\b(little|slight|bit|nudge|small)\b/i.test(lowerDist)) {
          dist = 0.15;
        } else if (/\b(far|lot|much|large|big)\b/i.test(lowerDist)) {
          dist = 0.50;
        }
      }
    }

    // Determine direction offsets
    let dx = params.dx ?? 0;
    let dy = params.dy ?? 0;
    let dz = params.dz ?? 0;

    const rawDir = String(params.direction || '').toLowerCase().trim();
    if (dx === 0 && dy === 0 && dz === 0) {
      if (/\b(up|upward|higher|raise|above|top)\b/i.test(rawDir)) {
        dy += dist;
      }
      if (/\b(down|downward|lower|drop|below|bottom)\b/i.test(rawDir)) {
        dy -= dist;
      }
      if (/\b(left|leftward)\b/i.test(rawDir)) {
        dx -= dist;
      }
      if (/\b(right|rightward)\b/i.test(rawDir)) {
        dx += dist;
      }
      if (/\b(sideway|sideways|side|aside)\b/i.test(rawDir) && dx === 0) {
        dx += rawDir.includes('left') ? -dist : dist;
      }
      if (/\b(closer|forward|front|near|in|toward)\b/i.test(rawDir)) {
        dz += dist;
      }
      if (/\b(further|farther|backward|back|away|behind|out)\b/i.test(rawDir)) {
        dz -= dist;
      }

      if (dx === 0 && dy === 0 && dz === 0) {
        if (params.axis === 'y') dy = dist;
        else if (params.axis === 'x') dx = dist;
        else if (params.axis === 'z') dz = dist;
        else dx = dist; // default sideways
      }
    }

    // Nodes to shift
    let targets: NodeData[] = [];
    if (isAll) {
      targets = workflowGraph.allNodes();
    } else {
      const single = this.findTargetNode(rawTarget);
      if (single) {
        targets = [single];
      }
    }

    if (targets.length === 0) {
      console.warn(`[WeaVR Voice] No nodes found to shift for query: "${rawTarget}"`);
      return {
        success: false,
        message: `Could not find any matching node for "${rawTarget}" in the workspace.`,
        nodesMoved: 0,
      };
    }

    for (const node of targets) {
      const [x, y, z] = node.position;
      const newPos: [number, number, number] = [
        Math.round((x + dx) * 1000) / 1000,
        Math.round((y + dy) * 1000) / 1000,
        Math.round((z + dz) * 1000) / 1000,
      ];
      workflowGraph.updateNode(node.id, {
        position: newPos,
        manuallyMoved: true,
      });
      console.log(
        `[WeaVR Voice] Shifted node ${node.id} (${node.type}) from [${x}, ${y}, ${z}] to [${newPos[0]}, ${newPos[1]}, ${newPos[2]}] (dx:${dx}, dy:${dy}, dz:${dz})`,
      );
    }

    // If a single node was shifted, select it so the user can easily see and highlight it
    if (targets.length === 1) {
      const node = targets[0];
      (window as any).__weavrSelectedNodeId = node.id;
      window.dispatchEvent(
        new CustomEvent('weavr:node-selected', { detail: { nodeId: node.id } }),
      );
    }

    // Human-readable direction description
    const dirParts: string[] = [];
    if (dy > 0) dirParts.push(`up by ${Math.round(Math.abs(dy) * 100)}cm`);
    else if (dy < 0) dirParts.push(`down by ${Math.round(Math.abs(dy) * 100)}cm`);

    if (dx > 0) dirParts.push(`to the right by ${Math.round(Math.abs(dx) * 100)}cm`);
    else if (dx < 0) dirParts.push(`to the left by ${Math.round(Math.abs(dx) * 100)}cm`);

    if (dz > 0) dirParts.push(`closer by ${Math.round(Math.abs(dz) * 100)}cm`);
    else if (dz < 0) dirParts.push(`further back by ${Math.round(Math.abs(dz) * 100)}cm`);

    const dirDesc = dirParts.join(' and ') || 'to the new position';

    const msg = isAll
      ? `Shifted all ${targets.length} nodes ${dirDesc} in the workspace.`
      : `Shifted ${nodeTypeLabel(targets[0].type)} "${targets[0].prompt || targets[0].type}" ${dirDesc}.`;

    return {
      success: true,
      message: msg,
      nodesMoved: targets.length,
    };
  }

  private async runSingleNode(nodeId: string): Promise<void> {
    const node = workflowGraph.getNode(nodeId);
    if (node == null) return;
    if (node.type === 'Text' || node.type === 'ImageInput') return; // text and image input nodes don't execute

    if (node.type === 'Model3D') {
      await this.runModel3DNode(nodeId);
      return;
    }

    if (node.type === 'Video') {
      await this.runVideoNode(nodeId);
      return;
    }

    // If any upstream source image node is currently generating or idle, wait for it to get its imageUrl
    const initialInputNodes = workflowGraph.getInputNodes(nodeId);
    for (const upstream of initialInputNodes) {
      if (upstream.type === 'ImageGen' && !upstream.imageUrl && upstream.state !== 'Failed') {
        if (upstream.state === 'Idle') {
          console.log(`[WeaVR] Auto-running upstream ImageGen node ${upstream.id} first...`);
          await this.runSingleNode(upstream.id);
        } else if (upstream.state === 'Generating') {
          console.log(`[WeaVR] Waiting for upstream ImageGen node ${upstream.id} to finish generating...`);
          for (let waitSec = 0; waitSec < 45; waitSec++) {
            await new Promise((r) => setTimeout(r, 1000));
            const fresh = workflowGraph.getNode(upstream.id);
            if (fresh && (fresh.imageUrl || fresh.state === 'Completed' || fresh.state === 'Failed')) {
              break;
            }
          }
        }
      }
    }

    workflowGraph.updateNode(nodeId, { state: 'Generating' });

    try {
      // Gather reference images and upstream text prompt from input connections
      const inputNodes = workflowGraph.getInputNodes(nodeId);
      const upstreamText = inputNodes.find((n) => n.type === 'Text')?.prompt;
      const effectivePrompt = upstreamText || node.prompt || 'a beautiful scene';
      const imageRefs = inputNodes
        .filter((n) => n.type === 'ImageGen' || n.type === 'ImageInput' || n.type === 'ImageCombine')
        .map((n) => n.imageUrl)
        .filter((url) => url.length > 0);

      console.log(`[WeaVR] Generating ImageGen node ${nodeId} with ${imageRefs.length} reference image(s):`, imageRefs);

      const result = await generateImage({
        prompt: effectivePrompt,
        imageRefs,
      });

      if (result.status === 'completed' && result.imageUrl) {
        workflowGraph.updateNode(nodeId, {
          state: 'Completed',
          imageUrl: result.imageUrl,
        });
      } else {
        workflowGraph.updateNode(nodeId, {
          state: 'Failed',
          error: result.error ?? 'Generation failed',
        });
      }
    } catch (err) {
      workflowGraph.updateNode(nodeId, {
        state: 'Failed',
        error: String(err),
      });
    }
  }

  private async runCombineNode(nodeId: string): Promise<void> {
    const node = workflowGraph.getNode(nodeId);
    if (node == null) return;

    workflowGraph.updateNode(nodeId, { state: 'Generating' });

    try {
      const inputNodes = workflowGraph.getInputNodes(nodeId);
      const imageUrls = inputNodes
        .map((n) => n.imageUrl)
        .filter((url) => url.length > 0);

      const result = await combineImages(imageUrls, node.prompt);

      if (result.status === 'completed' && result.imageUrl) {
        workflowGraph.updateNode(nodeId, {
          state: 'Completed',
          imageUrl: result.imageUrl,
        });
      } else {
        workflowGraph.updateNode(nodeId, {
          state: 'Failed',
          error: result.error ?? 'Combine failed',
        });
      }
    } catch (err) {
      workflowGraph.updateNode(nodeId, {
        state: 'Failed',
        error: String(err),
      });
    }
  }

  private async runModel3DNode(nodeId: string): Promise<void> {
    const node = workflowGraph.getNode(nodeId);
    if (node == null) return;

    workflowGraph.updateNode(nodeId, { state: 'Generating' });

    try {
      const inputNodes = workflowGraph.getInputNodes(nodeId);
      const textNode = inputNodes.find((n) => n.type === 'Text');
      const upstreamImageNode = inputNodes.find(
        (n) =>
          n.type === 'ImageGen' ||
          n.type === 'ImageInput' ||
          n.type === 'ImageCombine',
      );

      let effectiveImageUrl = upstreamImageNode?.imageUrl;

      // If upstream image node is still generating, wait for it to complete!
      if (
        upstreamImageNode &&
        !effectiveImageUrl &&
        (upstreamImageNode.state === 'Generating' ||
          upstreamImageNode.state === 'Queued')
      ) {
        console.log(
          `[WeaVR 3D] Upstream image node ${upstreamImageNode.id} is still generating. Waiting for image...`,
        );
        for (let attempt = 0; attempt < 60; attempt++) {
          await new Promise((r) => setTimeout(r, 1000));
          const currentUpstream = workflowGraph.getNode(upstreamImageNode.id);
          if (currentUpstream?.imageUrl) {
            effectiveImageUrl = currentUpstream.imageUrl;
            break;
          }
          if (currentUpstream?.state === 'Failed') {
            throw new Error(
              `Upstream image generation failed: ${currentUpstream.error || 'Unknown error'}`,
            );
          }
        }
      }

      const effectivePrompt =
        textNode?.prompt || node.prompt || upstreamImageNode?.prompt || '';

      if (!effectiveImageUrl && !effectivePrompt) {
        workflowGraph.updateNode(nodeId, {
          state: 'Failed',
          error: 'Connect an Image or Text node first',
        });
        return;
      }

      console.log(
        `[WeaVR 3D] Generating 3D model (image: ${effectiveImageUrl ? 'yes' : 'none'}, prompt: "${effectivePrompt}")`,
      );
      const result = await generate3DModel({
        imageUrl: effectiveImageUrl || undefined,
        prompt: effectivePrompt || '3D game asset model',
      });

      if (result.status === 'completed' && result.modelUrl) {
        workflowGraph.updateNode(nodeId, {
          state: 'Completed',
          modelUrl: result.modelUrl,
          imageUrl: result.previewUrl || effectiveImageUrl,
          prompt: effectivePrompt || node.prompt,
        });
      } else {
        workflowGraph.updateNode(nodeId, {
          state: 'Failed',
          error: result.error ?? '3D Generation failed',
        });
      }
    } catch (err) {
      console.error('[WeaVR 3D] Error in runModel3DNode:', err);
      workflowGraph.updateNode(nodeId, {
        state: 'Failed',
        error: String(err),
      });
    }
  }

  private async runVideoNode(nodeId: string): Promise<void> {
    const node = workflowGraph.getNode(nodeId);
    if (node == null) return;

    workflowGraph.updateNode(nodeId, { state: 'Generating' });

    try {
      const inputNodes = workflowGraph.getInputNodes(nodeId);
      const textNode = inputNodes.find((n) => n.type === 'Text');
      const upstreamImageNode = inputNodes.find(
        (n) =>
          n.type === 'ImageGen' ||
          n.type === 'ImageInput' ||
          n.type === 'ImageCombine',
      );

      let effectiveImageUrl = upstreamImageNode?.imageUrl;

      // If upstream image node is still generating, wait for it to complete
      if (
        upstreamImageNode &&
        !effectiveImageUrl &&
        (upstreamImageNode.state === 'Generating' ||
          upstreamImageNode.state === 'Queued')
      ) {
        console.log(
          `[WeaVR Video] Upstream image node ${upstreamImageNode.id} is still generating. Waiting for image...`,
        );
        for (let attempt = 0; attempt < 60; attempt++) {
          await new Promise((r) => setTimeout(r, 1000));
          const currentUpstream = workflowGraph.getNode(upstreamImageNode.id);
          if (currentUpstream?.imageUrl) {
            effectiveImageUrl = currentUpstream.imageUrl;
            break;
          }
          if (currentUpstream?.state === 'Failed') {
            throw new Error(
              `Upstream image generation failed: ${currentUpstream.error || 'Unknown error'}`,
            );
          }
        }
      }

      const effectivePrompt =
        textNode?.prompt ||
        node.prompt ||
        'cinematic motion with dynamic camera movement';

      console.log(`[WeaVR Video] Requesting Runway Gen-3 Alpha Video for node ${nodeId}...`, {
        prompt: effectivePrompt,
        hasImage: Boolean(effectiveImageUrl),
      });

      const res = await generateVideo({
        prompt: effectivePrompt,
        imageUrl: effectiveImageUrl,
      });

      if (res.status === 'completed' && res.videoUrl) {
        console.log(`[WeaVR Video] Successfully generated video for ${nodeId}:`, res.videoUrl);
        workflowGraph.updateNode(nodeId, {
          state: 'Completed',
          videoUrl: res.videoUrl,
          imageUrl: effectiveImageUrl || node.imageUrl,
          prompt: effectivePrompt,
        });
      } else {
        throw new Error(res.error || 'Runway video generation failed');
      }
    } catch (err: any) {
      console.error(`[WeaVR Video] Error generating video for ${nodeId}:`, err);
      workflowGraph.updateNode(nodeId, {
        state: 'Failed',
        error: err.message || String(err),
      });
    }
  }

  async runAllNodes(): Promise<void> {
    const order = workflowGraph.getExecutionOrder();
    for (const nodeId of order) {
      const node = workflowGraph.getNode(nodeId);
      if (node == null) continue;
      if (node.type === 'Text' || node.type === 'ImageInput') continue;
      if (node.state === 'Completed') continue; // skip already done

      if (node.type === 'ImageCombine') {
        await this.runCombineNode(nodeId);
      } else if (node.type === 'Model3D') {
        await this.runModel3DNode(nodeId);
      } else if (node.type === 'Video') {
        await this.runVideoNode(nodeId);
      } else {
        await this.runSingleNode(nodeId);
      }
    }
  }

  update(delta: number): void {
    // Small Voice Visualizer animation directly above the Voice Agent button
    this.visualizerAnimTime += delta;
    if (
      this.visualizerGroup &&
      this.visualizerGroup.visible &&
      this.visualizerBars.length > 0
    ) {
      const t = this.visualizerAnimTime;
      if (this.currentAgentState === 'speaking') {
        // Dynamic bouncy speech equalizer
        for (let i = 0; i < 5; i++) {
          const f1 = Math.sin(t * 14.0 + i * 1.6);
          const f2 = Math.sin(t * 22.0 - i * 2.3);
          const f3 = Math.cos(t * 8.5 + i * 0.9);
          const raw = Math.abs(f1 * 0.5 + f2 * 0.35 + f3 * 0.25);
          this.visualizerBars[i].scale.y = 0.08 + raw * 0.26;
        }
      } else if (this.currentAgentState === 'listening') {
        // Gentle undulating wave when listening for input
        for (let i = 0; i < 5; i++) {
          const wave = Math.sin(t * 4.5 + i * 1.1);
          this.visualizerBars[i].scale.y = 0.08 + (wave * 0.5 + 0.5) * 0.12;
        }
      } else if (this.currentAgentState === 'connecting') {
        // Soft pulsing rhythm while connecting
        for (let i = 0; i < 5; i++) {
          const wave = Math.sin(t * 6.0 + i * 0.8);
          this.visualizerBars[i].scale.y = 0.06 + (wave * 0.5 + 0.5) * 0.08;
        }
      }
    }
  }
}

