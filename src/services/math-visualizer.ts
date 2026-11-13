/**
 * MathVisualizer — 3D procedural spatial mathematical concepts, surfaces,
 * polyhedra, theorems, and real-time element highlighting for WebXR.
 *
 * Supports:
 * - Pythagorean Theorem with 3D squares & hypotenuse proof
 * - Polyhedra & Euler Formula (Cube, Tetrahedron, Platonic Solids)
 * - Multivariable Calculus Surfaces (Hyperbolic Saddle, Paraboloid)
 * - Trigonometric Unit Circle (sine, cosine, tangent projections)
 * - Vector Cross Product & Parallelogram Area (Right-hand rule)
 * - Dynamic Edge / Face / Vertex / Curve Highlighting
 */

import {
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  RingGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from '@iwsdk/core';
import type { MathConceptConfig, MathHighlight } from './workflow-graph.js';
import { createTextSprite, resolveColor } from './data-visualizer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function createRod(
  p1: Vector3,
  p2: Vector3,
  radius = 0.003,
  colorHex = 0x8b5cf6,
  emissiveIntensity = 0.35,
): Mesh {
  const dir = new Vector3().subVectors(p2, p1);
  const length = dir.length();
  if (length < 0.0001) {
    const geo = new SphereGeometry(radius * 1.5, 8, 8);
    const mat = new MeshStandardMaterial({ color: colorHex });
    const m = new Mesh(geo, mat);
    m.position.copy(p1);
    return m;
  }

  const geo = new CylinderGeometry(radius, radius, length, 12);
  const mat = new MeshStandardMaterial({
    color: new Color(colorHex),
    emissive: new Color(colorHex),
    emissiveIntensity,
    roughness: 0.3,
    metalness: 0.2,
  });
  const mesh = new Mesh(geo, mat);

  mesh.position.copy(p1).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir.clone().normalize());
  return mesh;
}

function createArrow(
  origin: Vector3,
  target: Vector3,
  colorHex: number,
  radius = 0.0035,
  headLength = 0.025,
  headRadius = 0.008,
): Group {
  const group = new Group();
  const dir = new Vector3().subVectors(target, origin);
  const totalLength = dir.length();
  const shaftLength = Math.max(0.005, totalLength - headLength);
  const shaftEnd = origin.clone().addScaledVector(dir.clone().normalize(), shaftLength);

  // Shaft
  const shaft = createRod(origin, shaftEnd, radius, colorHex, 0.5);
  group.add(shaft);

  // Cone Head
  const coneGeo = new ConeGeometry(headRadius, headLength, 12);
  const coneMat = new MeshStandardMaterial({
    color: new Color(colorHex),
    emissive: new Color(colorHex),
    emissiveIntensity: 0.6,
  });
  const cone = new Mesh(coneGeo, coneMat);
  cone.position.copy(target).addScaledVector(dir.clone().normalize(), -headLength / 2);
  cone.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir.clone().normalize());
  group.add(cone);

  return group;
}

function resolveHighlight(
  name: string,
  config: MathConceptConfig,
  defaultColorHex = 0x64748b,
): { active: boolean; color: number } {
  const targetName = name.toLowerCase().trim();

  // Quick single highlight
  if (config.highlightName) {
    const quick = config.highlightName.toLowerCase().trim();
    if (quick === targetName || targetName.includes(quick) || quick.includes(targetName)) {
      const c = resolveColor(config.highlightColor || 'neon green', 0x22c55e);
      return { active: true, color: c };
    }
  }

  // Multiple highlights
  if (config.highlights && config.highlights.length > 0) {
    for (const h of config.highlights) {
      const hn = h.name.toLowerCase().trim();
      if (hn === targetName || targetName.includes(hn) || hn.includes(targetName)) {
        return { active: true, color: resolveColor(h.color, 0x22c55e) };
      }
    }
  }

  return { active: false, color: defaultColorHex };
}

// ---------------------------------------------------------------------------
// Concept Builders
// ---------------------------------------------------------------------------

/**
 * 1. Pythagorean Theorem: a² + b² = c² in 3D
 * Right-angled triangle with 3D square prisms on all three sides.
 */
