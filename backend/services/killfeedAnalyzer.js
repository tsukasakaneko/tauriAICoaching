'use strict';

// Valorant killfeed occupies the right ~28% × top ~30% of the screen.
// We detect kill/death events by monitoring pixel-level change in that ROI.
// A large enough frame-to-frame difference means a new entry appeared.
// The skull icon (own_death) has a distinctive red tint; kill entries are white/grey.

const DIFF_THRESHOLD = 12;   // mean absolute pixel diff to consider ROI "changed"
const RED_BIAS_THRESHOLD = 25; // red channel excess (R-B) indicating a death icon

class KillfeedStats {
  constructor() {
    this.kills = 0;
    this.deaths = 0;
    this.headshotKills = 0;
    this.abilityKills = 0;
    this._prevRoiBuf = null;
    this._prevHadChange = false;
  }

  async processFrame(imageBuf) {
    if (process.env.SIMULATE_YOLO === 'true') return;

    const sharp = require('sharp');
    const { width: W, height: H } = await sharp(imageBuf).metadata();

    // Extract killfeed ROI (top-right corner)
    const roiBuf = await sharp(imageBuf)
      .extract({
        left:   Math.floor(W * 0.72),
        top:    0,
        width:  Math.floor(W * 0.28),
        height: Math.floor(H * 0.30),
      })
      .grayscale()
      .raw()
      .toBuffer();

    if (!this._prevRoiBuf || this._prevRoiBuf.length !== roiBuf.length) {
      this._prevRoiBuf = roiBuf;
      return;
    }

    // Mean absolute difference between frames
    let diffSum = 0;
    for (let i = 0; i < roiBuf.length; i++) {
      diffSum += Math.abs(roiBuf[i] - this._prevRoiBuf[i]);
    }
    const meanDiff = diffSum / roiBuf.length;

    // Rising edge: only count when a new entry appears (not while it persists)
    const hasChange = meanDiff > DIFF_THRESHOLD;
    if (hasChange && !this._prevHadChange) {
      // Sample the ROI in colour to distinguish kill vs death
      const colorStats = await sharp(imageBuf)
        .extract({
          left:   Math.floor(W * 0.72),
          top:    0,
          width:  Math.floor(W * 0.28),
          height: Math.floor(H * 0.30),
        })
        .stats();
      const [rMean, , bMean] = colorStats.channels.map(c => c.mean);

      // Skull icon (own_death) pushes red channel noticeably above blue
      if (rMean - bMean > RED_BIAS_THRESHOLD) {
        this.deaths++;
      } else {
        this.kills++;
      }
    }

    this._prevHadChange = hasChange;
    this._prevRoiBuf = roiBuf;
  }

  toResult() {
    return {
      kills:         this.kills,
      deaths:        this.deaths,
      headshotKills: this.headshotKills,
      abilityKills:  this.abilityKills,
      headshotRate:  this.kills > 0 ? this.headshotKills / this.kills : 0,
    };
  }
}

module.exports = { KillfeedStats };
