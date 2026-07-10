'use strict';

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

function getFfmpegPath() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

function buildFfmpegArgs(outputPath) {
  const platform = process.platform;
  if (platform === 'win32') {
    return [
      '-f', 'gdigrab', '-framerate', '15', '-i', 'desktop',
      '-vf', 'scale=1280:720',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
      '-an', '-y', outputPath,
    ];
  }
  // Linux (dev environment)
  const display = process.env.DISPLAY || ':0';
  return [
    '-f', 'x11grab', '-framerate', '15', '-i', `${display}+0,0`,
    '-s', '1280x720',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
    '-an', '-y', outputPath,
  ];
}

class ScreenRecorder {
  constructor() {
    this._process = null;
    this._outputPath = null;
    this.isRecording = false;
    this.startedAtMs = null;
  }

  start(userId = 'anon') {
    // Early return keeps the original startedAtMs — correct for the shared recording
    if (this.isRecording) return this._outputPath;

    const dataDir = path.join(os.homedir(), '.local', 'share', 'valorant-ai-coaching');
    fs.mkdirSync(dataDir, { recursive: true });
    this.startedAtMs = Date.now();
    this._outputPath = path.join(dataDir, `match_${userId}_${this.startedAtMs}.mp4`);

    if (process.env.SIMULATE_GAME || process.env.SIMULATE_YOLO === 'true') {
      // Stub mode — don't spawn ffmpeg
      this.isRecording = true;
      console.log(`[recorder] STUB: recording to ${this._outputPath}`);
      return this._outputPath;
    }

    const ffmpeg = getFfmpegPath();
    const args = buildFfmpegArgs(this._outputPath);
    this._process = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    this.isRecording = true;

    this._process.on('error', (err) => {
      this.isRecording = false;
      if (err.code === 'ENOENT') {
        this.emit?.('error', 'ffmpegが見つかりません。アプリを再インストールしてください。');
      }
    });

    this._process.on('exit', () => {
      this.isRecording = false;
    });

    console.log(`[recorder] started → ${this._outputPath}`);
    return this._outputPath;
  }

  stop() {
    return new Promise((resolve) => {
      const out = this._outputPath;
      if (!this.isRecording) {
        resolve(out);
        return;
      }

      if (!this._process) {
        // Stub mode
        this.isRecording = false;
        resolve(out);
        return;
      }

      // Force-kill timer — cleared if process exits gracefully first
      const forceKillTimer = setTimeout(() => {
        if (this._process) this._process.kill('SIGKILL');
      }, 8000);

      this._process.once('exit', () => {
        clearTimeout(forceKillTimer);
        this.isRecording = false;
        this._process = null;
        resolve(out);
      });

      // Ask ffmpeg to stop gracefully by writing 'q' to stdin
      try {
        this._process.stdin.write('q');
        this._process.stdin.end();
      } catch {
        this._process.kill('SIGTERM');
      }
    });
  }
}

module.exports = new ScreenRecorder();
