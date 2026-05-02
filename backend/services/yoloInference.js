'use strict';

const path = require('path');
const fs = require('fs');

let ort = null;
let sharp = null;

// Lazy-load heavy dependencies to keep startup fast
function getOrt() {
  if (!ort) ort = require('onnxruntime-node');
  return ort;
}

function getSharp() {
  if (!sharp) sharp = require('sharp');
  return sharp;
}

const MODEL_INPUT_SIZE = 640;

// Map of model name → loaded InferenceSession
const sessions = new Map();

async function loadModel(modelName) {
  if (sessions.has(modelName)) return sessions.get(modelName);

  const modelsDir = process.env.MODELS_DIR ||
    path.join(__dirname, '..', '..', 'src-tauri', 'resources', 'models');
  const modelPath = path.join(modelsDir, `${modelName}.onnx`);

  if (!fs.existsSync(modelPath)) {
    // Return null when model file is absent — callers fall back to stubs
    return null;
  }

  const session = await getOrt().InferenceSession.create(modelPath);
  sessions.set(modelName, session);
  return session;
}

// Preprocess an image buffer to Float32 tensor [1, 3, 640, 640]
async function preprocessImage(imageBuf, width = MODEL_INPUT_SIZE, height = MODEL_INPUT_SIZE) {
  const sharp = getSharp();
  const { data } = await sharp(imageBuf)
    .resize(width, height)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const tensor = new Float32Array(3 * height * width);
  for (let i = 0; i < height * width; i++) {
    tensor[i] = data[i * 3] / 255.0;
    tensor[height * width + i] = data[i * 3 + 1] / 255.0;
    tensor[2 * height * width + i] = data[i * 3 + 2] / 255.0;
  }
  return tensor;
}

// Classify a screen state using valorant_state model
// Returns: { state: string, confidence: number }
async function classifyScreen(imageBuf) {
  if (process.env.SIMULATE_YOLO === 'true') {
    return simulateScreenState();
  }

  const session = await loadModel('valorant_state');
  if (!session) {
    // Model absent — use process-based detection as fallback
    return { state: 'unknown', confidence: 0 };
  }

  const tensor = await preprocessImage(imageBuf);
  const input = new getOrt().Tensor('float32', tensor, [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE]);
  const output = await session.run({ images: input });

  const probs = Array.from(output[Object.keys(output)[0]].data);
  const classes = ['idle', 'queue_wait', 'agent_select', 'in_match', 'result_screen'];
  const maxIdx = probs.indexOf(Math.max(...probs));

  return { state: classes[maxIdx] || 'unknown', confidence: probs[maxIdx] };
}

// Detect objects in a frame using a named model
// Returns: Array<{ class: string, confidence: number, bbox: [x,y,w,h] }>
async function detectObjects(imageBuf, modelName, classes) {
  if (process.env.SIMULATE_YOLO === 'true') {
    return simulateDetections(modelName);
  }

  const session = await loadModel(modelName);
  if (!session) return [];

  const tensor = await preprocessImage(imageBuf);
  const input = new getOrt().Tensor('float32', tensor, [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE]);
  const output = await session.run({ images: input });

  return parseDetections(output, classes, 0.45);
}

// Parse YOLOv8 detection output (raw boxes + confidence) with NMS
function parseDetections(output, classes, threshold) {
  const key = Object.keys(output)[0];
  const raw = output[key].data;
  const numDetections = raw.length / (4 + classes.length);

  const boxes = [];
  for (let i = 0; i < numDetections; i++) {
    const offset = i * (4 + classes.length);
    const x = raw[offset];
    const y = raw[offset + 1];
    const w = raw[offset + 2];
    const h = raw[offset + 3];

    let maxConf = 0;
    let maxClass = 0;
    for (let c = 0; c < classes.length; c++) {
      if (raw[offset + 4 + c] > maxConf) {
        maxConf = raw[offset + 4 + c];
        maxClass = c;
      }
    }

    if (maxConf >= threshold) {
      boxes.push({ class: classes[maxClass], confidence: maxConf, bbox: [x, y, w, h] });
    }
  }

  // Simple NMS by class
  return nonMaxSuppression(boxes, 0.5);
}

function nonMaxSuppression(boxes, iouThreshold) {
  boxes.sort((a, b) => b.confidence - a.confidence);
  const kept = [];
  for (const box of boxes) {
    const overlap = kept.some(k => k.class === box.class && iou(k.bbox, box.bbox) > iouThreshold);
    if (!overlap) kept.push(box);
  }
  return kept;
}

function iou([x1, y1, w1, h1], [x2, y2, w2, h2]) {
  const ix = Math.max(0, Math.min(x1 + w1, x2 + w2) - Math.max(x1, x2));
  const iy = Math.max(0, Math.min(y1 + h1, y2 + h2) - Math.max(y1, y2));
  const inter = ix * iy;
  return inter / (w1 * h1 + w2 * h2 - inter);
}

// ─── Development stubs ───────────────────────────────────────────────────────

let _simulatedState = 'idle';
let _stateChangedAt = Date.now();

function simulateScreenState() {
  const elapsed = (Date.now() - _stateChangedAt) / 1000;
  const envState = process.env.SIMULATE_GAME;

  if (envState) {
    return { state: envState, confidence: 0.99 };
  }

  // Auto-cycle for testing without env var
  if (elapsed > 8 && _simulatedState === 'idle') {
    _simulatedState = 'queue_wait'; _stateChangedAt = Date.now();
  } else if (elapsed > 5 && _simulatedState === 'queue_wait') {
    _simulatedState = 'in_match'; _stateChangedAt = Date.now();
  } else if (elapsed > 30 && _simulatedState === 'in_match') {
    _simulatedState = 'result_screen'; _stateChangedAt = Date.now();
  } else if (elapsed > 5 && _simulatedState === 'result_screen') {
    _simulatedState = 'idle'; _stateChangedAt = Date.now();
  }

  return { state: _simulatedState, confidence: 0.95 };
}

function simulateDetections(modelName) {
  if (modelName === 'valorant_killfeed') {
    return Math.random() > 0.7
      ? [{ class: 'own_kill', confidence: 0.92, bbox: [1700, 50, 200, 30] }]
      : [];
  }
  if (modelName === 'valorant_minimap') {
    return [{ class: 'player_dot', confidence: 0.95, bbox: [50 + Math.random() * 150, 50 + Math.random() * 150, 8, 8] }];
  }
  return [];
}

module.exports = { classifyScreen, detectObjects, loadModel };
