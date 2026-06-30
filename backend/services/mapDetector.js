'use strict';

const { classifyImage } = require('./yoloInference');

// Current competitive map pool. TODO: confirm rotation with the user before
// collecting the training set — the model's class order must match this list.
const MAPS = ['bind', 'ascent', 'haven', 'split', 'lotus', 'sunset', 'icebox', 'abyss'];

// valorant_map is a YOLOv8n-cls model; classifiers use a 224px square input.
const MAP_INPUT_SIZE = 224;
const MIN_CONFIDENCE = 0.5;

// Detect the map from the opening frames by majority vote.
// frameBuffers: array of JPEG/PNG buffers (chronological). Returns map name or null
// (null when the model is absent or no class clears the confidence/vote bar).
async function detectMap(frameBuffers, sampleCount = 30) {
  const sample = frameBuffers.slice(0, sampleCount);
  const votes = new Map();

  for (const buf of sample) {
    const { label, confidence } = await classifyImage(buf, 'valorant_map', MAPS, MAP_INPUT_SIZE);
    if (label && confidence >= MIN_CONFIDENCE) {
      votes.set(label, (votes.get(label) || 0) + 1);
    }
  }

  let best = null;
  let bestVotes = 0;
  for (const [map, count] of votes) {
    if (count > bestVotes) {
      best = map;
      bestVotes = count;
    }
  }
  return best;
}

module.exports = { detectMap, MAPS };
