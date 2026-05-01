import type { CoachingReport } from "../types";

interface Props {
  report: CoachingReport;
  onBack: () => void;
}

export default function ReportScreen({ report, onBack }: Props) {
  return (
    <div className="screen report-screen">
      <div className="report-nav">
        <button className="back-btn" onClick={onBack}>
          ← フォームに戻る
        </button>
        <div className="brand-small">
          <span className="brand-accent">VALORANT</span> AI Coaching
        </div>
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
    </div>
  );
}
