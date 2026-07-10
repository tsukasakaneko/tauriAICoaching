import { useEffect, useMemo, useRef, useState } from "react";
import type { MatchEvent } from "../types";
import { formatMatchTime } from "../utils/timeline";

interface Props {
  events: MatchEvent[];
  mapName: string | null;
  /** time_refs チップ等からのシーク要求。参照が変わるたびに反映される */
  seekRequest?: { tMs: number } | null;
}

interface PositionPoint {
  tMs: number;
  x: number; // 0-1
  y: number; // 0-1
}

interface EventMark {
  id: number;
  tMs: number;
  type: "kill" | "death";
  x: number;
  y: number;
}

const VIEW = 100; // SVG viewBox の一辺
const TICK_MS = 100; // 再生タイマー刻み
const SPEEDS = [1, 4, 16];
// 位置ログは 2fps。直近トレイルはこの時間幅だけ明るく描く
const TRAIL_WINDOW_MS = 15_000;

function parseXY(payloadJson: string | null): { x: number; y: number } | null {
  if (!payloadJson) return null;
  try {
    const p = JSON.parse(payloadJson);
    if (typeof p.x === "number" && typeof p.y === "number") return { x: p.x, y: p.y };
  } catch {
    /* payload 不正は座標なし扱い */
  }
  return null;
}

// キル/デスには座標が付かないため、時刻が最も近い位置ログの座標を借りる
function nearestPosition(positions: PositionPoint[], tMs: number): PositionPoint | null {
  if (positions.length === 0) return null;
  let lo = 0;
  let hi = positions.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (positions[mid].tMs < tMs) lo = mid + 1;
    else hi = mid;
  }
  const after = positions[lo];
  const before = positions[lo - 1];
  if (!before) return after;
  return tMs - before.tMs <= after.tMs - tMs ? before : after;
}

