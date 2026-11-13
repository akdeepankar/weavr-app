/**
 * CommandParser — converts natural-language voice transcripts
 * into structured workflow actions.
 */

import { workflowGraph, type NodeType } from './workflow-graph.js';

// ---------------------------------------------------------------------------
// Action types
// ---------------------------------------------------------------------------

export type WorkflowAction =
  | { action: 'createNodes'; count: number; type: NodeType; prompt: string }
  | { action: 'combineImages'; nodeIds: string[]; prompt?: string }
  | { action: 'modifyImage'; nodeId: string; prompt: string }
  | {
      action: 'connectNewImage';
      sourceNodeId?: string;
      sourceNodeIds?: string[];
      prompt?: string;
    }
  | { action: 'variation'; sourceNodeId: string }
  | { action: 'deleteNode'; nodeId: string | 'last' }
  | { action: 'deleteAll' }
  | { action: 'removeChart' }
  | { action: 'colorChart'; target?: string; color: string; colors?: Record<string, string> }
  | { action: 'connectNodes'; sourceId: string; targetId: string }
  | { action: 'updatePrompt'; nodeId: string; prompt: string }
  | { action: 'runNode'; nodeId: string }
  | { action: 'runAll' }
  | { action: 'undo' }
  | { action: 'redo' }
  | { action: 'moveNodes'; direction: string }
  | {
      action: 'shiftNode';
      target?: string;
      direction: string;
      distance?: number | string;
      dx?: number;
      dy?: number;
      dz?: number;
    }
  | { action: 'resizeModel'; scaleMultiplier: number; nodeId?: string }
  | { action: 'createVideo'; sourceNodeId?: string; prompt?: string }
  | { action: 'createDataPipeline'; prompt?: string }
  | { action: 'toggleVisMode'; mode?: '3d' | 'flat'; chartType?: 'scatter3d' | 'bar3d' | 'bar2d' | 'pie3d' }
  | { action: 'visualizeMath'; conceptType: any; highlightName?: string; highlightColor?: string; title?: string }
  | { action: 'highlightMath'; target: string; color?: string }
  | { action: 'toggleChecklist'; target?: string }
  | { action: 'checkTask'; target: string; done: boolean }
  | { action: 'editTask'; target: string; newText: string }
  | { action: 'deleteTask'; target: string }
  | { action: 'clearTasks' }
  | { action: 'addChecklistItem'; text: string }
  | { action: 'unknown'; transcript: string };

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  a: 1,
  an: 1,
};

function normalizeSpeech(text: string): string {
  return text
    .replace(/\b(to|too)\s+(images?|nodes?|pictures?)/i, 'two $2')
    .replace(/\b(for)\s+(images?|nodes?|pictures?)/i, 'four $2')
    .replace(/\b(please\s+|can\s+you\s+|could\s+you\s+)/i, '')
    .trim();
}

function parseCount(text: string): number {
  const norm = normalizeSpeech(text);
  if (/\b(three|3)\b/i.test(norm)) return 3;
  if (/\b(four|4)\b/i.test(norm)) return 4;
  if (/\b(five|5)\b/i.test(norm)) return 5;
  if (/\b(two|2|multiple|couple|few|several)\b/i.test(norm)) return 2;
  const match = norm.match(/(\d+)/);
  if (match) return Math.max(1, Math.min(5, parseInt(match[1], 10)));
  for (const [word, value] of Object.entries(NUMBER_WORDS)) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(norm)) return Math.max(1, Math.min(5, value));
  }
  return 1;
}

const ORDINALS: Record<string, number> = {
  first: 0,
  second: 1,
  third: 2,
  fourth: 3,
  fifth: 4,
  '1st': 0,
  '2nd': 1,
  '3rd': 2,
  '4th': 3,
  '5th': 4,
};

function parseOrdinals(text: string): number[] {
  const indices: number[] = [];
  for (const [word, idx] of Object.entries(ORDINALS)) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(text)) {
      indices.push(idx);
    }
  }
  return indices;
}

