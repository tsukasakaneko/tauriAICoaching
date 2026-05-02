'use strict';

const { detectObjects } = require('./yoloInference');

const KILLFEED_CLASSES = ['kill_entry', 'own_kill', 'own_death', 'headshot_icon', 'ability_icon'];

// Tracks accumulated stats across calls
class KillfeedStats {
  constructor() {
    this.kills = 0;
    this.deaths = 0;
    this.headshotKills = 0;
    this.abilityKills = 0;
    this._lastDetectedKill = false;
    this._lastDetectedDeath = false;
  }

  async processFrame(imageBuf) {
    const detections = await detectObjects(imageBuf, 'valorant_killfeed', KILLFEED_CLASSES);

    const hasOwnKill = detections.some(d => d.class === 'own_kill');
    const hasOwnDeath = detections.some(d => d.class === 'own_death');
    const hasHeadshot = detections.some(d => d.class === 'headshot_icon');
    const hasAbility = detections.some(d => d.class === 'ability_icon');

    // Rising edge detection — only count when newly appearing
    if (hasOwnKill && !this._lastDetectedKill) {
      this.kills++;
      if (hasHeadshot) this.headshotKills++;
      if (hasAbility) this.abilityKills++;
    }
    if (hasOwnDeath && !this._lastDetectedDeath) {
      this.deaths++;
    }

    this._lastDetectedKill = hasOwnKill;
    this._lastDetectedDeath = hasOwnDeath;
  }

  toResult() {
    return {
      kills: this.kills,
      deaths: this.deaths,
      headshotKills: this.headshotKills,
      abilityKills: this.abilityKills,
      headshotRate: this.kills > 0 ? this.headshotKills / this.kills : 0,
    };
  }
}

module.exports = { KillfeedStats };