function buildPythagoras(config: MathConceptConfig): Group {
  const group = new Group();

  const a = 0.12; // leg a (base along X)
  const b = 0.09; // leg b (height along Y)
  const c = Math.sqrt(a * a + b * b); // hypotenuse = 0.15

  const pA = new Vector3(-a / 2, 0, 0); // (0,0) corner
  const pB = new Vector3(a / 2, 0, 0); // leg a end
  const pC = new Vector3(-a / 2, b, 0); // leg b end

  // Check highlights
  const hHyp = resolveHighlight('hypotenuse', config, 0x38bdf8);
  const hLegA = resolveHighlight('leg_a', config, 0xa855f7);
  const hLegB = resolveHighlight('leg_b', config, 0xf59e0b);
  const hSquareC = resolveHighlight('square_c', config, 0x38bdf8);

  // 1. Right Triangle Edges
  const legARod = createRod(pA, pB, hLegA.active ? 0.005 : 0.003, hLegA.color, hLegA.active ? 0.7 : 0.3);
  const legBRod = createRod(pA, pC, hLegB.active ? 0.005 : 0.003, hLegB.color, hLegB.active ? 0.7 : 0.3);
  const hypRod = createRod(pB, pC, hHyp.active ? 0.006 : 0.004, hHyp.color, hHyp.active ? 0.8 : 0.4);
  group.add(legARod, legBRod, hypRod);

  // Right angle indicator box at corner pA
  const rSize = 0.015;
  const rightCornerPts = [
    pA.x + rSize, pA.y, 0,
    pA.x + rSize, pA.y + rSize, 0,
    pA.x + rSize, pA.y + rSize, 0,
    pA.x, pA.y + rSize, 0,
  ];
  const rcGeo = new BufferGeometry();
  rcGeo.setAttribute('position', new Float32BufferAttribute(rightCornerPts, 3));
  const rcLine = new LineSegments(rcGeo, new LineBasicMaterial({ color: 0xe2e8f0 }));
  group.add(rcLine);

  // 2. 3D Square Prisms on each side (geometric area proof)
  const thickness = 0.008;

  // Square A (downward on leg a): size a x a
  const sqAGeo = new BoxGeometry(a, a, thickness);
  const sqAMat = new MeshStandardMaterial({
    color: hLegA.color,
    transparent: true,
    opacity: hLegA.active ? 0.8 : 0.45,
    roughness: 0.4,
  });
  const sqAMesh = new Mesh(sqAGeo, sqAMat);
  sqAMesh.position.set(0, -a / 2, 0);
  group.add(sqAMesh);

  // Square B (leftward on leg b): size b x b
  const sqBGeo = new BoxGeometry(b, b, thickness);
  const sqBMat = new MeshStandardMaterial({
    color: hLegB.color,
    transparent: true,
    opacity: hLegB.active ? 0.8 : 0.45,
    roughness: 0.4,
  });
  const sqBMesh = new Mesh(sqBGeo, sqBMat);
  sqBMesh.position.set(-a / 2 - b / 2, b / 2, 0);
  group.add(sqBMesh);

  // Square C (on hypotenuse): size c x c, tilted along hypotenuse normal
  const hypAngle = Math.atan2(b, -a); // angle of hypotenuse
  const sqCGeo = new BoxGeometry(c, c, thickness);
  const sqCMat = new MeshStandardMaterial({
    color: hSquareC.color,
    transparent: true,
    opacity: hHyp.active || hSquareC.active ? 0.85 : 0.5,
    emissive: new Color(hSquareC.color),
    emissiveIntensity: hHyp.active || hSquareC.active ? 0.3 : 0.05,
    roughness: 0.3,
  });
  const sqCMesh = new Mesh(sqCGeo, sqCMat);
  // Center of hypotenuse
  const midHyp = new Vector3().addVectors(pB, pC).multiplyScalar(0.5);
  // Normal direction outward from hypotenuse
  const hypDir = new Vector3().subVectors(pC, pB).normalize();
  const hypNormal = new Vector3(-hypDir.y, hypDir.x, 0); // perpendicular outward
  sqCMesh.position.copy(midHyp).addScaledVector(hypNormal, c / 2);
  sqCMesh.rotation.z = Math.atan2(hypDir.y, hypDir.x);
  group.add(sqCMesh);

  // 3. Educational Labels — prominent badges
  const lblHyp = createTextSprite(
    hHyp.active ? '★ Hypotenuse c = √(a²+b²)' : 'c (Hypotenuse)',
    hHyp.active ? '#22C55E' : '#38BDF8',
    28,
    0.28,
    0.052,
    true,
  );
  lblHyp.position.copy(midHyp).addScaledVector(hypNormal, 0.035);
  group.add(lblHyp);

  const lblA = createTextSprite('a (Leg = 12)', '#CBD5E1', 24, 0.18, 0.042, true);
  lblA.position.set(0, -0.035, 0.015);
  group.add(lblA);

  const lblB = createTextSprite('b (Leg = 9)', '#CBD5E1', 24, 0.18, 0.042, true);
  lblB.position.set(-a / 2 - 0.045, b / 2, 0.015);
  group.add(lblB);

  // Formula badge
  const formulaBadge = createTextSprite(
    'Pythagorean Theorem: a² + b² = c²',
    '#F59E0B',
    32,
    0.38,
    0.065,
    true,
  );
  formulaBadge.position.set(0, b + c * 0.7 + 0.06, 0);
  group.add(formulaBadge);

  return group;
}

