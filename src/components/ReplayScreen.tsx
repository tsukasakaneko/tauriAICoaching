import { useEffect, useState } from "react";
import type { CoachingReport, MatchEvent, TimeRef } from "../types";
import { api } from "../api";
import { useMatchEvents } from "../hooks/useMatchEvents";
import { formatMatchTime } from "../utils/timeline";
import MinimapReplay from "./MinimapReplay";

interface Props {
  sessionId: number;
  /** 表示中のレポート(レポート画面から遷移時)。無ければ reportId から取得 */
  report?: CoachingReport | null;
  /** 履歴から遷移時のレポートID(report が無い場合に取得に使う) */
  reportId?: number | null;
  /** レポートの time_refs から遷移した場合の初期シーク時刻 */
  initialSeekMs?: number | null;
  onBack: () => void;
  backLabel?: string;
}

const EVENT_LABELS: Record<string, string> = {
  position: "移動",
  kill: "キル",
  death: "デス",
};

function EventRow({ event }: { event: MatchEvent }) {
  const label = EVENT_LABELS[event.event_type] ?? event.event_type;
  const payload = event.payload_json
    ? (() => { try { return JSON.parse(event.payload_json); } catch { return null; } })()
    : null;

  return (
    <tr className={`event-row event-type-${event.event_type}`}>
      <td className="event-time">{formatMatchTime(event.t_ms)}</td>
      <td className="event-type">{label}</td>
      <td className="event-payload">
        {payload?.x !== undefined && payload?.y !== undefined
          ? `(${payload.x.toFixed(3)}, ${payload.y.toFixed(3)})`
          : "—"}
      </td>
    </tr>
  );
}

export default function ReplayScreen({
  sessionId,
  report = null,
  reportId = null,
  initialSeekMs = null,
  onBack,
  backLabel = "← レポートに戻る",
}: Props) {
  const { data, loading, error } = useMatchEvents(sessionId);
  const [fetchedReport, setFetchedReport] = useState<CoachingReport | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [seekRequest, setSeekRequest] = useState<{ tMs: number } | null>(
    initialSeekMs !== null ? { tMs: initialSeekMs } : null
  );

  // 履歴からの遷移: レポート本体を持っていないので reportId で取得する
  useEffect(() => {
    if (report || reportId === null) return;
    let cancelled = false;
    api
      .getReport(reportId)
      .then((saved) => { if (!cancelled) setFetchedReport(saved.report); })
      .catch((err: Error) => { if (!cancelled) setReportError(err.message); });
    return () => { cancelled = true; };
  }, [report, reportId]);

  const activeReport = report ?? fetchedReport;

  const kills = data?.events.filter((e) => e.event_type === "kill").length ?? 0;
  const deaths = data?.events.filter((e) => e.event_type === "death").length ?? 0;
  const positions = data?.events.filter((e) => e.event_type === "position").length ?? 0;
  const logEvents = data?.events.filter((e) => e.event_type !== "position") ?? [];

  const handleTimeRef = (ref: TimeRef) => setSeekRequest({ tMs: ref.t_ms });

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

      <h1 className="report-title">リプレイレビュー</h1>

      {loading && <p className="loading-text">イベントを読み込み中...</p>}
      {error && <p className="error-text">読み込みエラー: {error}</p>}

      {data && (
        <div className="review-panes">
          {/* ─── 左ペイン: コーチング結果 ─── */}
          <div className="review-pane review-pane-report">
            {activeReport ? (
              <>
                <section className="report-section">
                  <h2>総括</h2>
                  <div className="review-summary">
                    <div className="summary-card focus-card">
                      <h3>最優先課題</h3>
                      <p>{activeReport.summary.focus}</p>
                    </div>
                    <div className="summary-card">
                      <h3>強み</h3>
                      <p>{activeReport.summary.strengths}</p>
                    </div>
                    <div className="summary-card">
                      <h3>弱み</h3>
                      <p>{activeReport.summary.weaknesses}</p>
                    </div>
                  </div>
                </section>

                <section className="report-section">
                  <h2>改善点</h2>
                  {activeReport.improvements.map((item, i) => (
                    <div key={i} className="improvement-card">
                      <h3>{item.title}</h3>
                      <p>
                        <span className="label">説明:</span> {item.description}
                      </p>
                      <p>
                        <span className="label">原因:</span> {item.cause}
                      </p>
                      <div className="actions">
                        <span className="label">アクション:</span>
                        <ul>
                          {item.actions.map((action, j) => (
                            <li key={j}>{action}</li>
                          ))}
                        </ul>
                      </div>
                      {item.time_refs && item.time_refs.length > 0 && (
                        <div className="time-refs">
                          <span className="label">該当シーン:</span>
                          {item.time_refs.map((ref, j) => (
                            <button
                              key={j}
                              className="time-ref-chip"
                              onClick={() => handleTimeRef(ref)}
                              title="リプレイの該当時刻へジャンプ"
                            >
                              ⏱ {ref.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </section>
              </>
            ) : (
              <section className="report-section">
                <h2>コーチング結果</h2>
                <p className="no-events-msg">
                  {reportError
                    ? `レポートの読み込みに失敗しました: ${reportError}`
                    : "このセッションにはコーチングレポートがありません。フォームから分析を実行するとここに表示されます。"}
                </p>
              </section>
            )}
          </div>

          {/* ─── 右ペイン: リプレイ ─── */}
          <div className="review-pane review-pane-replay">
            <section className="report-section">
              <h2>ミニマップリプレイ</h2>
              <div className="replay-meta-line">
                <span>マップ: {data.meta?.map_name ?? "不明"}</span>
                <span>エージェント: {data.meta?.agent ?? "不明"}</span>
                <span>初期陣営: {data.meta?.ally_side_initial ?? "不明"}</span>
              </div>
              <MinimapReplay
                events={data.events}
                mapName={data.meta?.map_name ?? null}
                seekRequest={seekRequest}
              />
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

            <details className="event-log-details">
              <summary>イベントログ</summary>
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
                    {logEvents.map((e) => (
                      <EventRow key={e.id} event={e} />
                    ))}
                  </tbody>
                </table>
                {logEvents.length === 0 && (
                  <p className="no-events-msg">キル/デスイベントがありません</p>
                )}
              </div>
            </details>
          </div>
        </div>
      )}

      {data && data.events.length === 0 && (
        <p className="no-events-msg">このセッションにはイベントデータがありません</p>
      )}
    </div>
  );
}