function extractPrompt(transcript: string): string {
  const norm = normalizeSpeech(transcript);
  return norm
    .replace(
      /^(?:generate|create|make|produce|build)\s+(?:me\s+|for\s+me\s+)?(?:an?\s+|the\s+)?(?:\d+\s+|one\s+|two\s+|three\s+|four\s+|five\s+|multiple\s+|a\s+few\s+|several\s+)?(?:images?|image\s*nodes?|pictures?)\s*(?:of|for|about)?\s*/i,
      '',
    )
    .replace(
      /^(?:generate|create|make|produce)\s+(?:me\s+|for\s+me\s+)?(?:an?\s+|the\s+)?(?:\d+\s+|one\s+|two\s+|three\s+)?/i,
      '',
    )
    .replace(/\s+(?:images?|image\s*nodes?|pictures?)$/i, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseCommand(transcript: string): WorkflowAction {
  const lower = transcript.toLowerCase().trim();

  // --- Undo / Redo ---
  if (/\bundo\b/i.test(lower)) return { action: 'undo' };
  if (/\bredo\b/i.test(lower)) return { action: 'redo' };

  // --- Connect image node(s) as reference to an image node ---
  if (
    /\b(connect|link|use|attach)\b.*\b(images?|nodes?)\b.*\b(reference|references|ref|generation)/i.test(
      lower,
    ) ||
    /\b(connect|link)\b.*\b(two|2|both|pair)\s+(?:image\s+)?nodes?\s+to\s+(one|1|a|an|another|new)?\s*(?:image\s+)?node/i.test(
      lower,
    ) ||
    /\b(new\s*image|new\s*node)\b.*\b(from|with|referenc)\b.*\b(images?|nodes?)/i.test(
      lower,
    ) ||
    /\bconnect\b.*\bto\s*(a\s+)?(?:new|one)\s*(image\s+)?node/i.test(lower)
  ) {
    const imageNodes = workflowGraph
      .allNodes()
      .filter((n) => n.type === 'ImageGen' || n.type === 'ImageInput' || n.type === 'ImageCombine');
    const ords = parseOrdinals(lower);
    const isMultiple =
      /\b(two|2|both|pair|couple|these|all|first and second|second and third)\b/i.test(
        lower,
      ) || ords.length >= 2;

    let sourceNodeIds: string[] = [];
    if (ords.length >= 2) {
      sourceNodeIds = ords
        .map((idx) => imageNodes[idx]?.id)
        .filter((id): id is string => Boolean(id));
    } else if (isMultiple || imageNodes.length >= 2) {
      // Pick first two source image nodes if 3 exist, or last two if 2 exist
      sourceNodeIds = imageNodes.length >= 3
        ? imageNodes.slice(0, 2).map((n) => n.id)
        : imageNodes.slice(-2).map((n) => n.id);
    } else {
      const targetIdx = ords.length > 0 ? ords[0] : imageNodes.length - 1;
      const single = imageNodes[targetIdx] ?? imageNodes[imageNodes.length - 1];
      if (single) sourceNodeIds = [single.id];
    }

    if (sourceNodeIds.length > 0) {
      return {
        action: 'connectNewImage',
        sourceNodeId: sourceNodeIds[0],
        sourceNodeIds,
        prompt:
          extractPrompt(transcript) ||
          'a cohesive new composition combining reference images',
      };
    }
  }

  // --- Connect existing nodes (e.g. "connect node-1 to node-2") ---
  const connMatch = lower.match(
    /\bconnect\b\s+(?:the\s+)?([a-z0-9_\-\s]+?)\s+to\s+(?:the\s+)?([a-z0-9_\-\s]+)/i,
  );
  if (connMatch) {
    const srcQuery = connMatch[1].trim();
    const tgtQuery = connMatch[2].trim();
    if (!/\b(new)\b/i.test(tgtQuery)) {
      return { action: 'connectNodes', sourceId: srcQuery, targetId: tgtQuery };
    }
  }

  // --- Variation ---
  if (
    /\b(variation|variant|another\s+variation|another\s+version|another\s+one)\b/i.test(
      lower,
    )
  ) {
    const lastImage = workflowGraph
      .allNodes()
      .filter((n) => n.type !== 'Text')
      .pop();
    if (lastImage) {
      return { action: 'variation', sourceNodeId: lastImage.id };
    }
  }

  // --- Resize / Scale 3D model or 3D chart ---
  if (
    /\b(resize|scale|shrink|grow|enlarge|bigger|larger|smaller|tiny|huge)\b/i.test(lower) ||
    (/\b(make|set)\b.*\b(bigger|larger|smaller|tiny|huge)\b/i.test(lower))
  ) {
    let scaleMultiplier = 1.4;
    const numMatch = lower.match(/\b([0-9]+(?:\.[0-9]+)?)\s*x?\b/);
    if (numMatch && !isNaN(Number(numMatch[1]))) {
      scaleMultiplier = Number(numMatch[1]);
    } else if (/\b(smaller|shrink|tiny|decrease|compact|half|reduce|down)\b/i.test(lower)) {
      scaleMultiplier = 0.7;
    } else if (/\b(reset|normal|default|original|1x)\b/i.test(lower)) {
      scaleMultiplier = 1.0;
    } else if (/\b(double|2x|twice)\b/i.test(lower)) {
      scaleMultiplier = 2.0;
    } else if (/\b(triple|3x)\b/i.test(lower)) {
      scaleMultiplier = 3.0;
    }
    return { action: 'resizeModel', scaleMultiplier };
  }

  // --- Video Generation: Image-to-Video or Text-to-Video ---
  if (/\b(video|motion|animate|animation|cinematic|film)\b/i.test(lower)) {
    let sourceNodeId: string | undefined;

    // Check for "make the [subject] video" or "create a [subject] video" or "animate the [subject]"
    const subjectVideoMatch = lower.match(
      /(?:make|create|generate|animate|turn)\s+(?:the\s+|a\s+|an\s+)?([a-z0-9_-]+(?:\s+[a-z0-9_-]+)?)\s+(?:into\s+a\s+)?video/i,
    );
    if (
      subjectVideoMatch &&
      !['new', 'another', 'quick', 'cool', 'short'].includes(
        subjectVideoMatch[1].trim(),
      )
    ) {
      sourceNodeId = subjectVideoMatch[1].trim();
    }

    // Check for "from [subject]" or "of [subject]" or "using [subject]"
    if (!sourceNodeId) {
      const fromMatch = lower.match(
        /(?:from|of|using|with)\s+(?:the\s+|a\s+|an\s+)?([a-z0-9_-]+(?:\s+[a-z0-9_-]+)?)\s*(?:image|picture|photo|node)?/i,
      );
      if (fromMatch && !fromMatch[1].includes('video')) {
        sourceNodeId = fromMatch[1].trim();
      }
    }

    const prompt =
      extractPrompt(lower) ||
      lower.replace(/.*?\b(?:with\s+prompt|prompt|about|of)\s+/i, '').trim() ||
      'cinematic motion with dynamic camera movement';

    return {
      action: 'createVideo',
      sourceNodeId,
      prompt,
    };
  }

  // --- Data Pipeline: Visualize -> Export ---
  if (/\b(data\s*pipeline|visualize.*data|data.*flow)\b/i.test(lower)) {
    return { action: 'createDataPipeline', prompt: 'Data Visualization Pipeline' };
  }

  // --- 3D Pie Chart: Toggle or Create ---
  if (/\b(pie\s*chart|3d\s*pie|pie\s*plot)\b/i.test(lower)) {
    if (/\b(switch|toggle|change|view|set|make|convert|turn)\b/i.test(lower)) {
      return { action: 'toggleVisMode', chartType: 'pie3d', mode: '3d' };
    }
    const prompt = lower
      .replace(/^(create|add|make|show|display|visualize)\s+(me\s+|for\s+me\s+)?(an?\s+|the\s+)?(3d\s+|2d\s+|flat\s+)?(pie\s*chart|pie\s*plot|pie)\s*(of|for|about)?\s*/i, '')
      .trim();
    return {
      action: 'createNodes',
      count: 1,
      type: 'Visualize',
      prompt: prompt ? `${prompt.charAt(0).toUpperCase() + prompt.slice(1)} (3D Pie Chart)` : '3D Pie Chart',
    };
  }

  // --- Toggle 3D / 2D Viewing Mode ---
  if (/\b(switch|toggle|change|view|set)\b.*\b(2d|flat|planar)\b/i.test(lower)) {
    return { action: 'toggleVisMode', mode: 'flat' };
  }
  if (/\b(switch|toggle|change|view|set)\b.*\b(3d|spatial|depth)\b/i.test(lower)) {
    return { action: 'toggleVisMode', mode: '3d' };
  }

  // --- Mathematical Concepts & Geometric Theorems in 3D ---
  if (
    /\b(math|pythagor|pythagorean|hypotenuse|saddle|paraboloid|unit\s*circle|trigonomet|cross\s*product|euler|polyhedr|geometry\s*concept|calculus|surface\s*plot)\b/i.test(lower)
  ) {
    let conceptType: any = 'pythagoras';
    let highlightName: string | undefined = undefined;
    let highlightColor = 'neon green';

    if (/\b(cube|euler|polyhedr|diagonal)\b/i.test(lower)) {
      conceptType = 'cube';
      if (/\bdiagonal\b/i.test(lower)) highlightName = 'diagonal';
      else if (/\b(top|face)\b/i.test(lower)) highlightName = 'top_face';
    } else if (/\b(saddle|hyperbolic)\b/i.test(lower)) {
      conceptType = 'saddle';
      highlightName = 'saddle_point';
    } else if (/\b(paraboloid|bowl)\b/i.test(lower)) {
      conceptType = 'paraboloid';
      highlightName = 'minimum';
    } else if (/\b(unit\s*circle|trig|sine|cosine|tangent)\b/i.test(lower)) {
      conceptType = 'unit_circle';
      if (/\bsine|sin\b/i.test(lower)) highlightName = 'sine';
      else if (/\bcosine|cos\b/i.test(lower)) highlightName = 'cosine';
      else if (/\btangent|tan\b/i.test(lower)) highlightName = 'tangent';
    } else if (/\b(cross\s*product|vector\s*cross)\b/i.test(lower)) {
      conceptType = 'cross_product';
      highlightName = 'cross_product';
    } else if (/\b(torus|donut)\b/i.test(lower)) {
      conceptType = 'torus';
    } else {
      conceptType = 'pythagoras';
      highlightName = 'hypotenuse';
    }

    const colorMatch = lower.match(/\b(neon green|red|green|blue|cyan|yellow|gold|orange|purple|violet|pink|white)\b/i);
    if (colorMatch) highlightColor = colorMatch[1].toLowerCase();

    return {
      action: 'visualizeMath',
      conceptType,
      highlightName,
      highlightColor,
      title: `${conceptType.toUpperCase()} Math Concept`,
    };
  }

  // --- Highlight Math Element ---
  const hlMatch = lower.match(/\b(highlight|illuminate|glow|mark)\b\s+(?:the\s+)?([a-z0-9_\-\s]+?)(?:\s+(?:in|with|to)\s+(neon green|red|green|blue|cyan|yellow|gold|orange|purple|violet|pink|white|#[0-9a-fA-F]{3,6}))?$/i);
  if (hlMatch && !/\b(all|everything|all\s+nodes)\b/i.test(hlMatch[2])) {
    const target = hlMatch[2].trim().replace(/^(the|bar|of)\s+/i, '');
    const color = hlMatch[3] ? hlMatch[3].trim() : 'neon green';
    return {
      action: 'highlightMath',
      target,
      color,
    };
  }

  // --- Create Visualize Node / Chart / Plot ---
  if (/\b(create|add|make|show|display|visualize)\b.*\b(visualize|visualization|chart|scatter|plot|graph|bar\s*chart|metrics?)\b/i.test(lower)) {
    const prompt = lower
      .replace(/^(create|add|make|show|display|visualize)\s+(me\s+|for\s+me\s+)?(an?\s+|the\s+)?(3d\s+|2d\s+|flat\s+)?(visualization|visualize|chart|scatter|plot|graph|bar\s*chart|node)\s*(of|for|about)?\s*/i, '')
      .trim();
    return {
      action: 'createNodes',
      count: 1,
      type: 'Visualize',
      prompt: prompt ? prompt.charAt(0).toUpperCase() + prompt.slice(1) : '3D Scatter Plot',
    };
  }

  // --- Create Export Node ---
  if (/\b(create|add|make)\b.*\bexport\s*(node)?/i.test(lower)) {
    return { action: 'createNodes', count: 1, type: 'Export', prompt: 'CSV & Summary Export' };
  }

  // --- Generate / Create 3D model ---
  if (/\b(3d\s*model|3d|mesh|turn\s*into\s*3d|make\s*3d|convert\s*to\s*3d|create\s*3d|generate\s*3d)\b/i.test(lower)) {
    const prompt = lower
      .replace(/^(generate|create|make|produce|build)\s+(me\s+|for\s+me\s+)?(an?\s+|the\s+)?(3d\s*model|3d|mesh)\s+(of\s+)?/i, '')
      .replace(/^(turn|convert)\s+(this|it)?\s*(into|to)?\s*3d\s*(model)?/i, '')
      .trim();
    return { action: 'createNodes', count: 1, type: 'Model3D', prompt: prompt || '3D Model' };
  }

  // --- Generate / Create images ---
  if (/\b(generate|create|make|produce|spawn)\b.*\b(images?|image\s*nodes?|pictures?)\b/i.test(lower)) {
    const count = parseCount(lower);
    const prompt = extractPrompt(transcript) || 'a beautiful scene';
    return { action: 'createNodes', count, type: 'ImageGen', prompt };
  }

  // --- Create text node ---
  if (/\b(create|add|make)\b.*\btext\s*(node)?/i.test(lower)) {
    const prompt =
      lower.replace(/^.*text\s*(node)?\s*(with|saying|that says)?\s*/i, '').trim() ||
      '';
    return { action: 'createNodes', count: 1, type: 'Text', prompt };
  }

  // --- Clear / Delete all tasks ---
  if (/\b(clear|delete\s+all|remove\s+all)\s+(?:all\s+)?(?:the\s+)?(tasks?|checklist|todos?)\b/i.test(lower)) {
    return { action: 'clearTasks' };
  }

  // --- Edit / Change / Rename Task ---
  if (/\b(?:edit|change|rename|modify|update)\s+(?:task|item|step|todo)\s+(\d+|first|second|third|fourth|fifth|last|[a-z0-9\s]+?)\s+(?:to|as|with)\s+(.+)/i.test(lower)) {
    const match = transcript.match(/\b(?:edit|change|rename|modify|update)\s+(?:task|item|step|todo)\s+(\d+|first|second|third|fourth|fifth|last|[a-z0-9\s]+?)\s+(?:to|as|with)\s+(.+)/i);
    if (match) {
      let newText = match[2].trim().replace(/^["'\s,:]+|["'\s,?.!]+$/g, '');
      return { action: 'editTask', target: match[1].trim(), newText };
    }
  }

  // --- Delete / Remove Single Task ---
  if (/\b(?:delete|remove)\s+(?:task|item|step|todo)\s+(.+)/i.test(lower)) {
    const match = lower.match(/\b(?:delete|remove)\s+(?:task|item|step|todo)\s+(.+)/i);
    let target = match ? match[1].trim().replace(/^["'\s,:]+|["'\s,?.!]+$/g, '') : '1';
    return { action: 'deleteTask', target };
  }

  // --- Uncheck / Mark Task as Incomplete ---
  if (/\b(?:uncheck|unmark|undo|reopen)\s+(?:task|item|step|todo)?\s*(.+)/i.test(lower)) {
    let target = lower.replace(/^.*(?:uncheck|unmark|undo|reopen)\s+(?:task|item|step|todo)?\s*/i, '').trim();
    target = target.replace(/^["'\s,:]+|["'\s,?.!]+$/g, '');
    return { action: 'checkTask', target: target || '1', done: false };
  }

  // --- Check / Complete / Mark Task as Done ---
  if (
    /\b(?:complete|check\s*off|check|finish|mark\s*(?:as\s*)?done)\s+(?:task|item|step|todo)?\s*(.+)/i.test(
      lower,
    )
  ) {
    let target = lower.replace(/^.*(?:complete|check\s*off|check|finish|mark\s*(?:as\s*)?done)\s+(?:task|item|step|todo)?\s*/i, '').trim();
    target = target.replace(/^["'\s,:]+|["'\s,?.!]+$/g, '');
    return { action: 'checkTask', target: target || '1', done: true };
  }

  // --- Toggle Checklist Task ---
  if (/\btoggle\s+(?:task|item|step|todo)\s*(.*)/i.test(lower)) {
    let target = lower.replace(/^.*toggle\s+(?:task|item|step|todo)?\s*/i, '').trim();
    target = target.replace(/^["'\s,:]+|["'\s,?.!]+$/g, '');
    return { action: 'toggleChecklist', target };
  }

  // --- Add / Create Task to Checklist ---
  if (
    /\b(?:add|create|make|new|put)\s+(?:a\s+|the\s+|me\s+a\s+|me\s+)?(?:task|item|todo)\s*(?:called|named|to|:|,)?\s*(.+)/i.test(
      lower,
    )
  ) {
    const match = transcript.match(
      /\b(?:add|create|make|new|put)\s+(?:a\s+|the\s+|me\s+a\s+|me\s+)?(?:task|item|todo)\s*(?:called|named|to|:|,)?\s*(.+)/i,
    );
    let itemText = match ? match[1].trim() : 'New Task';
    itemText = itemText.replace(/^to\s+/i, '').replace(/^["'\s,:]+|["'\s,?.!]+$/g, '');
    return { action: 'addChecklistItem', text: itemText || 'New Task' };
  }

  // --- Create Checklist node (general fallback) ---
  if (/\b(create|add|make|new)\b.*\b(checklist|todo|to-do|tasks?)\b/i.test(lower)) {
    const prompt = transcript
      .replace(/^.*(checklist|todo|to-do|tasks?)\s*(called|named|with|for|about)?\s*/i, '')
      .trim();
    return {
      action: 'createNodes',
      count: 1,
      type: 'Checklist',
      prompt: prompt || 'Project Tasks',
    };
  }

  // --- Combine images (supports "second and third", "these two", etc.) ---
  if (/\bcombine\b/i.test(lower)) {
    const imageNodes = workflowGraph
      .allNodes()
      .filter((n) => n.type !== 'Text');
    const ords = parseOrdinals(lower);
    let nodeIds: string[] = [];
    if (ords.length >= 2) {
      nodeIds = ords
        .map((idx) => imageNodes[idx]?.id)
        .filter((id): id is string => Boolean(id));
    }
    if (nodeIds.length < 2) {
      nodeIds = imageNodes.slice(-2).map((n) => n.id);
    }
    return { action: 'combineImages', nodeIds };
  }

  // --- Modify / transform an image ---
  if (
    /\b(make|turn|transform|change)\b.*\b(it|this|image|the)\b/i.test(
      lower,
    )
  ) {
    const lastImageNode = workflowGraph
      .allNodes()
      .filter((n) => n.type !== 'Text')
      .pop();
    const nodeId = lastImageNode?.id ?? '';
    const prompt = lower
      .replace(
        /^(make|turn|transform|change)\s+(it|this|the\s+image)?\s*(look|to\s+be|into|more)?\s*/i,
        '',
      )
      .trim();
    return {
      action: 'modifyImage',
      nodeId,
      prompt: prompt || 'cinematic lighting and high detail',
    };
  }

  // --- Delete All / Clear Workspace ---
  if (
    /\b(delete|remove|clear|destroy|reset)\b.*\b(all|everything|all\s+nodes|workspace|entire\s+workspace|all\s+things)\b/i.test(
      lower,
    )
  ) {
    return { action: 'deleteAll' };
  }

  // --- Color specific chart bar / category ---
  const colorMatch = lower.match(
    /\b(make|color|turn|set|change)\b\s+(the\s+)?([a-zA-Z0-9_\-\s]+?)\s*(bar|column|point|slice)?\s*(to|into|color)?\s+(red|green|neon green|blue|cyan|yellow|gold|orange|purple|violet|pink|magenta|white|emerald|teal|indigo|rose|lime|#[0-9a-fA-F]{3,6})\b/i,
  );
  if (colorMatch) {
    const rawTarget = colorMatch[3].trim().replace(/^(the|bar|of)\s+/i, '');
    const color = colorMatch[6].trim();
    return { action: 'colorChart', target: rawTarget || undefined, color };
  }

  // --- Remove / Delete / Hide Chart ---
  if (/\b(remove|delete|hide|close|dismiss|clear)\b.*\b(chart|visualization|plot|graph)\b/i.test(lower)) {
    return { action: 'removeChart' };
  }

  // --- Delete particular node or single node ---
  const delMatch = lower.match(/\b(delete|remove|destroy|kill|drop)\b\s+(?:the\s+)?([a-z0-9_\-\s]+)/i);
  if (delMatch) {
    const rawTarget = delMatch[2].trim();
    // Exclude if it was a deleteAll command
    if (!/\b(all|everything|all\s+nodes|workspace)\b/i.test(rawTarget)) {
      return { action: 'deleteNode', nodeId: rawTarget };
    }
  }

  // Fallback single delete
  if (/\b(delete|remove|destroy)\b/i.test(lower)) {
    return { action: 'deleteNode', nodeId: 'this' };
  }

  // --- Run workflow ---
  if (/\b(run|execute|start)\b.*\b(all|everything|workflow|entire)/i.test(lower)) {
    return { action: 'runAll' };
  }

  // --- Run single node ---
  if (/\b(run|execute|generate|start)\b.*\b(this|it|the\s+node)/i.test(lower)) {
    const lastNode = workflowGraph.lastNode();
    return { action: 'runNode', nodeId: lastNode?.id ?? '' };
  }

  // --- Move nodes (closer/apart) ---
  if (/\b(arrange|spread|space)\b.*\b(nodes?|them|these|closer|apart)/i.test(lower)) {
    return { action: 'moveNodes', direction: lower.includes('closer') ? 'closer' : 'apart' };
  }

  // --- Shift / Move specific nodes in 3D space (up, down, sideways, left, right, closer, further) ---
  const shiftVerbMatch = /\b(shift|move|nudge|slide|reposition|push|pull|raise|lower|elevate)\b/i.test(lower);
  const dirMatch = lower.match(/\b(up(?:ward)?|down(?:ward)?|left(?:ward)?|right(?:ward)?|sideway(?:s)?|closer|further|farther|backward|back|forward|higher|lower|above|below)\b/i);

  if (shiftVerbMatch || dirMatch) {
    if (dirMatch) {
      let direction = dirMatch[1].toLowerCase();
      if (direction === 'higher' || direction === 'above') direction = 'up';
      if (direction === 'lower' || direction === 'below') direction = 'down';

      // Extract optional distance (e.g. "by 20cm", "0.5m", "a bit", "20 cm")
      let distance: string | number | undefined = undefined;
      const distMatch = lower.match(/(?:by\s+)?([0-9.]+\s*(?:cm|m|meters?|inches?|in))/i);
      if (distMatch) {
        distance = distMatch[1].trim();
      } else if (/\b(a\s+little|a\s+bit|slightly|nudge)\b/i.test(lower)) {
        distance = 0.15;
      } else if (/\b(a\s+lot|far|much)\b/i.test(lower)) {
        distance = 0.50;
      }

      // Extract target: what node is being moved?
      let target = 'selected';
      if (/\b(all|everything|all\s+nodes|workspace)\b/i.test(lower)) {
        target = 'all';
      } else {
        // Look for specific node names or references
        const nodeRefMatch = lower.match(/\b(?:node\s*#?\s*[0-9]+|#\s*[0-9]+|first|second|third|fourth|fifth|last|video|image|model|3d|chart|visualize|scatter|bar|pie|checklist|task|data|text|export|duck|car|this|it)\b/i);
        if (nodeRefMatch) {
          target = nodeRefMatch[0].trim();
        }
      }

      return {
        action: 'shiftNode',
        target,
        direction,
        distance,
      };
    }
  }

  // --- Fallback: try to create image nodes from descriptive text ---
  if (lower.length > 10 && !lower.startsWith('delete') && !lower.startsWith('remove')) {
    // Assume the user is describing something to generate
    return { action: 'createNodes', count: 1, type: 'ImageGen', prompt: transcript.trim() };
  }

  return { action: 'unknown', transcript };
}

