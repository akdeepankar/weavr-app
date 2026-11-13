/**
 * ChecklistSystem — manages the default persistent Checklist sidebar in spatial VR.
 * Features:
 * - Unified Header with rounded pill buttons
 * - Initially empty list with "No tasks yet" display and an "Add Task" button
 * - When selected (checked): displays tick mark (<Check>) and pure white text on green background
 * - When not selected (unchecked): displays empty box (<Square>) with pure white text
 * - Scroll Up / Down arrows to scroll through any number of tasks
 * - Minimizable mode: collapses body to a sleek compact pill header, expands with 1 click
 * - Pencil icon on each item to turn into Edit Mode
 * - Inbuilt default virtual keyboard with Delete Task, QWERTY, SPACE, DEL, CLR, SAVE
 * - Live bidirectional synchronization with 3D Checklist nodes in workflowGraph
 */

import { createSystem, UIKitMLAsset } from '@iwsdk/core';
import { workflowGraph, type ChecklistItem } from '../services/workflow-graph.js';

interface Task {
  id: string;
  text: string;
  done: boolean;
}

export class ChecklistSystem extends createSystem({}) {
  private isMinimized = true;
  private scrollOffset = 0;
  private isKeyboardOpen = false;
  private editingTaskIndex: number | null = null;
  private editingBuffer = '';

  // Initially empty list as requested
  private tasks: Task[] = [];