export default function MinimapReplay({ events, mapName, seekRequest }: Props) {
  const { positions, marks, maxTMs } = useMemo(() => {
    const positions: PositionPoint[] = [];
    for (const e of events) {
      if (e.event_type !== "position") continue;
      const xy = parseXY(e.payload_json);
      if (xy) positions.push({ tMs: e.t_ms, ...xy });
    }
    positions.sort((a, b) => a.tMs - b.tMs);

    const marks: EventMark[] = [];
    for (const e of events) {
      if (e.event_type !== "kill" && e.event_type !== "death") continue;
      const pos = nearestPosition(positions, e.t_ms);
      if (pos) {
        marks.push({
          id: e.id,
          tMs: e.t_ms,
          // MatchEventType は未知値許容の (string & {}) を含むため明示ナローイング
          type: e.event_type as "kill" | "death",
          x: pos.x,
          y: pos.y,
        });
      }
    }

    const maxTMs = events.reduce((max, e) => Math.max(max, e.t_ms), 0);
    return { positions, marks, maxTMs };
  }, [events]);

  const [playheadMs, setPlayheadMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const timerRef = useRef<number | null>(null);

  // 外部(time_refs チップ)からのシーク
  useEffect(() => {
    if (seekRequest) {
      setPlayheadMs(Math.min(seekRequest.tMs, maxTMs));
      setPlaying(false);
    }
  }, [seekRequest, maxTMs]);

  useEffect(() => {
    if (!playing) return;
    timerRef.current = window.setInterval(() => {
      setPlayheadMs((t) => {
        const next = t + TICK_MS * speed;
        if (next >= maxTMs) {
          setPlaying(false);
          return maxTMs;
        }
        return next;
      });
    }, TICK_MS);
    return () => {
      if (timerRef.current !== null) clearInterval(timerRef.current);
    };
  }, [playing, speed, maxTMs]);

  const visiblePositions = useMemo(
    () => positions.filter((p) => p.tMs <= playheadMs),
    [positions, playheadMs]
  );
  const trailPositions = visiblePositions.filter((p) => p.tMs >= playheadMs - TRAIL_WINDOW_MS);
  const current = visiblePositions[visiblePositions.length - 1] ?? null;

  const toPoints = (pts: PositionPoint[]) =>
    pts.map((p) => `${(p.x * VIEW).toFixed(2)},${(p.y * VIEW).toFixed(2)}`).join(" ");

  const fullPathPoints = useMemo(() => toPoints(positions), [positions]);

  const handlePlayPause = () => {
    // 末尾で再生を押したら先頭から再生し直す
    if (!playing && playheadMs >= maxTMs) setPlayheadMs(0);
    setPlaying((p) => !p);
  };

  if (positions.length === 0 && marks.length === 0) {
    return <p className="no-events-msg">位置データがないためミニマップを表示できません</p>;
  }

  return (
    <div className="minimap-replay">
      <div className="minimap-canvas-wrapper">
        <svg
          className="minimap-canvas"
          viewBox={`0 0 ${VIEW} ${VIEW}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={`ミニマップリプレイ${mapName ? ` (${mapName})` : ""}`}
        >
          {/* 抽象グリッド背景(Riot 画像アセット不使用) */}
          <rect x="0" y="0" width={VIEW} height={VIEW} className="minimap-bg" />
          {Array.from({ length: 9 }, (_, i) => (i + 1) * 10).map((v) => (
            <g key={v} className="minimap-grid">
              <line x1={v} y1={0} x2={v} y2={VIEW} />
              <line x1={0} y1={v} x2={VIEW} y2={v} />
            </g>
          ))}

          {/* 全行動経路(薄く) */}
          {positions.length > 1 && (
            <polyline className="minimap-path-full" points={fullPathPoints} />
          )}

          {/* 直近トレイル(明るく) */}
          {trailPositions.length > 1 && (
            <polyline className="minimap-path-trail" points={toPoints(trailPositions)} />
          )}

          {/* キル/デスマーカー(再生ヘッド通過後に点灯) */}
          {marks.map((m) => (
            <g
              key={m.id}
              className={`minimap-mark minimap-mark-${m.type} ${
                m.tMs <= playheadMs ? "is-passed" : ""
              }`}
              transform={`translate(${m.x * VIEW}, ${m.y * VIEW})`}
            >
              {m.type === "kill" ? (
                <circle r="1.6" />
              ) : (
                <>
                  <line x1="-1.4" y1="-1.4" x2="1.4" y2="1.4" />
                  <line x1="-1.4" y1="1.4" x2="1.4" y2="-1.4" />
                </>
              )}
            </g>
          ))}

          {/* 現在位置 */}
          {current && (
            <circle
              className="minimap-current"
              cx={current.x * VIEW}
              cy={current.y * VIEW}
              r="2"
            />
          )}
        </svg>
        {mapName && <span className="minimap-map-label">{mapName}</span>}
      </div>

      <div className="minimap-controls">
        <button
          className="secondary-btn minimap-play-btn"
          onClick={handlePlayPause}
          aria-label={playing ? "一時停止" : "再生"}
        >
          {playing ? "⏸" : "▶"}
        </button>
        <span className="minimap-time">
          {formatMatchTime(playheadMs)} / {formatMatchTime(maxTMs)}
        </span>
        <div className="minimap-speeds">
          {SPEEDS.map((s) => (
            <button
              key={s}
              className={`minimap-speed-btn ${speed === s ? "is-active" : ""}`}
              onClick={() => setSpeed(s)}
            >
              ×{s}
            </button>
          ))}
        </div>
      </div>

      <div className="minimap-scrubber">
        <input
          type="range"
          min={0}
          max={maxTMs || 1}
          step={100}
          value={playheadMs}
          onChange={(e) => {
            setPlayheadMs(Number(e.target.value));
            setPlaying(false);
          }}
          aria-label="リプレイ時刻シーク"
        />
        <div className="scrubber-marks" aria-hidden="true">
          {maxTMs > 0 &&
            marks.map((m) => (
              <span
                key={m.id}
                className={`scrubber-tick scrubber-tick-${m.type}`}
                style={{ left: `${(m.tMs / maxTMs) * 100}%` }}
                title={`${formatMatchTime(m.tMs)} ${m.type === "kill" ? "キル" : "デス"}`}
              />
            ))}
        </div>
      </div>

      <div className="minimap-legend">
        <span className="legend-item"><span className="legend-dot legend-kill" /> キル</span>
        <span className="legend-item"><span className="legend-dot legend-death" /> デス</span>
        <span className="legend-item"><span className="legend-dot legend-pos" /> 現在位置</span>
      </div>
    </div>
  );
}
