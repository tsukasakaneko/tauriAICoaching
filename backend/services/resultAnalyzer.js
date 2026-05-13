'use strict';

// Extract match stats from a result screen using full-resolution Tesseract OCR.
// Avoiding downscale-to-640 keeps scoreboard text at readable size (≥20 px).
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

  const sharp = require('sharp');
  const Tesseract = require('tesseract.js');

  const { width: W, height: H } = await sharp(imageBuf).metadata();

  // Valorant scoreboard occupies roughly the centre 70% of the screen,
  // starting ~15% from the top. Crop to avoid HUD chrome.
  const roiBuf = await sharp(imageBuf)
    .extract({
      left:   Math.floor(W * 0.15),
      top:    Math.floor(H * 0.15),
      width:  Math.floor(W * 0.70),
      height: Math.floor(H * 0.75),
    })
    .grayscale()
    .normalize()
    .toBuffer();

  const { data: { text } } = await Tesseract.recognize(roiBuf, 'eng', {
    tessedit_char_whitelist: '0123456789KDAkda/.% ',
  });

  return parseScoreboardText(text);
}

// Extract K/D/A, damage and headshot rate from OCR text.
// Valorant result screen shows a row like "8 / 5 / 3" for KDA.
function parseScoreboardText(text) {
  const nums = (str) => (str.match(/\d+/g) || []).map(Number);

  // K / D / A pattern: three numbers separated by slashes or spaces
  const kdaMatch = text.match(/(\d+)\s*[\/\s]\s*(\d+)\s*[\/\s]\s*(\d+)/);
  const kills    = kdaMatch ? Number(kdaMatch[1]) : 0;
  const deaths   = kdaMatch ? Number(kdaMatch[2]) : 0;
  const assists  = kdaMatch ? Number(kdaMatch[3]) : 0;

  // Damage: largest standalone number that isn't K/D/A-range (>200 threshold)
  const allNums    = nums(text);
  const damageDealt = allNums.find(n => n > 200) ?? 0;

  // Headshot rate: a number followed by % (0–100)
  const hsMatch    = text.match(/(\d{1,3})\s*%/);
  const headshotRate = hsMatch ? Number(hsMatch[1]) / 100 : 0;

  return {
    kills,
    deaths,
    assists,
    damageDealt,
    headshotRate,
    totalRounds: null,
    wonRounds:   null,
  };
}

module.exports = { analyzeResultScreen };
