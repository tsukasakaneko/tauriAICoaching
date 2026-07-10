import { useState, useEffect, useRef } from "react";
import type {
  User,
  CoachingFormData,
  CoachingReport,
  Rank,
  SelfAssessmentItem,
  VideoAnalysisResult,
  UsageStatus,
  AiProvider,
  PreviousContext,
  TimelineDigestEvent,
} from "../types";
import { api, tauriApi } from "../api";
import { buildTimelineDigest } from "../utils/timeline";

const RANKS: Rank[] = [
  "アイアン", "ブロンズ", "シルバー", "ゴールド", "プラチナ",
  "ダイヤモンド", "アセンダント", "イモータル", "レディアント",
];

const KNOWN_AGENTS = [
  "Astra", "Breach", "Brimstone", "Chamber", "Clove", "Cypher",
  "Deadlock", "Fade", "Gekko", "Harbor", "Iso", "Jett", "KAY/O",
  "Killjoy", "Neon", "Omen", "Phoenix", "Reyna", "Sage", "Skye",
  "Sova", "Tejo", "Viper", "Vyse", "Yoru",
];

const ASSESSMENT_OPTIONS: SelfAssessmentItem[] = [
  "エイム弱い",
  "立ち回り不安",
  "判断遅い",
  "撃ち負けが多い",
];

const ANALYSIS_STEPS = [
  "プレイデータを解析中...",
  "弱点パターンを特定中...",
  "エージェント特性を考慮中...",
  "改善アクションを設計中...",
  "トレーニングプランを作成中...",
];

const FORM_STORAGE_KEY = "valorant-coaching-form";

function loadSavedField<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(FORM_STORAGE_KEY);
    if (!raw) return fallback;
    const data = JSON.parse(raw);
    return key in data ? (data[key] as T) : fallback;
  } catch {
    return fallback;
  }
}

// Trigger the upgrade modal for these errors instead of showing inline text
const LIMIT_ERROR_PATTERNS = ["上限", "クレジットが不足", "有効期限が切れ", "有料プランの機能"];
function isLimitError(msg: string) {
  return LIMIT_ERROR_PATTERNS.some((p) => msg.includes(p));
}

interface Props {
  user: User;
  videoAnalysis: VideoAnalysisResult | null;
  sessionId: number | null;
  onReportReady: (report: CoachingReport) => void;
  onLogout: () => void;
  onAutoRecord: () => void;
  onSettings: () => void;
  onHistory: () => void;
  onUpgradeNeeded: () => void;
}

