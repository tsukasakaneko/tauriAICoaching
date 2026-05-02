'use strict';

const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { KillfeedStats } = require('./killfeedAnalyzer');
const { MinimapAnalyzer } = require('./minimapAnalyzer');
const { analyzeResultScreen } = require('./resultAnalyzer');

function getFfmpegPath() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

// Extract frames at a given interval (seconds) from a video file
function extractFrames(videoPath, outputDir, intervalSecs) {
  return new Promise((resolve, reject) => {
    const pattern = path.join(outputDir, 'frame_%05d.jpg');
    const ffmpeg = getFfmpegPath();
    const cmd = `"${ffmpeg}" -i "${videoPath}" -vf "fps=1/${intervalSecs}" -q:v 3 "${pattern}"`;
    exec(cmd, (err) => {
      if (err) {
        reject(new Error(`フレーム抽出失敗: ${err.message}`));
        return;
      }
      const frames = fs.readdirSync(outputDir)
        .filter(f => f.endsWith('.jpg'))
        .sort()
        .map(f => path.join(outputDir, f));
      resolve(frames);
    });
  });
}

// Analyze a recorded match video and return VideoAnalysisResult
async function analyzeVideo(videoPath, onProgress) {
  if (!fs.existsSync(videoPath) && (process.env.SIMULATE_GAME || process.env.SIMULATE_YOLO === 'true')) {
    // Stub: return realistic-looking fake data
    return buildStubResult();
  }

  const tmpDir = path.join(os.tmpdir(), `valo-frames-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    onProgress?.({ step: 'extracting_frames', progress: 0 });
    const allFrames = await extractFrames(videoPath, tmpDir, 3);

    onProgress?.({ step: 'killfeed_analysis', progress: 0.2 });
    const killfeedStats = new KillfeedStats();
    for (const framePath of allFrames) {
      const buf = fs.readFileSync(framePath);
      await killfeedStats.processFrame(buf);
    }

    onProgress?.({ step: 'minimap_analysis', progress: 0.5 });
    const minimapAnalyzer = new MinimapAnalyzer();
    // Sample every 5th frame for minimap (less frequent)
    for (let i = 0; i < allFrames.length; i += Math.max(1, Math.floor(5 / 3))) {
      const buf = fs.readFileSync(allFrames[i]);
      await minimapAnalyzer.processFrame(buf);
    }

    onProgress?.({ step: 'result_screen_ocr', progress: 0.8 });
    // Use last frame (most likely to be result screen)
    const lastFrame = allFrames[allFrames.length - 1];
    let resultStats = null;
    if (lastFrame) {
      resultStats = await analyzeResultScreen(fs.readFileSync(lastFrame));
    }

    onProgress?.({ step: 'complete', progress: 1.0 });

    const kfResult = killfeedStats.toResult();
    const mmResult = minimapAnalyzer.toResult();

    // Merge: prefer OCR result screen stats when available
    return {
      kills: resultStats?.kills ?? kfResult.kills,
      deaths: resultStats?.deaths ?? kfResult.deaths,
      assists: resultStats?.assists ?? 0,
      headshotRate: resultStats?.headshotRate ?? kfResult.headshotRate,
      damageDealt: resultStats?.damageDealt ?? null,
      abilityKills: kfResult.abilityKills,
      dominantZone: mmResult.dominantZone,
      aggressiveness: mmResult.aggressiveness,
      positionVariety: mmResult.positionVariety,
      deathsInLateRound: estimateLateRoundDeaths(kfResult.deaths),
      longestLoseStreak: null,
      totalRounds: resultStats?.totalRounds ?? null,
      wonRounds: resultStats?.wonRounds ?? null,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function estimateLateRoundDeaths(totalDeaths) {
  // Rough estimate: ~40% of deaths happen in late-round situations
  return Math.round(totalDeaths * 0.4);
}

function buildStubResult() {
  return {
    kills: 8,
    deaths: 5,
    assists: 3,
    headshotRate: 0.42,
    damageDealt: 1850,
    abilityKills: 2,
    dominantZone: 'mid',
    aggressiveness: 0.65,
    positionVariety: 'medium',
    deathsInLateRound: 3,
    longestLoseStreak: 4,
    totalRounds: 24,
    wonRounds: 13,
  };
}

module.exports = { analyzeVideo };
