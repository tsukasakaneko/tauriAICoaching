import { useState } from "react";
import type { SavedReport, SessionHistoryItem, SessionStatus } from "../types";
import { api } from "../api";
import { useHistory } from "../hooks/useHistory";

interface Props {
  onOpenReport: (saved: SavedReport) => void;
  onOpenReplay: (sessionId: number, reportId: number | null) => void;
  onBack: () => void;
}

const STATUS_LABELS: Record<string, string> = {
  recording: "録画中",
  analyzing: "解析中",
  done: "完了",
  error: "エラー",
};

function statusLabel(status: SessionStatus): string {
  return STATUS_LABELS[status] ?? status;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  // SQLite datetime('now') は UTC の "YYYY-MM-DD HH:MM:SS" — Date が UTC と解釈
  // できるよう ISO 形式に直してからローカル時刻で表示する
  const date = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  if (isNaN(date.getTime())) return iso;
  return date.toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" });
}

function formatKda(kda: SessionHistoryItem["kda"]): string {
  return kda ? `${kda.kills}/${kda.deaths}/${kda.assists}` : "—";
}

export default function HistoryScreen({ onOpenReport, onOpenReplay, onBack }: Props) {
  const { data, loading, error } = useHistory();
  const [openingReportId, setOpeningReportId] = useState<number | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  const openReport = async (reportId: number) => {
    setOpeningReportId(reportId);
    setOpenError(null);
    try {
      const saved = await api.getReport(reportId);
      onOpenReport(saved);
    } catch (err) {
      setOpenError((err as Error).message);
    } finally {
      setOpeningReportId(null);
    }
  };

  const sessions = data?.sessions ?? [];
  const standaloneReports = data?.standaloneReports ?? [];
  const isEmpty = !loading && !error && sessions.length === 0 && standaloneReports.length === 0;

  return (
    <div className="screen history-screen">
      <div className="report-nav">
        <button className="back-btn" onClick={onBack}>
          ← フォームに戻る
        </button>
        <div className="brand-small">
          <span className="brand-accent">CoachMate</span> for VALORANT
        </div>
      </div>

      <h1 className="report-title">分析履歴</h1>

      {loading && <p className="loading-text">履歴を読み込み中...</p>}
      {error && <p className="error-text">読み込みエラー: {error}</p>}
      {openError && <p className="error-text">レポートを開けませんでした: {openError}</p>}
      {isEmpty && <p className="no-events-msg">履歴はまだありません</p>}

      {sessions.length > 0 && (
        <section className="report-section">
          <h2>自動録画セッション</h2>
          <div className="event-log-wrapper">
            <table className="event-log-table">
              <thead>
                <tr>
                  <th>日時</th>
                  <th>マップ</th>
                  <th>KDA</th>
                  <th>ステータス</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td>{formatDateTime(s.matchStartedAt ?? s.startedAt)}</td>
                    <td>{s.mapName ?? "—"}</td>
                    <td>{formatKda(s.kda)}</td>
                    <td>{statusLabel(s.status)}</td>
                    <td className="history-actions">
                      {s.reportId !== null && (
                        <button
                          className="secondary-btn"
                          disabled={openingReportId === s.reportId}
                          onClick={() => openReport(s.reportId!)}
                        >
                          {openingReportId === s.reportId ? "読込中..." : "レポート"}
                        </button>
                      )}
                      {s.status === "done" && (
                        <button className="secondary-btn" onClick={() => onOpenReplay(s.id, s.reportId)}>
                          リプレイ
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {standaloneReports.length > 0 && (
        <section className="report-section">
          <h2>手動分析レポート</h2>
          <div className="event-log-wrapper">
            <table className="event-log-table">
              <thead>
                <tr>
                  <th>日時</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {standaloneReports.map((r) => (
                  <tr key={r.id}>
                    <td>{formatDateTime(r.createdAt)}</td>
                    <td className="history-actions">
                      <button
                        className="secondary-btn"
                        disabled={openingReportId === r.id}
                        onClick={() => openReport(r.id)}
                      >
                        {openingReportId === r.id ? "読込中..." : "レポートを開く"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
