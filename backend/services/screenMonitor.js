'use strict';

const EventEmitter = require('events');
const { exec } = require('child_process');
const { promisify } = require('util');
const { takeScreenshot } = require('./screenCapture');

const execAsync = promisify(exec);
const POLL_INTERVAL_MS = 1000;

// Valid state machine transitions
const TRANSITIONS = {
  idle:           ['queue_wait'],
  queue_wait:     ['agent_select', 'idle'],
  agent_select:   ['in_match', 'idle'],
  in_match:       ['result_screen', 'idle'],
  result_screen:  ['idle'],
  unknown:        ['idle', 'queue_wait', 'agent_select', 'in_match', 'result_screen'],
};

async function isValorantRunning() {
  if (process.env.SIMULATE_GAME) return true;
  try {
    const { stdout } = await execAsync(
      process.platform === 'win32'
        ? 'tasklist /FI "IMAGENAME eq VALORANT-Win64-Shipping.exe" /NH'
        : 'pgrep -if valorant'
    );
    return /valorant/i.test(stdout);
  } catch {
    return false;
  }
}

// Classify game state from a screenshot using colour-region analysis (no ML).
// Valorant has distinctive colour signatures for each state:
//   result_screen — VICTORY (bright blue) or DEFEAT (bright red) banner fills top-centre
//   in_match      — minimap corner (bottom-left) is uniformly near-black
//   agent_select  — large colourful portrait grid; high centre saturation
//   queue_wait    — fallback for any other Valorant screen
async function classifyScreenshot(imageBuf) {
  if (process.env.SIMULATE_GAME) {
    return { state: process.env.SIMULATE_GAME, confidence: 0.99 };
  }

  const sharp = require('sharp');
  const { width: W, height: H } = await sharp(imageBuf).metadata();

  async function regionStats(left, top, width, height) {
    return sharp(imageBuf)
      .extract({
        left,
        top,
        width:  Math.max(1, Math.min(width,  W - left)),
        height: Math.max(1, Math.min(height, H - top)),
      })
      .stats();
  }

  // ── Result screen: VICTORY (blue) / DEFEAT (red) banner at top-centre ───────
  const topStats = await regionStats(
    Math.floor(W * 0.30), 0,
    Math.floor(W * 0.40), Math.floor(H * 0.12));
  const [rt, gt, bt] = topStats.channels.map(c => c.mean);
  if (bt > 130 && bt > rt * 1.35 && bt > gt * 1.1) {
    return { state: 'result_screen', confidence: 0.92 };
  }
  if (rt > 130 && rt > bt * 1.35 && rt > gt * 1.1) {
    return { state: 'result_screen', confidence: 0.92 };
  }

  // ── In-match: minimap occupies bottom-left ~17% × ~20%; background is black ─
  const mmStats = await regionStats(
    0, Math.floor(H * 0.78),
    Math.floor(W * 0.17), Math.floor(H * 0.20));
  const mmBrightness = mmStats.channels.reduce((s, c) => s + c.mean, 0) / 3;
  if (mmBrightness < 45) return { state: 'in_match', confidence: 0.88 };

  // ── Agent select: vibrant portrait grid fills most of the screen ─────────────
  const cStats = await regionStats(
    Math.floor(W * 0.15), Math.floor(H * 0.05),
    Math.floor(W * 0.70), Math.floor(H * 0.80));
  const [rc, gc, bc] = cStats.channels.map(c => c.mean);
  const sat = Math.max(rc, gc, bc) - Math.min(rc, gc, bc);
  if (sat > 35 && Math.max(rc, gc, bc) > 65) {
    return { state: 'agent_select', confidence: 0.75 };
  }

  return { state: 'queue_wait', confidence: 0.70 };
}

class ScreenMonitor extends EventEmitter {
  constructor() {
    super();
    this._state = 'idle';
    this._intervalId = null;
    this._running = false;
  }

  get state() { return this._state; }
  get isRunning() { return this._running; }

  start() {
    if (this._running) return;
    this._running = true;
    this._intervalId = setInterval(() => this._tick(), POLL_INTERVAL_MS);
  }

  stop() {
    this._running = false;
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    this._setState('idle');
  }

  async _tick() {
    if (!this._running) return;
    try {
      const isRunning = await isValorantRunning();
      if (!isRunning) {
        if (this._state !== 'idle') this._setState('idle');
        return;
      }

      const buf = await takeScreenshot();
      const { state } = await classifyScreenshot(buf);

      const allowed = TRANSITIONS[this._state] || [];
      if (state !== this._state && (allowed.includes(state) || state === 'idle')) {
        this._setState(state);
      }
    } catch (err) {
      this.emit('monitorError', err.message);
    }
  }

  _setState(newState) {
    const prev = this._state;
    this._state = newState;
    this.emit('stateChanged', newState, prev);

    if (newState === 'in_match')      this.emit('matchStarted');
    if (newState === 'result_screen') this.emit('resultScreenDetected');
    if (newState === 'idle' && (prev === 'in_match' || prev === 'result_screen')) {
      this.emit('gameExited');
    }
  }
}

// Singleton — one monitor per process
module.exports = new ScreenMonitor();
