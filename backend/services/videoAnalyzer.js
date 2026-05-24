'use strict';

const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { KillfeedStats } = require('./killfeedAnalyzer');
const { MinimapAnalyzer } = require('./minimapAnalyzer');
const { analyzeResultScreen } = require('./resultAnalyzer');
const { detectMap } = require('./mapDetector');

// Frame sampling interval in seconds. 0.5 = 2fps timeline resolution.
const INTERVAL_SECS = 0.5;
// Number of opening frames used for the map-detection majority vote.
const MAP_DETECT_FRAMES = 30;

function getFfmpegPath() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

// Remove leftover frame-extraction temp dirs from crashed/killed runs.
function sweepOrphanFrames() {
  const tmp = os.tmpdir();
  let removed = 0;
  for (const name of fs.readdirSync(tmp)) {
    if (name.startsWith('valo-frames-')) {
      try {
        fs.rmSync(path.join(tmp, name), { recursive: true, force: true });
        removed++;
      } catch { /* best-effort */ }
    }
  }
  return removed;
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

// Analyze a recorded match video.
// Returns { result: VideoAnalysisResult, events: MatchEvent[], meta: { mapName } }
//   - result: aggregate stats (unchanged shape; persisted as video_analysis_json)
//   - events: per-frame timeline ({ frameIdx, tMs, type, payload }) for match_events
//   - meta:   { mapName } for match_meta
// The caller persists events/meta per session (one analysis fans out to many sessions).
async function analyzeVideo(videoPath, onProgress) {
  if (!fs.existsSync(videoPath) && (process.env.SIMULATE_GAME || process.env.SIMULATE_YOLO === 'true')) {
    // Stub: return realistic-looking fake data
    return { result: buildStubResult(), events: [], meta: { mapName: null } };
  }

  const tmpDir = path.join(os.tmpdir(), `valo-frames-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    onProgress?.({ step: 'extracting_frames', progress: 0 });
    const allFrames = await extractFrames(videoPath, tmpDir, INTERVAL_SECS);

    onProgress?.({ step: 'map_detection', progress: 0.1 });
    const openingBuffers = allFrames.slice(0, MAP_DETECT_FRAMES).map(f => fs.readFileSync(f));
    const mapName = await detectMap(openingBuffers, MAP_DETECT_FRAMES);

    onProgress?.({ step: 'frame_analysis', progress: 0.2 });
    const killfeedStats = new KillfeedStats();
    const minimapAnalyzer = new MinimapAnalyzer();
    for (let i = 0; i < allFrames.length; i++) {
      const buf = fs.readFileSync(allFrames[i]);
      await killfeedStats.processFrame(buf, i);
      await minimapAnalyzer.processFrame(buf, i);
      if (i % 100 === 0 && allFrames.length > 0) {
        onProgress?.({ step: 'frame_analysis', progress: 0.2 + 0.6 * (i / allFrames.length) });
      }
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

    // Build the per-frame timeline, stamping each event with t_ms.
    const events = [...minimapAnalyzer.getEvents(), ...killfeedStats.getEvents()]
      .map(e => ({ ...e, tMs: Math.round(e.frameIdx * INTERVAL_SECS * 1000) }))
      .sort((a, b) => a.frameIdx - b.frameIdx);

    // Merge: prefer OCR result screen stats when available
    const result = {
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

    return { result, events, meta: { mapName } };
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

module.exports = { analyzeVideo, sweepOrphanFrames };
