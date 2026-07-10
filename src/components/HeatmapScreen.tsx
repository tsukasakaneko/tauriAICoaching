import { useEffect, useRef, useState } from "react";
import type { DeathHeatmapResponse, HeatmapMapEntry } from "../types";
import { api } from "../api";

interface Props {
  onBack: () => void;
}

const CANVAS_SIZE = 512;
const BLOB_RADIUS = 30; // 約6% — 重なりで密度が見えるサイズ

function drawHeatmap(
  canvas: HTMLCanvasElement,
  data: DeathHeatmapResponse,
  imgFailed: boolean
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

  if (imgFailed) {
    // マップ画像が取れない時のグリッド背景フォールバック
    ctx.fillStyle = "#10141a";
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 1;
    for (let i = 64; i < CANVAS_SIZE; i += 64) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, CANVAS_SIZE); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(CANVAS_SIZE, i); ctx.stroke();
    }
  }

  // 未補正(旧データ)の座標は画面全体基準でマップ上の位置と一致しないため描画しない
  const points = data.points.filter((p) => p.calibrated);

  // 加算合成 — 重なった場所ほど明るくなりホットスポットが浮かぶ
  ctx.globalCompositeOperation = "lighter";
  for (const p of points) {
    const cx = p.x * CANVAS_SIZE;
    const cy = p.y * CANVAS_SIZE;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, BLOB_RADIUS);
    g.addColorStop(0, "rgba(255,70,85,0.45)"); // VALORANT red
    g.addColorStop(1, "rgba(255,70,85,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, BLOB_RADIUS, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  for (const p of points) {
    ctx.beginPath();
    ctx.arc(p.x * CANVAS_SIZE, p.y * CANVAS_SIZE, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

export default function HeatmapScreen({ onBack }: Props) {
  const [maps, setMaps] = useState<HeatmapMapEntry[] | null>(null);
  const [selectedMap, setSelectedMap] = useState<string | null>(null);
  const [data, setData] = useState<DeathHeatmapResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [imgFailed, setImgFailed] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    api
      .getHeatmapMaps()
      .then(({ maps }) => {
        setMaps(maps);
        const first = maps.find((m) => m.deaths > 0) ?? maps[0];
        setSelectedMap(first?.map ?? null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedMap) return;
    setData(null);
    setImgFailed(false);
    api
      .getHeatmapDeaths(selectedMap)
      .then(setData)
      .catch((err: Error) => setError(err.message));
  }, [selectedMap]);

  useEffect(() => {
    if (canvasRef.current && data) drawHeatmap(canvasRef.current, data, imgFailed);
  }, [data, imgFailed]);

  const calibrated = data?.calibratedDeaths ?? 0;
  const uncalibrated = data ? data.matchedDeaths - data.calibratedDeaths : 0;

  return (
    <div className="screen heatmap-screen">
      <div className="report-nav">
        <button className="back-btn" onClick={onBack}>
          ← 戻る
        </button>
        <div className="brand-small">
          <span className="brand-accent">CoachMate</span> for VALORANT
        </div>
      </div>

      <h1 className="report-title">デスマップ</h1>
      <p className="heatmap-subtitle">マップごとに、どこでよくデスしているかを全試合から集計します。</p>

      {loading && <p className="loading-text">読み込み中...</p>}
      {error && <p className="error-text">読み込みエラー: {error}</p>}

      {maps && maps.length === 0 && (
        <p className="no-events-msg">
          デスデータはまだありません。自動録画で試合を分析すると蓄積されます。
        </p>
      )}

      {maps && maps.length > 0 && (
        <>
          <div className="map-tab-row">
            {maps.map((m) => (
              <button
                key={m.map}
                className={`map-tab${m.map === selectedMap ? " active" : ""}`}
                onClick={() => setSelectedMap(m.map)}
              >
                {m.map} ({m.deaths})
              </button>
            ))}
          </div>

          {data && (
            <section className="report-section">
              <div className="heatmap-canvas-wrap">
                {!imgFailed && (
                  <img
                    className="heatmap-map-img"
                    src={api.getMapMinimapUrl(data.map)}
                    alt={`${data.map} ミニマップ`}
                    onError={() => setImgFailed(true)}
                  />
                )}
                <canvas
                  ref={canvasRef}
                  className="heatmap-canvas"
                  width={CANVAS_SIZE}
                  height={CANVAS_SIZE}
                />
              </div>

              {calibrated === 0 ? (
                <p className="no-events-msg">このマップの表示可能なデスデータはありません。</p>
              ) : (
                <p className="heatmap-note">
                  {data.sessions}試合 / {data.totalDeaths}デス中{data.matchedDeaths}件の位置を推定
                </p>
              )}
              {uncalibrated > 0 && (
                <p className="heatmap-note">
                  位置補正前の旧データ {uncalibrated} 件は表示対象外です。
                </p>
              )}
              <p className="heatmap-note heatmap-disclaimer">
                位置は録画解析による推定です。ミニマップを回転/中心固定にしている場合はずれることがあります。
              </p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
