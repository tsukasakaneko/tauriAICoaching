'use strict';

const { detectObjects } = require('./yoloInference');

const MINIMAP_CLASSES = ['minimap_region', 'player_dot', 'enemy_dot'];

class MinimapAnalyzer {
  constructor() {
    this._positions = [];  // [{x, y}] normalized 0-1
  }

  async processFrame(imageBuf) {
    const detections = await detectObjects(imageBuf, 'valorant_minimap', MINIMAP_CLASSES);
    const playerDot = detections.find(d => d.class === 'player_dot');

    if (playerDot) {
      const [x, y] = playerDot.bbox;
      this._positions.push({
        x: x / 640,
        y: y / 640,
      });
    }
  }

  toResult() {
    if (this._positions.length === 0) {
      return {
        dominantZone: 'unknown',
        aggressiveness: 0.5,
        positionVariety: 'medium',
      };
    }

    // Calculate movement range (std dev of positions)
    const xs = this._positions.map(p => p.x);
    const ys = this._positions.map(p => p.y);
    const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
    const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
    const variance = xs.reduce((acc, x, i) => {
      return acc + Math.pow(x - meanX, 2) + Math.pow(ys[i] - meanY, 2);
    }, 0) / this._positions.length;
    const stdDev = Math.sqrt(variance);

    // Map position to zone (simplified: left=attacking, right=defending, center=mid)
    const dominantZone = meanX < 0.4
      ? 'attacking_side'
      : meanX > 0.6
      ? 'defending_side'
      : 'mid';

    // Aggressiveness = how far from base (normalized 0-1)
    const aggressiveness = Math.min(1, meanX * 1.2);

    const positionVariety = stdDev < 0.1 ? 'low' : stdDev < 0.2 ? 'medium' : 'high';

    return { dominantZone, aggressiveness, positionVariety };
  }
}

module.exports = { MinimapAnalyzer };
