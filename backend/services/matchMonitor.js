'use strict';

const EventEmitter = require('events');
const riotLockfile = require('./riotLockfile');
const riotMonitor = require('./riotMonitor');
const screenMonitor = require('./screenMonitor');

// 試合検知のファサード。start() 時に Riot ローカル API(lockfile があれば優先)か
// 従来の screenMonitor(YOLO/SIMULATE)を選び、同一イベントを転送する。
// autorecord.js はこのモジュールだけを参照する。

const FORWARDED_EVENTS = [
  'stateChanged',
  'matchStarted',
  'resultScreenDetected',
  'gameExited',
  'monitorError',
];

class MatchMonitor extends EventEmitter {
  constructor() {
    super();
    this._source = null;       // riotMonitor | screenMonitor
    this._sourceName = null;   // 'riot' | 'yolo' | null
    this._forwarders = new Map();
  }

  get state() { return this._source?.state ?? 'idle'; }
  get isRunning() { return this._source?.isRunning ?? false; }
  get activeSource() { return this._sourceName; }
  /** Riot 監視時のみ: in_match 突入時刻(riotMatchData の sinceMillis 用) */
  get matchStartedAtMillis() {
    return this._sourceName === 'riot' ? riotMonitor.matchStartedAtMillis : null;
  }

  start() {
    if (this._source?.isRunning) return;
    this._detach();

    const useRiot =
      process.env.RIOT_MONITOR !== 'off' && riotLockfile.isAvailable();
    this._source = useRiot ? riotMonitor : screenMonitor;
    this._sourceName = useRiot ? 'riot' : 'yolo';
    console.log(`[matchMonitor] source = ${this._sourceName}`);

    for (const eventName of FORWARDED_EVENTS) {
      const forwarder = (...args) => this.emit(eventName, ...args);
      this._forwarders.set(eventName, forwarder);
      this._source.on(eventName, forwarder);
    }
    this._source.start();
  }

  stop() {
    if (this._source) this._source.stop();
    this._detach();
  }

  _detach() {
    if (!this._source) return;
    for (const [eventName, forwarder] of this._forwarders) {
      this._source.removeListener(eventName, forwarder);
    }
    this._forwarders.clear();
    this._source = null;
    this._sourceName = null;
  }
}

// Singleton — one facade per process
module.exports = new MatchMonitor();