/**
 * 2. 3D Polyhedra & Euler Formula: V - E + F = 2
 * Visualizes a cube with internal space diagonal, faces, and vertex callouts.
 */
function buildCube(config: MathConceptConfig): Group {
  const group = new Group();
  const s = 0.07; // half size (0.14m cube)

  const hDiag = resolveHighlight('diagonal', config, 0xf59e0b);
  const hTopFace = resolveHighlight('top_face', config, 0x06b6d4);
  const hEdges = resolveHighlight('edges', config, 0x8b5cf6);
  const hVertices = resolveHighlight('vertices', config, 0xec4899);

  // Vertices
  const vertices = [
    new Vector3(-s, -s, -s),
    new Vector3(s, -s, -s),
    new Vector3(s, s, -s),
    new Vector3(-s, s, -s),
    new Vector3(-s, -s, s),
    new Vector3(s, -s, s),
    new Vector3(s, s, s),
    new Vector3(-s, s, s),
  ];

  // 12 Edges (pairs of vertex indices)
  const edges = [
    [0, 1], [1, 2], [2, 3], [3, 0], // back face
    [4, 5], [5, 6], [6, 7], [7, 4], // front face
    [0, 4], [1, 5], [2, 6], [3, 7], // connectors
  ];

  for (const [i1, i2] of edges) {
    const isEdgeH = hEdges.active;
    const rod = createRod(
      vertices[i1],
      vertices[i2],
      isEdgeH ? 0.004 : 0.0025,
      isEdgeH ? hEdges.color : 0x475569,
      isEdgeH ? 0.6 : 0.2,
    );
    group.add(rod);
  }

  // Corner Spheres
  const vMat = new MeshStandardMaterial({
    color: hVertices.color,
    emissive: new Color(hVertices.color),
    emissiveIntensity: hVertices.active ? 0.8 : 0.3,
  });
  const vGeo = new SphereGeometry(hVertices.active ? 0.006 : 0.004, 12, 12);
  for (const v of vertices) {
    const sphere = new Mesh(vGeo, vMat);
    sphere.position.copy(v);
    group.add(sphere);
  }

  // Semi-transparent faces
  const cubeGeo = new BoxGeometry(s * 2, s * 2, s * 2);
  const cubeMat = new MeshStandardMaterial({
    color: 0x6366f1,
    transparent: true,
    opacity: 0.12,
    roughness: 0.2,
  });
  const cubeMesh = new Mesh(cubeGeo, cubeMat);
  group.add(cubeMesh);

  // Highlighted Top Face
  if (hTopFace.active) {
    const topGeo = new PlaneGeometry(s * 2, s * 2);
    const topMat = new MeshStandardMaterial({
      color: hTopFace.color,
      emissive: new Color(hTopFace.color),
      emissiveIntensity: 0.4,
      transparent: true,
      opacity: 0.5,
      side: DoubleSide,
    });
    const topMesh = new Mesh(topGeo, topMat);
    topMesh.position.set(0, s + 0.001, 0);
    topMesh.rotation.x = -Math.PI / 2;
    group.add(topMesh);
  }

  // Internal Space Diagonal (cutting from (-s,-s,-s) to (+s,+s,+s))
  const diagColor = hDiag.color;
  const diagRod = createRod(
    vertices[0],
    vertices[6],
    hDiag.active ? 0.005 : 0.0035,
    diagColor,
    hDiag.active ? 0.9 : 0.4,
  );
  group.add(diagRod);

  // Callout for Space Diagonal
  const diagLabel = createTextSprite(
    hDiag.active ? '★ Space Diagonal: d = a√3' : 'Space Diagonal (a√3)',
    hDiag.active ? '#F59E0B' : '#94A3B8',
    26,
    0.28,
    0.052,
    true,
  );
  diagLabel.position.set(0, 0, 0);
  group.add(diagLabel);

  // Floating Euler Theorem Badges
  const badge = createTextSprite(
    'Euler Polyhedral Formula: V - E + F = 2',
    '#A855F7',
    32,
    0.42,
    0.068,
    true,
  );
  badge.position.set(0, s + 0.075, 0);
  group.add(badge);

  const subBadge = createTextSprite(
    'Cube: 8 Vertices − 12 Edges + 6 Faces = 2',
    '#CBD5E1',
    24,
    0.36,
    0.048,
    true,
  );
  subBadge.position.set(0, s + 0.028, 0);
  group.add(subBadge);

  return group;
}

