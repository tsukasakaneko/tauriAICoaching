'use strict';

const EventEmitter = require('events');
const { takeScreenshot } = require('./screenCapture');
const { classifyScreen } = require('./yoloInference');

const POLL_INTERVAL_MS = 1000;
const CONFIDENCE_THRESHOLD = 0.75;

// Valid state machine transitions
const TRANSITIONS = {
  idle:           ['queue_wait'],
  queue_wait:     ['agent_select', 'idle'],
  agent_select:   ['in_match', 'idle'],
  in_match:       ['result_screen', 'idle'],
  result_screen:  ['idle'],
  unknown:        ['idle', 'queue_wait', 'agent_select', 'in_match', 'result_screen'],
};

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
      const buf = await takeScreenshot();
      const { state, confidence } = await classifyScreen(buf);

      if (confidence < CONFIDENCE_THRESHOLD && state !== 'idle') return;

      const allowed = TRANSITIONS[this._state] || [];
      if (state !== this._state && (allowed.includes(state) || state === 'idle')) {
        this._setState(state);
      }
    } catch (err) {
      // Emit non-fatal errors as 'monitorError' to avoid crashing the app
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
