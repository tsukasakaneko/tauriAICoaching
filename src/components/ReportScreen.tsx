import { useEffect, useState } from "react";
import type { CoachingReport } from "../types";
import { tauriApi } from "../api";

interface Props {
  report: CoachingReport;
  sessionId: number | null;
  onBack: () => void;
  onUpgrade: () => void;
  onReplay: () => void;
}

export default function ReportScreen({ report, sessionId, onBack, onUpgrade, onReplay }: Props) {
  const [isFree, setIsFree] = useState(false);

  useEffect(() => {
    tauriApi.getUsageStatus()
      .then((s) => setIsFree(s.tier === "free"))
      .catch(() => {});
  }, []);

  return (
    <div className="screen report-screen">
      <div className="report-nav">
        <button className="back-btn" onClick={onBack}>
          ← フォームに戻る
        </button>
        <div className="brand-small">
          <span className="brand-accent">CoachMate</span> for VALORANT
        </div>
        {sessionId !== null && (
          <button className="secondary-btn" onClick={onReplay}>
            リプレイを見る →
          </button>
        )}
      </div>

      <h1 className="report-title">AIコーチングレポート</h1>

      <section className="report-section summary-section">
        <h2>総括</h2>
        <div className="summary-grid">
          <div className="summary-card">
            <h3>強み</h3>
            <p>{report.summary.strengths}</p>
          </div>
          <div className="summary-card">
            <h3>弱み</h3>
            <p>{report.summary.weaknesses}</p>
          </div>
          <div className="summary-card focus-card">
            <h3>最優先課題</h3>
            <p>{report.summary.focus}</p>
          </div>
        </div>
      </section>

      {report.progress && report.progress.comparisons.length > 0 && (
        <section className="report-section progress-section">
          <h2>前回比</h2>
          <div className="progress-grid">
            {report.progress.comparisons.map((c, i) => (
              <div key={i} className={`progress-card progress-card--${c.assessment}`}>
                <h3>{c.metric}</h3>
                <p className="progress-values">
                  <span className="progress-prev">{c.previous}</span>
                  <span className="progress-arrow">
                    {c.assessment === "improved" ? "↑" : c.assessment === "declined" ? "↓" : "→"}
                  </span>
                  <span className="progress-curr">{c.current}</span>
                </p>
              </div>
            ))}
          </div>
          {report.progress.comment && (
            <p className="progress-comment">{report.progress.comment}</p>
          )}
        </section>
      )}

      <section className="report-section improvements-section">
        <h2>改善点</h2>
        {report.improvements.map((item, i) => (
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
          </div>
        ))}
      </section>

      <section className="report-section training-section">
        <h2>7日間トレーニングプラン</h2>
        <ol className="training-list">
          {report.training_plan.map((day, i) => (
            <li key={i}>{day}</li>
          ))}
        </ol>
      </section>

      {isFree && (
        <div className="upgrade-cta-banner" onClick={onUpgrade}>
          <div className="upgrade-cta-text">
            <strong>気に入っていただけましたか？</strong>
            <p>無料プランを使い切る前にアップグレードして、毎試合コーチングを受け続けましょう。</p>
          </div>
          <button className="primary-btn upgrade-cta-btn">アップグレード →</button>
        </div>
      )}
    </div>
  );
}
