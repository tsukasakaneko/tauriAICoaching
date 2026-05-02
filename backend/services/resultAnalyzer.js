'use strict';

const { detectObjects } = require('./yoloInference');

const RESULT_CLASSES = ['scoreboard_row', 'kda_cell', 'damage_cell', 'hs_cell'];

// Extract match stats from a result screen frame using YOLOv8 + OCR
async function analyzeResultScreen(imageBuf) {
  if (process.env.SIMULATE_GAME || process.env.SIMULATE_YOLO === 'true') {
    return {
      kills: 8,
      deaths: 5,
      assists: 3,
      damageDealt: 1850,
      headshotRate: 0.42,
      totalRounds: 24,
      wonRounds: 13,
    };
  }

  // Detect regions on the result screen
  const detections = await detectObjects(imageBuf, 'valorant_result', RESULT_CLASSES);

  if (detections.length === 0) {
    return null;
  }

  // OCR the detected cell regions
  const sharp = require('sharp');
  const Tesseract = require('tesseract.js');
  const results = {};

  for (const det of detections) {
    const [x, y, w, h] = det.bbox.map(Math.round);
    const cropped = await sharp(imageBuf)
      .extract({ left: x, top: y, width: Math.max(w, 1), height: Math.max(h, 1) })
      .grayscale()
      .normalize()
      .toBuffer();

    const { data: { text } } = await Tesseract.recognize(cropped, 'eng');
    const nums = text.match(/\d+/g)?.map(Number) || [];

    if (det.class === 'kda_cell' && nums.length >= 3) {
      results.kills = nums[0];
      results.deaths = nums[1];
      results.assists = nums[2];
    }
    if (det.class === 'damage_cell' && nums.length >= 1) {
      results.damageDealt = nums[0];
    }
    if (det.class === 'hs_cell' && nums.length >= 1) {
      results.headshotRate = nums[0] / 100;
    }
  }

  return {
    kills: results.kills || 0,
    deaths: results.deaths || 0,
    assists: results.assists || 0,
    damageDealt: results.damageDealt || 0,
    headshotRate: results.headshotRate || 0,
    totalRounds: null,
    wonRounds: null,
  };
}

module.exports = { analyzeResultScreen };
