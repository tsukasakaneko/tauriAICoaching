'use strict';

const EventEmitter = require('events');
const riotLocalApi = require('./riotLocalApi');

// Riot ローカル API の presence をポーリングして試合ライフサイクルを検知する。
// screenMonitor と同一のイベント API(stateChanged / matchStarted /
// resultScreenDetected / gameExited / monitorError)を持つ差し替え可能な実装。
// YOLO モデル・画面キャプチャ不要で、VALORANT が起動していれば動作する。

const POLL_INTERVAL_MS = parseInt(process.env.RIOT_POLL_INTERVAL_MS ?? '4000', 10);

class RiotMonitor extends EventEmitter {
  constructor() {
    super();
    this._state = 'idle';
    this._intervalId = null;
    this._running = false;
    this._ticking = false;
    this._matchStartedAtMillis = null;
  }

  get state() { return this._state; }
  get isRunning() { return this._running; }
  /** in_match 突入時刻。riotMatchData の sinceMillis に使う */
  get matchStartedAtMillis() { return this._matchStartedAtMillis; }

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
    if (!this._running || this._ticking) return;
    this._ticking = true;
    try {
      const presence = await riotLocalApi.getPresence();
      const next = this._mapPresenceToState(presence);
      if (next !== this._state) this._setState(next);
    } catch (err) {
      this.emit('monitorError', err.message);
    } finally {
      this._ticking = false;
    }
  }

  /**
   * presence の sessionLoopState → monitor state。
   * INGAME → MENUS の遷移は result_screen を経由させて既存の解析フローを起動する。
   */
  _mapPresenceToState(presence) {
    if (!presence) return 'idle'; // VALORANT 未起動/クライアント終了

    switch (presence.sessionLoopState) {
      case 'PREGAME':
        return 'agent_select';
      case 'INGAME':
        return 'in_match';
      case 'MENUS':
        // 試合中からメニューに戻った = 試合終了
        if (this._state === 'in_match') return 'result_screen';
        if (this._state === 'result_screen') return 'idle';
        return 'queue_wait'; // VALORANT 起動中・待機
      default:
        return this._state; // 未知の loop state は現状維持
    }
  }

  _setState(newState) {
    const prev = this._state;
    this._state = newState;
    this.emit('stateChanged', newState, prev);

    if (newState === 'in_match') {
      this._matchStartedAtMillis = Date.now();
      this.emit('matchStarted');
    }
    if (newState === 'result_screen') this.emit('resultScreenDetected');
    if (newState === 'idle' && (prev === 'in_match' || prev === 'result_screen')) {
      this.emit('gameExited');
    }
  }
}

// Singleton — one monitor per process
module.exports = new RiotMonitor();