/**
 * 3. Hyperbolic Paraboloid (Saddle Surface): z = (x² - y²) / 2
 * Visualizes multivariable saddle point, positive and negative curvature.
 */
function buildSaddle(config: MathConceptConfig): Group {
  const group = new Group();
  const N = 24; // resolution
  const size = 0.16;

  const hSaddle = resolveHighlight('saddle_point', config, 0xef4444);
  const hRidge = resolveHighlight('ridge', config, 0xf59e0b);
  const hValley = resolveHighlight('valley', config, 0x06b6d4);

  // Build grid mesh vertices & indices
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= N; i++) {
    const u = (i / N) * 2 - 1; // -1 to 1
    const x = u * size * 0.5;

    for (let j = 0; j <= N; j++) {
      const v = (j / N) * 2 - 1; // -1 to 1
      const y = v * size * 0.5;
      const z = (u * u - v * v) * 0.06; // hyperbolic height

      positions.push(x, z, y);

      // Color mapping: u² is ridge (warm), -v² is valley (cool cyan)
      const normH = (z + 0.06) / 0.12;
      const c = new Color().lerpColors(new Color(0x06b6d4), new Color(0xf59e0b), normH);
      colors.push(c.r, c.g, c.b);
    }
  }

  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const a = i * (N + 1) + j;
      const b = (i + 1) * (N + 1) + j;
      const c = (i + 1) * (N + 1) + (j + 1);
      const d = i * (N + 1) + (j + 1);

      indices.push(a, b, d);
      indices.push(b, c, d);
    }
  }

  const surfaceGeo = new BufferGeometry();
  surfaceGeo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  surfaceGeo.setAttribute('color', new Float32BufferAttribute(colors, 3));
  surfaceGeo.setIndex(indices);
  surfaceGeo.computeVertexNormals();

  const surfaceMat = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.35,
    metalness: 0.1,
    side: DoubleSide,
    transparent: true,
    opacity: 0.85,
  });
  const surfaceMesh = new Mesh(surfaceGeo, surfaceMat);
  group.add(surfaceMesh);

  // Wireframe contour lines
  const wireMat = new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.18 });
  const wireGeo = new BufferGeometry();
  const wirePts: number[] = [];
  for (let i = 0; i <= N; i += 3) {
    for (let j = 0; j < N; j++) {
      const idx1 = (i * (N + 1) + j) * 3;
      const idx2 = (i * (N + 1) + j + 1) * 3;
      wirePts.push(positions[idx1], positions[idx1 + 1], positions[idx1 + 2]);
      wirePts.push(positions[idx2], positions[idx2 + 1], positions[idx2 + 2]);
    }
  }
  wireGeo.setAttribute('position', new Float32BufferAttribute(wirePts, 3));
  const wireLines = new LineSegments(wireGeo, wireMat);
  group.add(wireLines);

  // Highlight Saddle Point (0,0,0)
  const saddlePtGeo = new SphereGeometry(hSaddle.active ? 0.008 : 0.005, 14, 14);
  const saddlePtMat = new MeshStandardMaterial({
    color: hSaddle.color,
    emissive: new Color(hSaddle.color),
    emissiveIntensity: hSaddle.active ? 0.9 : 0.5,
  });
  const saddlePt = new Mesh(saddlePtGeo, saddlePtMat);
  saddlePt.position.set(0, 0, 0);
  group.add(saddlePt);

  const saddleLabel = createTextSprite(
    hSaddle.active ? '★ Saddle Point (∇f = 0)' : 'Saddle Point (0, 0, 0)',
    hSaddle.active ? '#EF4444' : '#F87171',
    26,
    0.28,
    0.052,
    true,
  );
  saddleLabel.position.set(0, 0.038, 0);
  group.add(saddleLabel);

  // Formula badge
  const badge = createTextSprite(
    'Hyperbolic Paraboloid: z = x² - y²',
    '#38BDF8',
    32,
    0.40,
    0.068,
    true,
  );
  badge.position.set(0, 0.13, 0);
  group.add(badge);

  return group;
}