  init(): void {
    const panel = this.world.getSceneObject<UIKitMLAsset>(
      'checklist-panel',
    ) as UIKitMLAsset | null;
    if (panel == null) {
      console.warn('[ChecklistSystem] checklist-panel asset not found in scene');
      return;
    }

    // Sync with existing graph checklist node if one exists
    const existingChecklistNode = workflowGraph
      .allNodes()
      .find((n) => n.type === 'Checklist' && n.checklist && n.checklist.length > 0);
    if (existingChecklistNode?.checklist) {
      this.tasks = existingChecklistNode.checklist.map((it, idx) => ({
        id: it.id || String(idx + 1),
        text: it.text,
        done: Boolean(it.done),
      }));
    }

    // Expose live tasks getter for voice system & agent session
    (window as any).__weavrGetChecklistTasks = () => this.tasks;
    this.cleanupFuncs.push(() => {
      delete (window as any).__weavrGetChecklistTasks;
    });

    const checklistBody = panel.getElementById('checklist-body');
    const minToggleBtn = panel.getElementById('btn-toggle-min');
    const minToggleLabel = panel.getElementById('min-toggle-label');
    const badgeCounter = panel.getElementById('tasks-counter-badge');
    const headerAddBtn = panel.getElementById('btn-add-task-header');
    const keyboardBox = panel.getElementById('keyboard-box');
    const kbPreviewText = panel.getElementById('kb-preview-text');

    // Ensure default minimized state
    if (this.isMinimized) {
      if (checklistBody) {
        checklistBody.setProperties({ display: 'none' });
      }
      if (minToggleLabel) {
        minToggleLabel.setProperties({ text: 'Expand' });
      }
      if (headerAddBtn) {
        headerAddBtn.setProperties({ display: 'none' });
      }
    }

    // --- Scroll Up / Down arrows ---
    const btnScrollUp = panel.getElementById('btn-scroll-up');
    if (btnScrollUp) {
      const onScrollUp = () => {
        if (this.scrollOffset > 0) {
          this.scrollOffset--;
          this.renderAllTasks(panel);
        }
      };
      btnScrollUp.addEventListener('click', onScrollUp);
      this.cleanupFuncs.push(() => btnScrollUp.removeEventListener('click', onScrollUp));
    }

    const btnScrollDown = panel.getElementById('btn-scroll-down');
    if (btnScrollDown) {
      const onScrollDown = () => {
        const maxOffset = Math.max(0, this.tasks.length - 5);
        if (this.scrollOffset < maxOffset) {
          this.scrollOffset++;
          this.renderAllTasks(panel);
        }
      };
      btnScrollDown.addEventListener('click', onScrollDown);
      this.cleanupFuncs.push(() => btnScrollDown.removeEventListener('click', onScrollDown));
    }

    // --- Minimizable toggle handler ---
    if (minToggleBtn) {
      const onMinToggle = () => {
        this.isMinimized = !this.isMinimized;
        if (checklistBody) {
          checklistBody.setProperties({
            display: this.isMinimized ? 'none' : 'flex',
          });
        }
        if (minToggleLabel) {
          minToggleLabel.setProperties({
            text: this.isMinimized ? 'Expand' : 'Hide',
          });
        }
        if (headerAddBtn) {
          const isEmpty = this.tasks.length === 0;
          headerAddBtn.setProperties({
            display: isEmpty || this.isMinimized ? 'none' : 'flex',
          });
        }
        this.updateBadge(badgeCounter);
      };
      minToggleBtn.addEventListener('click', onMinToggle);
      this.cleanupFuncs.push(() => minToggleBtn.removeEventListener('click', onMinToggle));
    }

    // --- Task check/uncheck buttons (0..4) ---
    for (let i = 0; i < 5; i++) {
      const btn = panel.getElementById(`btn-task-${i}`);
      if (btn) {
        const onTaskClick = () => {
          const actualIdx = this.scrollOffset + i;
          this.toggleTask(actualIdx, panel);
        };
        btn.addEventListener('click', onTaskClick);
        this.cleanupFuncs.push(() => btn.removeEventListener('click', onTaskClick));
      }

      // Pencil Edit buttons
      const pencilBtn = panel.getElementById(`btn-edit-${i}`);
      if (pencilBtn) {
        const onEditClick = () => {
          const actualIdx = this.scrollOffset + i;
          this.startEditingTask(actualIdx, panel);
        };
        pencilBtn.addEventListener('click', onEditClick);
        this.cleanupFuncs.push(() => pencilBtn.removeEventListener('click', onEditClick));
      }
    }

    // --- Toggle Keyboard button ---
    const btnToggleKb = panel.getElementById('btn-toggle-keyboard');
    if (btnToggleKb) {
      const onToggleKb = () => {
        if (this.isKeyboardOpen) {
          this.closeKeyboard(panel);
        } else {
          if (this.tasks.length === 0) {
            this.addNewTask(panel);
          } else {
            this.startEditingTask(this.scrollOffset, panel);
          }
        }
      };
      btnToggleKb.addEventListener('click', onToggleKb);
      this.cleanupFuncs.push(() => btnToggleKb.removeEventListener('click', onToggleKb));
    }

    // --- Add Task button (action row) ---
    const addBtn = panel.getElementById('btn-add-task');
    if (addBtn) {
      const onAdd = () => {
        this.addNewTask(panel);
      };
      addBtn.addEventListener('click', onAdd);
      this.cleanupFuncs.push(() => addBtn.removeEventListener('click', onAdd));
    }

    // --- Empty State Add button ---
    const emptyAddBtn = panel.getElementById('btn-empty-add');
    if (emptyAddBtn) {
      const onEmptyAdd = () => {
        this.addNewTask(panel);
      };
      emptyAddBtn.addEventListener('click', onEmptyAdd);
      this.cleanupFuncs.push(() => emptyAddBtn.removeEventListener('click', onEmptyAdd));
    }

    // --- Header Add Task button ---
    if (headerAddBtn) {
      const onHeaderAdd = () => {
        this.addNewTask(panel);
      };
      headerAddBtn.addEventListener('click', onHeaderAdd);
      this.cleanupFuncs.push(() => headerAddBtn.removeEventListener('click', onHeaderAdd));
    }

    // --- Reset Tasks button ---
    const resetBtn = panel.getElementById('btn-reset-tasks');
    if (resetBtn) {
      const onReset = () => {
        this.tasks.forEach((t) => (t.done = false));
        this.syncToGraph();
        this.renderAllTasks(panel);
      };
      resetBtn.addEventListener('click', onReset);
      this.cleanupFuncs.push(() => resetBtn.removeEventListener('click', onReset));
    }

    // --- Delete Task button (in keyboard bar) ---
    const btnDeleteTask = panel.getElementById('btn-delete-task');
    if (btnDeleteTask) {
      const onDeleteTask = () => {
        if (this.editingTaskIndex !== null && this.editingTaskIndex >= 0 && this.editingTaskIndex < this.tasks.length) {
          this.tasks.splice(this.editingTaskIndex, 1);
          this.syncToGraph();
          this.closeKeyboard(panel);
          this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, Math.max(0, this.tasks.length - 5)));
          this.renderAllTasks(panel);
        }
      };
      btnDeleteTask.addEventListener('click', onDeleteTask);
      this.cleanupFuncs.push(() => btnDeleteTask.removeEventListener('click', onDeleteTask));
    }

    // --- Inbuilt Virtual Keyboard Key bindings ---
    const alphabet = 'abcdefghijklmnopqrstuvwxyz'.split('');
    alphabet.forEach((letter) => {
      const keyBtn = panel.getElementById(`k-${letter}`);
      if (keyBtn) {
        const onKey = () => {
          this.editingBuffer += (this.editingBuffer.length === 0 || this.editingBuffer.endsWith(' '))
            ? letter.toUpperCase()
            : letter;
          this.updateKbDisplay(kbPreviewText);
        };
        keyBtn.addEventListener('click', onKey);
        this.cleanupFuncs.push(() => keyBtn.removeEventListener('click', onKey));
      }
    });

    // Space key
    const spaceBtn = panel.getElementById('k-space');
    if (spaceBtn) {
      const onSpace = () => {
        this.editingBuffer += ' ';
        this.updateKbDisplay(kbPreviewText);
      };
      spaceBtn.addEventListener('click', onSpace);
      this.cleanupFuncs.push(() => spaceBtn.removeEventListener('click', onSpace));
    }

    // Delete / Backspace key
    const delBtn = panel.getElementById('k-backspace');
    if (delBtn) {
      const onDel = () => {
        if (this.editingBuffer.length > 0) {
          this.editingBuffer = this.editingBuffer.slice(0, -1);
          this.updateKbDisplay(kbPreviewText);
        }
      };
      delBtn.addEventListener('click', onDel);
      this.cleanupFuncs.push(() => delBtn.removeEventListener('click', onDel));
    }

    // Clear key
    const clrBtn = panel.getElementById('k-clear');
    if (clrBtn) {
      const onClr = () => {
        this.editingBuffer = '';
        this.updateKbDisplay(kbPreviewText);
      };
      clrBtn.addEventListener('click', onClr);
      this.cleanupFuncs.push(() => clrBtn.removeEventListener('click', onClr));
    }

    // Save key
    const saveBtn = panel.getElementById('k-save');
    if (saveBtn) {
      const onSave = () => {
        if (this.editingTaskIndex !== null && this.tasks[this.editingTaskIndex]) {
          const finalVal = this.editingBuffer.trim();
          if (finalVal.length > 0) {
            this.tasks[this.editingTaskIndex].text = finalVal;
          }
          this.syncToGraph();
        }
        this.closeKeyboard(panel);
        this.renderAllTasks(panel);
      };
      saveBtn.addEventListener('click', onSave);
      this.cleanupFuncs.push(() => saveBtn.removeEventListener('click', onSave));
    }

    // Close Keyboard button
    const kbCloseBtn = panel.getElementById('btn-kb-close');
    if (kbCloseBtn) {
      const onClose = () => {
        this.closeKeyboard(panel);
      };
      kbCloseBtn.addEventListener('click', onClose);
      this.cleanupFuncs.push(() => kbCloseBtn.removeEventListener('click', onClose));
    }

    // Hardware keyboard listener while in Edit Mode
    const onWindowKeyDown = (e: KeyboardEvent) => {
      if (!this.isKeyboardOpen) return;
      if (e.key === 'Backspace') {
        this.editingBuffer = this.editingBuffer.slice(0, -1);
        this.updateKbDisplay(kbPreviewText);
        e.preventDefault();
      } else if (e.key === 'Enter') {
        if (this.editingTaskIndex !== null && this.tasks[this.editingTaskIndex]) {
          const finalVal = this.editingBuffer.trim();
          if (finalVal.length > 0) {
            this.tasks[this.editingTaskIndex].text = finalVal;
          }
          this.syncToGraph();
        }
        this.closeKeyboard(panel);
        this.renderAllTasks(panel);
      } else if (e.key === 'Escape') {
        this.closeKeyboard(panel);
      } else if (e.key.length === 1) {
        this.editingBuffer += e.key;
        this.updateKbDisplay(kbPreviewText);
      }
    };
    window.addEventListener('keydown', onWindowKeyDown);
    this.cleanupFuncs.push(() => window.removeEventListener('keydown', onWindowKeyDown));

    // Subscribe to graph events to keep sidebar in sync with 3D nodes
    const unsubscribeGraph = workflowGraph.subscribe((event) => {
      if (event.kind === 'nodeUpdated' || event.kind === 'nodeAdded') {
        const node = event.node;
        if (node?.type === 'Checklist' && node.checklist) {
          const differs =
            node.checklist.length !== this.tasks.length ||
            node.checklist.some((it, idx) => this.tasks[idx]?.done !== it.done || this.tasks[idx]?.text !== it.text);
          if (differs) {
            this.tasks = node.checklist.map((it, idx) => ({
              id: it.id || String(idx + 1),
              text: it.text,
              done: Boolean(it.done),
            }));
            this.renderAllTasks(panel);
          }
        }
      } else if (event.kind === 'nodeRemoved') {
        const remainingChecklists = workflowGraph.allNodes().filter((n) => n.type === 'Checklist');
        if (remainingChecklists.length === 0 && this.tasks.length > 0) {
          this.tasks = [];
          this.renderAllTasks(panel);
        }
      }
    });
    this.cleanupFuncs.push(unsubscribeGraph);

    // Listen for voice task actions (create, edit, check, uncheck, toggle, delete, clear)
    const onTaskAction = (e: any) => {
      const detail = e.detail || {};
      const action = String(detail.action || '').toLowerCase();
      const text = detail.text || detail.task || detail.newText || '';
      const target = detail.target ?? detail.number ?? detail.index ?? detail.task;

      console.log('[ChecklistSystem] Received voice task action:', action, detail);

      if (action === 'create' || action === 'add') {
        this.createTaskFromVoice(text || String(target || 'New Task'), panel);
      } else if (action === 'edit' || action === 'modify' || action === 'rename' || action === 'update') {
        this.editTaskFromVoice(target, text, panel);
      } else if (action === 'check' || action === 'complete' || action === 'done') {
        this.checkTaskFromVoice(target, true, panel);
      } else if (action === 'uncheck' || action === 'undone' || action === 'incomplete') {
        this.checkTaskFromVoice(target, false, panel);
      } else if (action === 'toggle') {
        this.toggleTaskFromVoice(target, panel);
      } else if (action === 'delete' || action === 'remove') {
        this.deleteTaskFromVoice(target, panel);
      } else if (action === 'clear' || action === 'delete_all' || action === 'clear_all') {
        this.clearTasksFromVoice(panel);
      }
    };
    window.addEventListener('weavr:task-action', onTaskAction);
    this.cleanupFuncs.push(() => window.removeEventListener('weavr:task-action', onTaskAction));

    // Initial render
    this.renderAllTasks(panel);
  }

  private resolveTaskIndex(target: string | number | undefined): number {
    if (this.tasks.length === 0) return -1;
    if (typeof target === 'number') {
      const idx = target - 1; // 1-based index to 0-based
      return idx >= 0 && idx < this.tasks.length ? idx : -1;
    }
    const q = String(target || '').trim().toLowerCase();
    if (!q) return 0; // default to first task

    // Check ordinal/number words
    if (q === 'first' || q === '1st') return 0;
    if (q === 'second' || q === '2nd') return Math.min(1, this.tasks.length - 1);
    if (q === 'third' || q === '3rd') return Math.min(2, this.tasks.length - 1);
    if (q === 'fourth' || q === '4th') return Math.min(3, this.tasks.length - 1);
    if (q === 'fifth' || q === '5th') return Math.min(4, this.tasks.length - 1);
    if (q === 'last') return this.tasks.length - 1;

    // Check standalone digits (e.g. "1", "task 2", "step 3")
    const numMatch = q.match(/\b([1-9][0-9]?)\b/);
    if (numMatch) {
      const idx = parseInt(numMatch[1], 10) - 1;
      if (idx >= 0 && idx < this.tasks.length) return idx;
    }

    // Check text search
    const cleanQ = q.replace(/^(task|item|step|todo)\s*/i, '').trim();
    if (cleanQ) {
      const foundIdx = this.tasks.findIndex((t) => t.text.toLowerCase().includes(cleanQ));
      if (foundIdx !== -1) return foundIdx;
    }

    return -1;
  }

  createTaskFromVoice(text: string, panel: UIKitMLAsset): void {
    if (this.isMinimized) {
      this.isMinimized = false;
      const checklistBody = panel.getElementById('checklist-body');
      const minToggleLabel = panel.getElementById('min-toggle-label');
      if (checklistBody) checklistBody.setProperties({ display: 'flex' });
      if (minToggleLabel) minToggleLabel.setProperties({ text: 'Hide' });
    }

    const cleanText = text.trim() || `Task ${this.tasks.length + 1}`;
    // Deduplicate if identical task already exists in checklist
    const existing = this.tasks.find((t) => t.text.toLowerCase() === cleanText.toLowerCase());
    if (existing) {
      console.log(`[ChecklistSystem] Task "${cleanText}" already exists in checklist`);
      return;
    }

    const newTask: Task = {
      id: String(Date.now()),
      text: cleanText,
      done: false,
    };
    this.tasks.push(newTask);
    this.syncToGraph();
    this.scrollOffset = Math.max(0, this.tasks.length - 5);
    this.renderAllTasks(panel);
    console.log(`[ChecklistSystem] Voice added task: "${cleanText}"`);
  }

  editTaskFromVoice(target: string | number, newText: string, panel: UIKitMLAsset): boolean {
    const idx = this.resolveTaskIndex(target);
    if (idx === -1 || !newText.trim()) return false;
    const oldText = this.tasks[idx].text;
    this.tasks[idx].text = newText.trim();
    this.syncToGraph();
    this.renderAllTasks(panel);
    console.log(`[ChecklistSystem] Voice edited task #${idx + 1} from "${oldText}" to "${newText.trim()}"`);
    return true;
  }

  checkTaskFromVoice(target: string | number, done: boolean, panel: UIKitMLAsset): boolean {
    const idx = this.resolveTaskIndex(target);
    if (idx === -1) return false;
    this.tasks[idx].done = done;
    this.syncToGraph();
    this.renderAllTasks(panel);
    console.log(`[ChecklistSystem] Voice ${done ? 'checked' : 'unchecked'} task #${idx + 1} "${this.tasks[idx].text}"`);
    return true;
  }

  toggleTaskFromVoice(target: string | number, panel: UIKitMLAsset): boolean {
    const idx = this.resolveTaskIndex(target);
    if (idx === -1) return false;
    this.tasks[idx].done = !this.tasks[idx].done;
    this.syncToGraph();
    this.renderAllTasks(panel);
    console.log(`[ChecklistSystem] Voice toggled task #${idx + 1} to ${this.tasks[idx].done ? 'done' : 'undone'}`);
    return true;
  }

  deleteTaskFromVoice(target: string | number, panel: UIKitMLAsset): boolean {
    const idx = this.resolveTaskIndex(target);
    if (idx === -1) return false;
    const removed = this.tasks.splice(idx, 1)[0];
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, this.tasks.length - 5));
    this.syncToGraph();
    this.renderAllTasks(panel);
    console.log(`[ChecklistSystem] Voice deleted task #${idx + 1} "${removed.text}"`);
    return true;
  }

  clearTasksFromVoice(panel: UIKitMLAsset): void {
    this.tasks = [];
    this.scrollOffset = 0;
    this.syncToGraph();
    this.renderAllTasks(panel);
    console.log('[ChecklistSystem] Voice cleared all tasks');
  }

  private addNewTask(panel: UIKitMLAsset): void {
    const newIdx = this.tasks.length + 1;
    const newTask: Task = {
      id: String(Date.now()),
      text: `Task ${newIdx}`,
      done: false,
    };
    this.tasks.push(newTask);
    this.syncToGraph();
    this.scrollOffset = Math.max(0, this.tasks.length - 5);
    this.startEditingTask(this.tasks.length - 1, panel);
    this.renderAllTasks(panel);
  }

  private startEditingTask(index: number, panel: UIKitMLAsset): void {
    if (index < 0 || index >= this.tasks.length) return;
    this.editingTaskIndex = index;
    this.editingBuffer = this.tasks[index].text;
    this.isKeyboardOpen = true;

    const keyboardBox = panel.getElementById('keyboard-box');
    if (keyboardBox) {
      keyboardBox.setProperties({ display: 'flex' });
    }
    const kbToggleLabel = panel.getElementById('kb-toggle-btn-label');
    if (kbToggleLabel) {
      kbToggleLabel.setProperties({ text: 'Close KB' });
    }

    const kbPreviewText = panel.getElementById('kb-preview-text');
    this.updateKbDisplay(kbPreviewText);
  }

  private closeKeyboard(panel: UIKitMLAsset): void {
    this.isKeyboardOpen = false;
    this.editingTaskIndex = null;
    const keyboardBox = panel.getElementById('keyboard-box');
    if (keyboardBox) {
      keyboardBox.setProperties({ display: 'none' });
    }
    const kbToggleLabel = panel.getElementById('kb-toggle-btn-label');
    if (kbToggleLabel) {
      kbToggleLabel.setProperties({ text: 'Keyboard' });
    }
  }

  private updateKbDisplay(kbPreviewText: any): void {
    if (!kbPreviewText) return;
    const taskNum = (this.editingTaskIndex ?? 0) + 1;
    const displayVal = this.editingBuffer || 'Type here...';
    kbPreviewText.setProperties({
      text: `#${taskNum}: ${displayVal}`,
    });
  }

  private toggleTask(index: number, panel: UIKitMLAsset): void {
    if (index >= this.tasks.length) return;
    this.tasks[index].done = !this.tasks[index].done;
    this.syncToGraph();
    this.renderAllTasks(panel);
  }

  private renderAllTasks(panel: UIKitMLAsset): void {
    const badgeCounter = panel.getElementById('tasks-counter-badge');
    this.updateBadge(badgeCounter);

    const emptyBox = panel.getElementById('checklist-empty');
    const isEmpty = this.tasks.length === 0;

    if (emptyBox) {
      emptyBox.setProperties({ display: isEmpty ? 'flex' : 'none' });
    }

    // USER REQUIREMENT:
    // "DONT SHOW ADD TASK BUTTO NON TOP HEADE RIF THE LIST IS EMPTY, AS THERE IS ALREADY A BUTTON TO ADD TASK IN THE CENTER"
    const headerAddBtn = panel.getElementById('btn-add-task-header');
    if (headerAddBtn) {
      headerAddBtn.setProperties({
        display: isEmpty || this.isMinimized ? 'none' : 'flex',
      });
    }

    for (let i = 0; i < 5; i++) {
      const actualIdx = this.scrollOffset + i;
      const row = panel.getElementById(`row-task-${i}`);
      const label = panel.getElementById(`label-task-${i}`);
      const btn = panel.getElementById(`btn-task-${i}`);
      const iconDone = panel.getElementById(`icon-done-${i}`);
      const iconEmpty = panel.getElementById(`icon-empty-${i}`);
      const pencilBtn = panel.getElementById(`btn-edit-${i}`);
      const task = this.tasks[actualIdx];

      if (isEmpty || !task) {
        if (row) row.setProperties({ display: 'none' });
        if (btn) btn.setProperties({ display: 'none' });
        if (pencilBtn) pencilBtn.setProperties({ display: 'none' });
        continue;
      }

      if (row) row.setProperties({ display: 'flex' });
      if (btn) {
        btn.setProperties({
          display: 'flex',
          variant: task.done ? 'positive' : 'secondary',
        });
      }
      if (pencilBtn) {
        pencilBtn.setProperties({
          display: 'flex',
          variant: this.editingTaskIndex === actualIdx ? 'primary' : 'secondary',
        });
      }

      // USER REQUIREMENT:
      // "when check list selcted display the tick mark else show empty box"
      if (iconDone) {
        iconDone.setProperties({
          display: task.done ? 'flex' : 'none',
        });
      }
      if (iconEmpty) {
        iconEmpty.setProperties({
          display: task.done ? 'none' : 'flex',
        });
      }

      if (label) {
        const num = `${actualIdx + 1}.`;
        const cleanText = task.text.length > 24 ? `${task.text.slice(0, 24)}...` : task.text;
        const fullText = `${num} ${cleanText}`;

        // USER REQUIREMENT:
        // "WHEN THE CHECKLIST IS SELECTED IN GREEN, THE TEXT INSIDE SHOULD BE WHITE."
        label.setProperties({
          text: fullText,
          color: '#FFFFFF', // PURE WHITE text in all states!
        });
      }
    }
  }

  private updateBadge(badgeElement: any): void {
    if (!badgeElement) return;
    const completed = this.tasks.filter((t) => t.done).length;
    const total = this.tasks.length;
    const allDone = total > 0 && completed === total;

    badgeElement.setProperties({
      text: allDone ? `${completed}/${total} ✓` : `${completed}/${total}`,
      color: allDone ? '#34D399' : '#10B981',
    });
  }

  private syncToGraph(): void {
    const checklistNodes = workflowGraph.allNodes().filter((n) => n.type === 'Checklist');
    const items: ChecklistItem[] = this.tasks.map((t) => ({
      id: t.id,
      text: t.text,
      done: t.done,
    }));
    const allDone = items.length > 0 && items.every((t) => t.done);

    if (checklistNodes.length > 0) {
      for (const node of checklistNodes) {
        workflowGraph.updateNode(node.id, {
          checklist: items,
          state: allDone ? 'Completed' : 'Queued',
        });
      }
    }
  }
}
