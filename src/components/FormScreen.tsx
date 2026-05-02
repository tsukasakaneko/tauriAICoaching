import { useState } from "react";
import type {
  User,
  CoachingFormData,
  CoachingReport,
  Rank,
  SelfAssessmentItem,
  VideoAnalysisResult,
} from "../types";
import { tauriApi } from "../api";

const RANKS: Rank[] = ["ブロンズ", "シルバー", "ゴールド", "プラチナ"];
const ASSESSMENT_OPTIONS: SelfAssessmentItem[] = [
  "エイム弱い",
  "立ち回り不安",
  "判断遅い",
  "撃ち負けが多い",
];

interface Props {
  user: User;
  videoAnalysis: VideoAnalysisResult | null;
  onReportReady: (report: CoachingReport) => void;
  onLogout: () => void;
  onAutoRecord: () => void;
  onSettings: () => void;
}

export default function FormScreen({
  user,
  videoAnalysis,
  onReportReady,
  onLogout,
  onAutoRecord,
  onSettings,
}: Props) {
  const [rank, setRank] = useState<Rank>("シルバー");
  const [agent, setAgent] = useState("");
  const [selfAssessment, setSelfAssessment] = useState<SelfAssessmentItem[]>([]);
  const [review, setReview] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const toggleAssessment = (item: SelfAssessmentItem) => {
    setSelfAssessment((prev) =>
      prev.includes(item) ? prev.filter((i) => i !== item) : [...prev, item]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!agent.trim()) {
      setError("エージェントを入力してください");
      return;
    }

    setSubmitting(true);
    try {
      const formData: CoachingFormData = {
        rank,
        agent: agent.trim(),
        selfAssessment,
        review,
      };
      const result = await tauriApi.analyze(formData, videoAnalysis);
      onReportReady(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "分析に失敗しました");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="screen form-screen">
      <header className="form-header">
        <div className="brand-small">
          <span className="brand-accent">VALORANT</span> AI Coaching
        </div>
        <div className="user-info">
          <span className="user-email">{user.email}</span>
          <button className="icon-btn" onClick={onSettings} title="設定">
            ⚙
          </button>
          <button className="logout-btn" onClick={onLogout}>
            ログアウト
          </button>
        </div>
      </header>

      <h2 className="form-title">コーチングフォーム</h2>

      {/* Auto-record CTA */}
      {!videoAnalysis && (
        <div className="autorecord-cta" onClick={onAutoRecord}>
          <span className="cta-icon">🎮</span>
          <div>
            <strong>自動録画で試合分析</strong>
            <p>Valorantを自動録画し、YOLOv8でKDA・ポジション等を計測します</p>
          </div>
          <span className="cta-arrow">→</span>
        </div>
      )}

      {/* Video analysis badge */}
      {videoAnalysis && (
        <div className="video-analysis-badge">
          <span>📊 自動解析データあり</span>
          <span className="badge-detail">
            KDA {videoAnalysis.kills}/{videoAnalysis.deaths}/{videoAnalysis.assists} ·
            HS率 {Math.round(videoAnalysis.headshotRate * 100)}%
          </span>
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div className="field">
          <label>ランク帯</label>
          <select value={rank} onChange={(e) => setRank(e.target.value as Rank)}>
            {RANKS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>使用エージェント</label>
          <input
            type="text"
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            placeholder="例: Jett, Sage, Brimstone..."
          />
        </div>

        <div className="field">
          <label>自己評価（複数選択可）</label>
          <div className="checkboxes">
            {ASSESSMENT_OPTIONS.map((item) => (
              <label key={item} className="checkbox-label">
                <input
                  type="checkbox"
                  checked={selfAssessment.includes(item)}
                  onChange={() => toggleAssessment(item)}
                />
                {item}
              </label>
            ))}
          </div>
        </div>

        <div className="field">
          <label>試合の振り返り</label>
          <textarea
            value={review}
            onChange={(e) => setReview(e.target.value)}
            rows={4}
            placeholder="最近のプレイで気になった点を自由に記入してください..."
          />
        </div>

        {error && <p className="error">{error}</p>}

        <button type="submit" disabled={submitting} className="primary-btn analyze-btn">
          {submitting ? "AI分析中..." : "分析する"}
        </button>
      </form>
    </div>
  );
}