/**
 * 4. Elliptic Paraboloid: z = x² + y² (Bowl)
 */
function buildParaboloid(config: MathConceptConfig): Group {
  const group = new Group();
  const N = 24;
  const radius = 0.09;

  const hMin = resolveHighlight('minimum', config, 0x10b981);

  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= N; i++) {
    const r = (i / N) * radius;
    for (let j = 0; j <= N; j++) {
      const theta = (j / N) * Math.PI * 2;
      const x = r * Math.cos(theta);
      const z = r * Math.sin(theta);
      const y = ((r / radius) * (r / radius)) * 0.12; // parabolic height

      positions.push(x, y, z);

      const normH = y / 0.12;
      const c = new Color().lerpColors(new Color(0x3b82f6), new Color(0xec4899), normH);
      colors.push(c.r, c.g, c.b);
    }
  }

  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const a = i * (N + 1) + j;
      const b = (i + 1) * (N + 1) + j;
      const c = (i + 1) * (N + 1) + (j + 1);
      const d = i * (N + 1) + (j + 1);

      indices.push(a, b, d);
      indices.push(b, c, d);
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const mat = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.3,
    metalness: 0.1,
    side: DoubleSide,
    transparent: true,
    opacity: 0.85,
  });
  group.add(new Mesh(geo, mat));

  // Minimum Point at vertex (0,0,0)
  const minSphere = new Mesh(
    new SphereGeometry(hMin.active ? 0.007 : 0.004, 12, 12),
    new MeshStandardMaterial({ color: hMin.color, emissive: new Color(hMin.color), emissiveIntensity: 0.8 }),
  );
  group.add(minSphere);

  const minLabel = createTextSprite(
    hMin.active ? '★ Global Minimum (0, 0, 0)' : 'Minimum (0, 0, 0)',
    '#10B981',
    26,
    0.28,
    0.052,
    true,
  );
  minLabel.position.set(0, -0.032, 0);
  group.add(minLabel);

  // Formula badge
  const badge = createTextSprite(
    'Elliptic Paraboloid: z = x² + y²',
    '#EC4899',
    32,
    0.40,
    0.068,
    true,
  );
  badge.position.set(0, 0.17, 0);
  group.add(badge);

  return group;
}

/**
 * 5. Trigonometric Unit Circle: sin²(θ) + cos²(θ) = 1 in 3D
 */
