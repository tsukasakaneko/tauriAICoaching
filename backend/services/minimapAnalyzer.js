'use strict';

const { detectObjects } = require('./yoloInference');

const MINIMAP_CLASSES = ['minimap_region', 'player_dot', 'enemy_dot'];

// ドット中心を minimap_region bbox 内の 0-1 座標に正規化する(マップ座標)。
// 領域サイズが不正なら null(呼び出し側は未補正座標にフォールバック)。
function normalizeDotInRegion(dotBbox, regionBbox) {
  const [rx, ry, rw, rh] = regionBbox;
  if (!(rw > 0) || !(rh > 0)) return null;
  const cx = dotBbox[0] + dotBbox[2] / 2;
  const cy = dotBbox[1] + dotBbox[3] / 2;
  return {
    x: Math.min(1, Math.max(0, (cx - rx) / rw)),
    y: Math.min(1, Math.max(0, (cy - ry) / rh)),
  };
}

class MinimapAnalyzer {
  constructor() {
    // [{frameIdx, x, y, cal}] — x/y はフレーム全体の 0-1(ゾーン判定用)、
    // cal はミニマップ領域内で正規化したマップ座標(検出できた時のみ)
    this._positions = [];
  }

  async processFrame(imageBuf, frameIdx = 0) {
    const detections = await detectObjects(imageBuf, 'valorant_minimap', MINIMAP_CLASSES);
    const playerDot = detections.find(d => d.class === 'player_dot');
    const region = detections.find(d => d.class === 'minimap_region');

    if (playerDot) {
      const [x, y, w, h] = playerDot.bbox;
      this._positions.push({
        frameIdx,
        x: (x + w / 2) / 640,  // normalize to 0-1 (YOLO 640px crop space)
        y: (y + h / 2) / 640,
        cal: region ? normalizeDotInRegion(playerDot.bbox, region.bbox) : null,
      });
    }
  }

  // Per-frame self position events for the timeline log.
  // calibrated=true の x/y はマップ座標(デスヒートマップ等の可視化に使える)。
  getEvents() {
    return this._positions.map(p => ({
      frameIdx: p.frameIdx,
      type: 'position',
      payload: p.cal
        ? { x: p.cal.x, y: p.cal.y, calibrated: true }
        : { x: p.x, y: p.y, calibrated: false },
    }));
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

module.exports = { MinimapAnalyzer, normalizeDotInRegion };
