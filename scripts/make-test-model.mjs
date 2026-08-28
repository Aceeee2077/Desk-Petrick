// ============================================================================
// Generates a simple blocky-cat GLB model for testing/demoing the 3D pet mode.
// Pure Node GLB (glTF 2.0) writer — no third-party dependencies.
// Output: src/assets/models/test-pet.glb
// ============================================================================

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'src', 'assets', 'models');
mkdirSync(OUT_DIR, { recursive: true });

// ---- unit cube (half = 0.5) with per-face CCW winding (viewed from outside) ----
const FACES = [
  { normal: [1, 0, 0], verts: [[0.5, 0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5]] },
  { normal: [-1, 0, 0], verts: [[-0.5, 0.5, 0.5], [-0.5, -0.5, 0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5]] },
  { normal: [0, 1, 0], verts: [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]] },
  { normal: [0, -1, 0], verts: [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]] },
  { normal: [0, 0, 1], verts: [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]] },
  { normal: [0, 0, -1], verts: [[0.5, 0.5, -0.5], [-0.5, 0.5, -0.5], [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5]] },
];

function buildBoxMesh(color) {
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  let base = 0;
  for (const face of FACES) {
    for (const v of face.verts) {
      positions.push(...v);
      normals.push(...face.normal);
      colors.push(...color);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    base += 4;
  }
  return { positions, normals, colors, indices };
}

// ---- blocky cat layout: body / head / ears / eyes ----
const ORANGE = [0.97, 0.62, 0.36];
const DARK = [0.16, 0.12, 0.1];

const parts = [
  { name: 'body', scale: [0.85, 0.5, 0.55], pos: [0, 0.4, 0], color: ORANGE },
  { name: 'head', scale: [0.52, 0.44, 0.46], pos: [0, 0.95, 0], color: ORANGE },
  { name: 'earL', scale: [0.13, 0.18, 0.13], pos: [-0.16, 1.34, 0], color: ORANGE },
  { name: 'earR', scale: [0.13, 0.18, 0.13], pos: [0.16, 1.34, 0], color: ORANGE },
  { name: 'eyeL', scale: [0.07, 0.1, 0.04], pos: [-0.13, 1.02, 0.21], color: DARK },
  { name: 'eyeR', scale: [0.07, 0.1, 0.04], pos: [0.13, 1.02, 0.21], color: DARK },
];

// ---- assemble binary + JSON ----
const binParts = [];
const bufferViews = [];
const accessors = [];
const meshes = [];
const nodes = [];

let byteOffset = 0;
function addView(data, target) {
  const aligned = (byteOffset + 3) & ~3;
  if (aligned > byteOffset) {
    binParts.push({ pad: aligned - byteOffset });
    byteOffset = aligned;
  }
  const view = { buffer: 0, byteOffset, byteLength: data.byteLength, target };
  binParts.push({ data });
  byteOffset += data.byteLength;
  return view;
}

parts.forEach((part, i) => {
  const mesh = buildBoxMesh(part.color);
  const posData = new Float32Array(mesh.positions);
  const norData = new Float32Array(mesh.normals);
  const colData = new Float32Array(mesh.colors);
  const idxData = new Uint16Array(mesh.indices);

  const posView = addView(posData, 34962);
  const norView = addView(norData, 34962);
  const colView = addView(colData, 34962);
  const idxView = addView(idxData, 34963);

  const posAcc = {
    bufferView: bufferViews.length,
    componentType: 5126,
    count: 24,
    type: 'VEC3',
    min: [-0.5, -0.5, -0.5],
    max: [0.5, 0.5, 0.5],
  };
  accessors.push(posAcc);
  const norAcc = { bufferView: bufferViews.length + 1, componentType: 5126, count: 24, type: 'VEC3' };
  accessors.push(norAcc);
  const colAcc = { bufferView: bufferViews.length + 2, componentType: 5126, count: 24, type: 'VEC3' };
  accessors.push(colAcc);
  const idxAcc = { bufferView: bufferViews.length + 3, componentType: 5123, count: 36, type: 'SCALAR' };
  accessors.push(idxAcc);

  bufferViews.push(posView, norView, colView, idxView);

  const meshIdx = meshes.length;
  meshes.push({
    primitives: [
      {
        attributes: { POSITION: accessors.length - 4, NORMAL: accessors.length - 3, COLOR_0: accessors.length - 2 },
        indices: accessors.length - 1,
        material: 0,
      },
    ],
  });

  nodes.push({
    name: part.name,
    mesh: meshIdx,
    translation: part.pos,
    scale: part.scale,
  });
});

// single shared material, double-sided so winding errors are invisible
const materials = [
  { pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.9 }, doubleSided: true },
];

const binLen = binParts.reduce((sum, p) => sum + (p.data ? p.data.byteLength : p.pad), 0);
const bin = Buffer.alloc(binLen);
let w = 0;
for (const p of binParts) {
  if (p.data) {
    Buffer.from(p.data.buffer, p.data.byteOffset, p.data.byteLength).copy(bin, w);
    w += p.data.byteLength;
  } else {
    w += p.pad; // zero padding
  }
}

const gltf = {
  asset: { version: '2.0', generator: 'petric-make-test-model' },
  scene: 0,
  scenes: [{ nodes: nodes.map((_, i) => i) }],
  nodes,
  meshes,
  materials,
  buffers: [{ byteLength: bin.length }],
  bufferViews,
  accessors,
};

// ---- pack GLB ----
// Per the glTF spec, chunk data must be padded with trailing SPACES (0x20), not nulls,
// so JSON.parse on the JSON chunk does not choke.
const jsonBuf = Buffer.from(JSON.stringify(gltf));
const jsonPadded = Buffer.alloc((jsonBuf.length + 3) & ~3, 0x20);
jsonBuf.copy(jsonPadded);

function chunk(type, data) {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(data.length, 0);
  header.write(type, 4, 'ascii');
  return Buffer.concat([header, data]);
}

const jsonChunk = chunk('JSON', jsonPadded);
const binChunk = chunk('BIN\0', bin);
const glb = Buffer.alloc(12);
glb.write('glTF', 0, 'ascii');
glb.writeUInt32LE(2, 4);
glb.writeUInt32LE(12 + jsonChunk.length + binChunk.length, 8);

const out = join(OUT_DIR, 'test-pet.glb');
writeFileSync(out, Buffer.concat([glb, jsonChunk, binChunk]));
console.log(`✓ test-pet.glb (${Buffer.concat([glb, jsonChunk, binChunk]).length} bytes, ${nodes.length} parts)`);