function buildUnitCircle(config: MathConceptConfig): Group {
  const group = new Group();
  const R = 0.09;
  const theta = Math.PI / 4; // 45 degrees

  const hSin = resolveHighlight('sine', config, 0xf43f5e);
  const hCos = resolveHighlight('cosine', config, 0x06b6d4);
  const hTan = resolveHighlight('tangent', config, 0xf59e0b);
  const hRadius = resolveHighlight('hypotenuse', config, 0x10b981);

  // 1. Circular wireframe ring
  const ringGeo = new RingGeometry(R - 0.0015, R + 0.0015, 64);
  const ringMat = new MeshBasicMaterial({ color: 0x94a3b8, side: DoubleSide });
  const ring = new Mesh(ringGeo, ringMat);
  group.add(ring);

  // 2. Axes X and Y
  const axisMat = new LineBasicMaterial({ color: 0x475569 });
  const axisPts = [-R * 1.3, 0, 0, R * 1.3, 0, 0, 0, -R * 1.3, 0, 0, R * 1.3, 0];
  const axisGeo = new BufferGeometry();
  axisGeo.setAttribute('position', new Float32BufferAttribute(axisPts, 3));
  group.add(new LineSegments(axisGeo, axisMat));

  const pOrigin = new Vector3(0, 0, 0);
  const px = R * Math.cos(theta);
  const py = R * Math.sin(theta);
  const pCirc = new Vector3(px, py, 0);
  const pXProj = new Vector3(px, 0, 0);

  // 3. Radius line r = 1
  const radRod = createRod(pOrigin, pCirc, hRadius.active ? 0.004 : 0.0025, hRadius.color, 0.5);
  group.add(radRod);

  // 4. Cosine line on X axis (from 0 to px)
  const cosRod = createRod(pOrigin, pXProj, hCos.active ? 0.005 : 0.003, hCos.color, hCos.active ? 0.8 : 0.4);
  group.add(cosRod);

  // 5. Sine line vertical (from px,0 to px,py)
  const sinRod = createRod(pXProj, pCirc, hSin.active ? 0.005 : 0.003, hSin.color, hSin.active ? 0.8 : 0.4);
  group.add(sinRod);

  // 6. Tangent line from (R, 0) up to ray intersection
  const pTanBase = new Vector3(R, 0, 0);
  const pTanTop = new Vector3(R, R * Math.tan(theta), 0);
  const tanRod = createRod(pTanBase, pTanTop, hTan.active ? 0.005 : 0.0025, hTan.color, hTan.active ? 0.8 : 0.3);
  group.add(tanRod);

  // 7. Text Labels — prominent and clear
  const lblCos = createTextSprite(
    hCos.active ? '★ cos(θ)' : 'cos(θ)',
    hCos.active ? '#06B6D4' : '#67E8F9',
    24,
    0.16,
    0.042,
    true,
  );
  lblCos.position.set(px / 2, -0.028, 0.005);
  group.add(lblCos);

  const lblSin = createTextSprite(
    hSin.active ? '★ sin(θ)' : 'sin(θ)',
    hSin.active ? '#F43F5E' : '#FDA4AF',
    24,
    0.16,
    0.042,
    true,
  );
  lblSin.position.set(px + 0.038, py / 2, 0.005);
  group.add(lblSin);

  const lblTan = createTextSprite('tan(θ)', '#F59E0B', 24, 0.16, 0.042, true);
  lblTan.position.set(R + 0.035, (R * Math.tan(theta)) / 2, 0.005);
  group.add(lblTan);

  // Formula badge
  const badge = createTextSprite(
    'Unit Circle: sin²(θ) + cos²(θ) = 1',
    '#22C55E',
    32,
    0.42,
    0.068,
    true,
  );
  badge.position.set(0, R + 0.07, 0);
  group.add(badge);

  return group;
}

/**
 * 6. Vector Cross Product: C = A × B (Perpendicular Vector & Parallelogram Area)
 */