export default function FormScreen({
  user,
  videoAnalysis,
  sessionId,
  onReportReady,
  onLogout,
  onAutoRecord,
  onSettings,
  onHistory,
  onUpgradeNeeded,
}: Props) {
  const [rank, setRank] = useState<Rank>(() => loadSavedField<Rank>("rank", "シルバー"));
  const [agent, setAgent] = useState(() => loadSavedField("agent", ""));
  const [selfAssessment, setSelfAssessment] = useState<SelfAssessmentItem[]>(
    () => loadSavedField<SelfAssessmentItem[]>("selfAssessment", [])
  );
  const [review, setReview] = useState(() => loadSavedField("review", ""));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [analysisStep, setAnalysisStep] = useState(0);
  const [usageStatus, setUsageStatus] = useState<UsageStatus | null>(null);
  const [aiProvider, setAiProvider] = useState<AiProvider>("cloud");
  const stepTimerRef = useRef<number | null>(null);

  useEffect(() => {
    tauriApi.getUsageStatus().then(setUsageStatus).catch(() => {});
    tauriApi.getAiConfig().then((cfg) => setAiProvider(cfg.provider)).catch(() => {});
  }, []);

  // P1-10: Riot API がエージェントを取得済みなら自動入力(ゼロ入力)。
  // ユーザーが既に入力している場合は上書きしない。
  useEffect(() => {
    if (videoAnalysis?.agent && !agent.trim()) {
      setAgent(videoAnalysis.agent);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoAnalysis]);

  // Persist form data across navigation
  useEffect(() => {
    sessionStorage.setItem(
      FORM_STORAGE_KEY,
      JSON.stringify({ rank, agent, selfAssessment, review })
    );
  }, [rank, agent, selfAssessment, review]);

  // Cleanup step timer on unmount
  useEffect(() => {
    return () => {
      if (stepTimerRef.current !== null) clearInterval(stepTimerRef.current);
    };
  }, []);

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
    setAnalysisStep(0);
    stepTimerRef.current = window.setInterval(() => {
      setAnalysisStep((s) => (s + 1) % ANALYSIS_STEPS.length);
    }, 3500);

    try {
      const formData: CoachingFormData = {
        rank,
        agent: agent.trim(),
        selfAssessment,
        review,
      };
      // P1-9: 前回セッションの指標と前回レポートの課題を取得(前回比用)。
      // 取得失敗・データ無しは「前回なし」として分析を続行する。
      let previousSession: PreviousContext | null = null;
      try {
        previousSession = await api.getPreviousContext(sessionId);
        if (previousSession && !previousSession.metrics && !previousSession.report) {
          previousSession = null;
        }
      } catch {
        previousSession = null;
      }

      // P2-3: 自動録画セッションがあればキル/デスのタイムラインを注入し、
      // レポートに該当シーンの時刻参照(time_refs)を出させる。
      // 取得失敗はタイムライン無しとして分析を続行する。
      let timeline: TimelineDigestEvent[] | null = null;
      if (sessionId !== null) {
        try {
          const replay = await api.getSessionEvents(sessionId);
          const digest = buildTimelineDigest(replay.events);
          timeline = digest.length > 0 ? digest : null;
        } catch {
          timeline = null;
        }
      }

      // P0-2: 無料ティア(3回/日)と cloud ティア+Cloud プロバイダはリモート経由。
      // pro や自前APIキー/Ollama 利用時はローカル(Tauri コマンド)経由。
      const useRemote =
        isFreeTier || (usageStatus?.tier === "cloud" && aiProvider === "cloud");
      const result = useRemote
        ? await tauriApi.analyzeRemote(formData, videoAnalysis, previousSession, timeline)
        : await tauriApi.analyze(formData, videoAnalysis, previousSession, timeline);
      onReportReady(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "分析に失敗しました";
      if (isLimitError(msg)) {
        onUpgradeNeeded();
      } else {
        setError(msg);
      }
    } finally {
      if (stepTimerRef.current !== null) {
        clearInterval(stepTimerRef.current);
        stepTimerRef.current = null;
      }
      setSubmitting(false);
    }
  };

  const isFreeTier = !usageStatus || usageStatus.tier === "free";

  // Proactive credit warning for cloud users before they hit zero
  const lowCreditsWarning =
    usageStatus?.tier === "cloud" && usageStatus.cloudCredits <= 5 && usageStatus.cloudCredits > 0
      ? `クラウドクレジット残り ${usageStatus.cloudCredits} 回です。VCREDITキーで補充してください。`
      : null;

  return (
    <div className="screen form-screen">
      <header className="form-header">
        <div className="brand-small">
          <span className="brand-accent">CoachMate</span> for VALORANT
        </div>
        <div className="user-info">
          <span className="user-email">{user.email}</span>
          <button className="icon-btn" onClick={onHistory} title="分析履歴">
            🕒
          </button>
          <button className="icon-btn" onClick={onSettings} title="設定">
            ⚙
          </button>
          <button className="logout-btn" onClick={onLogout}>
            ログアウト
          </button>
        </div>
      </header>

      <h2 className="form-title">コーチングフォーム</h2>

      {isFreeTier && (
        <div className="license-required-banner" onClick={onUpgradeNeeded}>
          <div>
            <strong>無料プラン: 手動分析 1日3回まで</strong>
            <p>アップグレードでクレジット制+自動録画解析が利用できます 🎁 初回 +10クレジット</p>
          </div>
          <span className="cta-arrow">→</span>
        </div>
      )}

      {lowCreditsWarning && (
        <div className="low-credits-banner" onClick={onUpgradeNeeded}>
          ⚠ {lowCreditsWarning}
        </div>
      )}

      {!videoAnalysis && (
        <div className="autorecord-cta" onClick={onAutoRecord}>
          <span className="cta-icon">🎮</span>
          <div>
            <strong>自動録画で試合分析</strong>
            <p>試合を自動検知し、KDA・マップ・エージェントを自動取得します</p>
          </div>
          <span className="cta-arrow">→</span>
        </div>
      )}

      {videoAnalysis && (
        <div className="video-analysis-badge">
          <span>📊 自動解析データあり</span>
          <span className="badge-detail">
            {videoAnalysis.mapName && `${videoAnalysis.mapName} · `}
            {videoAnalysis.agent && `${videoAnalysis.agent} · `}
            KDA {videoAnalysis.kills}/{videoAnalysis.deaths}/{videoAnalysis.assists} ·
            HS率 {Math.round(videoAnalysis.headshotRate * 100)}%
            {usageStatus?.tier === "cloud" && " · この分析は2クレジット消費"}
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
            list="agents-list"
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            placeholder="例: Jett, Sage, Brimstone..."
          />
          <datalist id="agents-list">
            {KNOWN_AGENTS.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
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

        <button
          type="submit"
          disabled={submitting}
          className="primary-btn analyze-btn"
        >
          {submitting ? "分析中..." : isFreeTier ? "分析する（無料: 1日3回まで）" : "分析する"}
        </button>

        {submitting && (
          <div className="analysis-progress">
            <span className="analysis-dot" />
            <span className="analysis-step-text">
              {ANALYSIS_STEPS[analysisStep]}
            </span>
            <span className="analysis-time">通常 10〜30 秒かかります</span>
          </div>
        )}
      </form>
    </div>
  );
}
