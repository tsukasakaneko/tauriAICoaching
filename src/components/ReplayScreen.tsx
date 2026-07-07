import type { MatchEvent } from "../types";
import { useMatchEvents } from "../hooks/useMatchEvents";

interface Props {
  sessionId: number;
  onBack: () => void;
  backLabel?: string;
}

const EVENT_LABELS: Record<string, string> = {
  position: "移動",
  kill: "キル",
  death: "デス",
};

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function EventRow({ event }: { event: MatchEvent }) {
  const label = EVENT_LABELS[event.event_type] ?? event.event_type;
  const payload = event.payload_json
    ? (() => { try { return JSON.parse(event.payload_json); } catch { return null; } })()
    : null;

  return (
    <tr className={`event-row event-type-${event.event_type}`}>
      <td className="event-time">{formatTime(event.t_ms)}</td>
      <td className="event-type">{label}</td>
      <td className="event-payload">
        {payload?.x !== undefined && payload?.y !== undefined
          ? `(${payload.x.toFixed(3)}, ${payload.y.toFixed(3)})`
          : "—"}
      </td>
    </tr>
  );
}

export default function ReplayScreen({ sessionId, onBack, backLabel = "← レポートに戻る" }: Props) {
  const { data, loading, error } = useMatchEvents(sessionId);

  const kills = data?.events.filter((e) => e.event_type === "kill").length ?? 0;
  const deaths = data?.events.filter((e) => e.event_type === "death").length ?? 0;
  const positions = data?.events.filter((e) => e.event_type === "position").length ?? 0;

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
                <h3>位置ログ</h3>
                <p>{positions} フレーム</p>
              </div>
            </div>
          </section>

          {data.events.length > 0 ? (
            <section className="report-section">
              <h2>イベントログ</h2>
              <div className="event-log-wrapper">
                <table className="event-log-table">
                  <thead>
                    <tr>
                      <th>時刻</th>
                      <th>イベント</th>
                      <th>座標</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.events
                      .filter((e) => e.event_type !== "position")
                      .map((e) => (
                        <EventRow key={e.id} event={e} />
                      ))}
                  </tbody>
                </table>
                {data.events.filter((e) => e.event_type !== "position").length === 0 && (
                  <p className="no-events-msg">キル/デスイベントがありません</p>
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