function buildCrossProduct(config: MathConceptConfig): Group {
  const group = new Group();

  const hCross = resolveHighlight('cross_product', config, 0xf59e0b);
  const hVecA = resolveHighlight('vector_a', config, 0x06b6d4);
  const hVecB = resolveHighlight('vector_b', config, 0xa855f7);

  const origin = new Vector3(0, 0, 0);
  const vecA = new Vector3(0.09, 0, 0.02);
  const vecB = new Vector3(0.02, 0, 0.08);

  // Vector C = A x B (points upward along Y)
  const vecC = new Vector3().crossVectors(vecA, vecB).multiplyScalar(150); // scaled for clear visibility (~0.11m)

  // Arrow A (cyan)
  group.add(createArrow(origin, vecA, hVecA.color, 0.0035, 0.02, 0.007));
  const lblA = createTextSprite('Vector A', '#06B6D4', 24, 0.18, 0.042, true);
  lblA.position.set(vecA.x + 0.03, 0, vecA.z);
  group.add(lblA);

  // Arrow B (purple)
  group.add(createArrow(origin, vecB, hVecB.color, 0.0035, 0.02, 0.007));
  const lblB = createTextSprite('Vector B', '#A855F7', 24, 0.18, 0.042, true);
  lblB.position.set(vecB.x, 0, vecB.z + 0.03);
  group.add(lblB);

  // Arrow C = A x B (gold, perpendicular)
  group.add(createArrow(origin, vecC, hCross.color, 0.0045, 0.025, 0.009));
  const lblC = createTextSprite(
    hCross.active ? '★ C = A × B (Perpendicular)' : 'C = A × B',
    '#F59E0B',
    28,
    0.32,
    0.052,
    true,
  );
  lblC.position.set(vecC.x, vecC.y + 0.035, vecC.z);
  group.add(lblC);

  // Shaded Parallelogram (representing magnitude |A x B| = Area)
  const pSum = new Vector3().addVectors(vecA, vecB);
  const pVerts = [
    origin.x, origin.y, origin.z,
    vecA.x, vecA.y, vecA.z,
    pSum.x, pSum.y, pSum.z,

    origin.x, origin.y, origin.z,
    pSum.x, pSum.y, pSum.z,
    vecB.x, vecB.y, vecB.z,
  ];
  const pGeo = new BufferGeometry();
  pGeo.setAttribute('position', new Float32BufferAttribute(pVerts, 3));
  pGeo.computeVertexNormals();
  const pMat = new MeshStandardMaterial({
    color: 0x6366f1,
    transparent: true,
    opacity: 0.35,
    side: DoubleSide,
  });
  group.add(new Mesh(pGeo, pMat));

  // Formula badge
  const badge = createTextSprite(
    'Cross Product: C = A × B ⟂ A, B  (|C| = Area)',
    '#F59E0B',
    32,
    0.46,
    0.068,
    true,
  );
  badge.position.set(0, vecC.y + 0.07, 0);
  group.add(badge);

  return group;
}

/**
 * 7. 3D Torus
 */
function buildTorus(config: MathConceptConfig): Group {
  const group = new Group();
  const hCurv = resolveHighlight('inner_equator', config, 0xef4444);

  const torusGeo = new TorusGeometry(0.08, 0.03, 16, 36);
  const torusMat = new MeshStandardMaterial({
    color: 0x8b5cf6,
    roughness: 0.3,
    metalness: 0.2,
    transparent: true,
    opacity: 0.8,
  });
  const torus = new Mesh(torusGeo, torusMat);
  torus.rotation.x = Math.PI / 2;
  group.add(torus);

  // Inner hole circle (negative curvature region)
  const innerRing = new Mesh(
    new RingGeometry(0.048, 0.052, 48),
    new MeshBasicMaterial({ color: hCurv.color, side: DoubleSide }),
  );
  innerRing.position.set(0, 0.001, 0);
  group.add(innerRing);

  // Formula badge
  const badge = createTextSprite(
    'Torus Surface: (R - √(x²+y²))² + z² = r²',
    '#A855F7',
    32,
    0.44,
    0.068,
    true,
  );
  badge.position.set(0, 0.12, 0);
  group.add(badge);

  return group;
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

export function buildMathVisualizationScene(config: MathConceptConfig): Group {
  const root = new Group();
  root.name = 'weavr-math-visualization-root';

  switch (config.conceptType) {
    case 'pythagoras':
      root.add(buildPythagoras(config));
      break;

    case 'cube':
      root.add(buildCube(config));
      break;

    case 'saddle':
      root.add(buildSaddle(config));
      break;

    case 'paraboloid':
      root.add(buildParaboloid(config));
      break;

    case 'unit_circle':
      root.add(buildUnitCircle(config));
      break;

    case 'cross_product':
      root.add(buildCrossProduct(config));
      break;

    case 'torus':
      root.add(buildTorus(config));
      break;

    default:
      root.add(buildPythagoras(config));
      break;
  }

  return root;
}

