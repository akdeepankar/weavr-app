/**
 * WireSystem — creates, destroys and updates wire visuals that
 * connect workflow nodes. Each wire is a TubeGeometry mesh that
 * follows a cubic Bezier curve between two connector positions.
 */

import {
  CubicBezierCurve3,
  Color,
  createSystem,
  Group,
  Mesh,
  MeshStandardMaterial,
  Pressed,
  RayInteractable,
  TubeGeometry,
  Vector3,
} from '@iwsdk/core';
import { WireVisual } from '../weavr-components.js';
import { WorkflowNode } from '../weavr-components.js';
import {
  workflowGraph,
  inputPortCount,
  outputPortCount,
  type ConnectionData,
  type GraphEvent,
} from '../services/workflow-graph.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WIRE_RADIUS = 0.0048;
const WIRE_SEGMENTS = 48;
const WIRE_RADIAL = 8;

// Pure luminous white connection wire material
const wireMaterial = new MeshStandardMaterial({
  color: new Color(0xffffff),
  emissive: new Color(0xffffff),
  emissiveIntensity: 0.72,
  roughness: 0.15,
  metalness: 0.08,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Positions are extracted from the workspace entity map. */
function getNodeWorldPosition(nodeId: string): Vector3 | null {
  const node = workflowGraph.getNode(nodeId);
  if (node == null) return null;
  return new Vector3(...node.position);
}

/** Connector offset from node center.
 * PANEL_W is 0.40m, so edge is at exactly 0.20m.
 * Connecting at exactly PANEL_W / 2 ensures the wire touches flush
 * against the card border end-to-end with ZERO floating gap or empty space.
 */
const PANEL_W = 0.40;
const CONNECTOR_OFFSET = PANEL_W / 2;

function getOutputPos(nodeId: string, port = 0): Vector3 | null {
  const node = workflowGraph.getNode(nodeId);
  if (node == null) return null;
  const pos = new Vector3(...node.position);
  pos.x += CONNECTOR_OFFSET; // Flush with right border
  pos.z += 0.002; // Aligned cleanly on front plane
  const outputs = outputPortCount(node.type);
  if (outputs > 1) {
    pos.y += -((port - (outputs - 1) / 2) * 0.30 * 0.5);
  }
  return pos;
}

function getInputPos(nodeId: string, port = 0): Vector3 | null {
  const node = workflowGraph.getNode(nodeId);
  if (node == null) return null;
  const pos = new Vector3(...node.position);
  pos.x -= CONNECTOR_OFFSET; // Flush with left border
  pos.z += 0.002;
  const inputs = inputPortCount(node.type);
  if (inputs > 1) {
    pos.y += -((port - (inputs - 1) / 2) * 0.30 * 0.5);
  }
  return pos;
}

function createWireCurve(start: Vector3, end: Vector3): CubicBezierCurve3 {
  const dist = start.distanceTo(end);
  const dx = Math.max(0.12, Math.min(0.42, dist * 0.45));
  return new CubicBezierCurve3(
    start,
    new Vector3(start.x + dx, start.y, start.z),
    new Vector3(end.x - dx, end.y, end.z),
    end,
  );
}

// ---------------------------------------------------------------------------
// Wire visual store
// ---------------------------------------------------------------------------

interface WireEntry {
  group: Group;
  mesh: Mesh;
  connection: ConnectionData;
  entity: unknown;
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export class WireSystem extends createSystem({
  wires: { required: [WireVisual] },
  nodes: { required: [WorkflowNode] },
  clickedWire: { required: [WireVisual, Pressed] },
}) {
  private wireMap = new Map<string, WireEntry>();
  private tmpStart = new Vector3();
  private tmpEnd = new Vector3();

  init(): void {
    // Click wire to disconnect
    const offClick = this.queries.clickedWire.subscribe('qualify', (entity) => {
      const wireId = entity.getValue(WireVisual, 'wireId');
      if (wireId) {
        console.log('[WeaVR] Disconnecting wire:', wireId);
        workflowGraph.removeConnection(wireId);
      }
    });
    this.cleanupFuncs.push(offClick);

    const unsubscribe = workflowGraph.subscribe((event: GraphEvent) => {
      switch (event.kind) {
        case 'connectionAdded':
          this.spawnWire(event.connection);
          break;
        case 'connectionRemoved':
          this.despawnWire(event.connectionId);
          break;
        case 'nodeRemoved':
          // Connections are removed before node events, handled above
          break;
      }
    });
    this.cleanupFuncs.push(unsubscribe);
  }

  private spawnWire(connection: ConnectionData): void {
    const start = getOutputPos(connection.sourceNodeId, connection.sourcePort);
    const end = getInputPos(connection.targetNodeId, connection.targetPort);
    if (start == null || end == null) return;

    const curve = createWireCurve(start, end);
    const geometry = new TubeGeometry(
      curve,
      WIRE_SEGMENTS,
      WIRE_RADIUS,
      WIRE_RADIAL,
      false,
    );
    const mesh = new Mesh(geometry, wireMaterial);
    mesh.castShadow = true;
    const group = new Group();
    group.name = `weavr-wire-${connection.id}`;
    group.add(mesh);

    const entity = (this.world as any).createTransformEntity(
      group,
      `weavr-wire-${connection.id}`,
    );
    if (entity.addComponent) {
      entity.addComponent(WireVisual);
      entity.setValue(WireVisual, 'wireId', connection.id);
      entity.addComponent(RayInteractable);
    }

    this.wireMap.set(connection.id, { group, mesh, connection, entity });
  }

  private despawnWire(connectionId: string): void {
    const entry = this.wireMap.get(connectionId);
    if (entry == null) return;
    const ent = entry.entity as any;
    if (ent?.dispose) ent.dispose();
    entry.mesh.geometry.dispose();
    entry.group.removeFromParent();
    this.wireMap.delete(connectionId);
  }

  /**
   * Each frame, rebuild wire geometry if the connected nodes have moved.
   * Only updates wires whose endpoints actually changed.
   */
  update(): void {
    for (const [connId, entry] of this.wireMap) {
      const conn = entry.connection;
      const start = getOutputPos(conn.sourceNodeId, conn.sourcePort);
      const end = getInputPos(conn.targetNodeId, conn.targetPort);
      if (start == null || end == null) continue;

      // Check if either endpoint moved
      const meshPos = entry.group.position;
      const startMoved =
        Math.abs(start.x - (this.tmpStart.x || 0)) > 0.002 ||
        Math.abs(start.y - (this.tmpStart.y || 0)) > 0.002;

      // Always update for simplicity (wires are cheap)
      const curve = createWireCurve(start, end);
      const newGeometry = new TubeGeometry(
        curve,
        WIRE_SEGMENTS,
        WIRE_RADIUS,
        WIRE_RADIAL,
        false,
      );
      entry.mesh.geometry.dispose();
      entry.mesh.geometry = newGeometry;
    }
  }
}

