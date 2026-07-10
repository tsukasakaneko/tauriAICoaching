import { useRef } from "react";
import type { CoachingReport, MatchEvent } from "../types";
import { useMatchEvents } from "../hooks/useMatchEvents";
import { api } from "../api";

interface Props {
  sessionId: number;
  onBack: () => void;
  backLabel?: string;
  report?: CoachingReport | null;
}

const EVENT_LABELS: Record<string, string> = {
  position: "移動",
  kill: "キル",
  death: "デス",
  assist: "アシスト",
};

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

interface EventPayload {
  x?: number;
  y?: number;
  round?: number | null;
  headshot?: boolean;
  source?: string;
}

function payloadDetail(payload: EventPayload | null): string {
  if (!payload) return "—";
  const parts: string[] = [];
  if (typeof payload.round === "number") parts.push(`ラウンド ${payload.round + 1}`);
  if (payload.headshot) parts.push("HS");
  if (payload.x !== undefined && payload.y !== undefined) {
    parts.push(`(${payload.x.toFixed(3)}, ${payload.y.toFixed(3)})`);
  }
  return parts.length > 0 ? parts.join(" / ") : "—";
}

function EventRow({ event, onSeek }: { event: MatchEvent; onSeek?: (tMs: number) => void }) {
  const label = EVENT_LABELS[event.event_type] ?? event.event_type;
  const payload: EventPayload | null = event.payload_json
    ? (() => { try { return JSON.parse(event.payload_json!); } catch { return null; } })()
    : null;

  return (
    <tr
      className={`event-row event-type-${event.event_type}${onSeek ? " clickable" : ""}`}
      onClick={onSeek ? () => onSeek(event.t_ms) : undefined}
      title={onSeek ? "クリックでこのシーンを再生" : undefined}
    >
      <td className="event-time">{formatTime(event.t_ms)}</td>
      <td className="event-type">{label}</td>
      <td className="event-payload">{payloadDetail(payload)}</td>
    </tr>
  );
}

export default function ReplayScreen({ sessionId, onBack, backLabel = "← レポートに戻る", report = null }: Props) {
  const { data, loading, error } = useMatchEvents(sessionId);
  const videoRef = useRef<HTMLVideoElement>(null);

  const kills = data?.events.filter((e) => e.event_type === "kill").length ?? 0;
  const deaths = data?.events.filter((e) => e.event_type === "death").length ?? 0;
  const assists = data?.events.filter((e) => e.event_type === "assist").length ?? 0;
  const positions = data?.events.filter((e) => e.event_type === "position").length ?? 0;

  const videoAvailable = data?.videoAvailable === true;

  const seekTo = (tMs: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = tMs / 1000;
    video.play().catch(() => { /* 自動再生がブロックされても手動再生できる */ });
  };

  return (
    <div className="screen replay-screen">
      <div className="report-nav">
        <button className="back-btn" onClick={onBack}>
          {backLabel}
        </button>
        <div className="brand-small">
          <span className="brand-accent">CoachMate</span> for VALORANT
        </div>
      </div>

      <h1 className="report-title">リプレイ解析</h1>

      {loading && <p className="loading-text">イベントを読み込み中...</p>}
      {error && <p className="error-text">読み込みエラー: {error}</p>}

      {data && (
        <>
          <section className="report-section">
            <h2>試合の録画</h2>
            {videoAvailable ? (
              <>
                <video
                  ref={videoRef}
                  className="replay-video"
                  controls
                  preload="metadata"
                  src={api.getSessionVideoUrl(sessionId)}
                />
                <p className="replay-video-hint">
                  下のイベントログの行をクリックすると、そのシーンにジャンプします。
                </p>
              </>
            ) : (
              <p className="no-video-msg">
                この試合の録画は保存されていません(旧バージョンで解析した試合)。イベントログのみ表示します。
              </p>
            )}
          </section>

          <section className="report-section">
            <h2>マッチ情報</h2>
            <div className="summary-grid">
              <div className="summary-card">
                <h3>マップ</h3>
                <p>{data.meta?.map_name ?? "不明"}</p>
              </div>
              <div className="summary-card">
                <h3>エージェント</h3>
                <p>{data.meta?.agent ?? "不明"}</p>
              </div>
              <div className="summary-card">
                <h3>陣営（初期）</h3>
                <p>{data.meta?.ally_side_initial ?? "不明"}</p>
              </div>
            </div>
          </section>

          <section className="report-section">
            <h2>イベントサマリー</h2>
            <div className="summary-grid">
              <div className="summary-card">
                <h3>キル</h3>
                <p>{kills}</p>
              </div>
              <div className="summary-card">
                <h3>デス</h3>
                <p>{deaths}</p>
              </div>
              <div className="summary-card">
                <h3>アシスト</h3>
                <p>{assists}</p>
              </div>
              <div className="summary-card">
                <h3>位置ログ</h3>
                <p>{positions} フレーム</p>
              </div>
            </div>
          </section>

          {report && (
            <section className="report-section replay-coaching-panel">
              <h2>コーチング結果</h2>
              <p className="coaching-focus">
                <strong>今週のフォーカス:</strong> {report.summary.focus}
              </p>
              {report.improvements.length > 0 && (
                <ul className="coaching-improvements">
                  {report.improvements.map((imp, i) => (
                    <li key={i}>{imp.title}</li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {data.events.length > 0 ? (
            <section className="report-section">
              <h2>イベントログ</h2>
              <div className="event-log-wrapper">
                <table className="event-log-table">
                  <thead>
                    <tr>
                      <th>時刻</th>
                      <th>イベント</th>
                      <th>詳細</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.events
                      .filter((e) => e.event_type !== "position")
                      .map((e) => (
                        <EventRow key={e.id} event={e} onSeek={videoAvailable ? seekTo : undefined} />
                      ))}
                  </tbody>
                </table>
                {data.events.filter((e) => e.event_type !== "position").length === 0 && (
                  <p className="no-events-msg">キル/デス/アシストイベントがありません</p>
                )}
              </div>
            </section>
          ) : (
            <p className="no-events-msg">このセッションにはイベントデータがありません</p>
          )}
        </>
      )}
    </div>
  );
}
