export type Screen = "login" | "form" | "report" | "autorecord" | "settings" | "replay" | "history";

export interface User {
  id: number;
  email: string;
  isPaid: boolean;
}

export type Rank =
  | "アイアン"
  | "ブロンズ"
  | "シルバー"
  | "ゴールド"
  | "プラチナ"
  | "ダイヤモンド"
  | "アセンダント"
  | "イモータル"
  | "レディアント";

export type SelfAssessmentItem =
  | "エイム弱い"
  | "立ち回り不安"
  | "判断遅い"
  | "撃ち負けが多い";

export interface CoachingFormData {
  rank: Rank;
  agent: string;
  selfAssessment: SelfAssessmentItem[];
  review: string;
}

/** P2-3: 改善点が参照する試合内の時刻。リプレイの該当時点へのジャンプに使う */
export interface TimeRef {
  t_ms: number;
  label: string;
}

export interface Improvement {
  title: string;
  description: string;
  cause: string;
  actions: string[];
  /** P2-3: タイムライン注入時のみ AI が出力する(旧レポートには存在しない) */
  time_refs?: TimeRef[];
}

export type ProgressAssessment = "improved" | "declined" | "flat";

export interface ProgressComparison {
  metric: string;
  previous: string;
  current: string;
  // AI 出力なので想定外の文字列も許容する(未知値は中立表示にフォールバック)
  assessment: ProgressAssessment | (string & {});
}

export interface ReportProgress {
  comparisons: ProgressComparison[];
  comment?: string | null;
}

export interface CoachingReport {
  improvements: Improvement[];
  training_plan: string[];
  summary: {
    strengths: string;
    weaknesses: string;
    focus: string;
  };
  /** 前回比 (P1-9)。前回データがない初回分析・旧レポートには存在しない */
  progress?: ReportProgress | null;
}

export interface AuthResponse {
  token: string;
  user: User;
}

// ─── Auto-record types ───────────────────────────────────────────────────────

export type RecordingState =
  | "idle"
  | "queue_wait"
  | "agent_select"
  | "in_match"
  | "result_screen"
  | "analyzing"
  | "done"
  | "error"
  | "unknown";

export interface VideoAnalysisResult {
  kills: number;
  deaths: number;
  assists: number;
  headshotRate: number;     // 0.0–1.0
  damageDealt: number | null;
  abilityKills: number;
  dominantZone: string;
  aggressiveness: number;   // 0.0–1.0
  positionVariety: "low" | "medium" | "high";
  deathsInLateRound: number | null;
  longestLoseStreak: number | null;
  totalRounds: number | null;
  wonRounds: number | null;
  // P1-10: Riot ローカル API 由来(旧データには存在しないため optional)
  mapName?: string | null;
  agent?: string | null;
  statsSource?: "riot" | "video";
}

// ─── AI / License types ──────────────────────────────────────────────────────

export type AiProvider = "cloud" | "local";

export interface AiConfig {
  provider: AiProvider;
  claude_api_key: string | null;
  claude_model: string;
  ollama_url: string;
  ollama_model: string;
}

export interface LicenseStatus {
  tier: "free" | "pro" | "cloud";
  cloud_credits: number;
  has_key: boolean;
  cloud_expires_at?: string; // "YYYY-MM" for CloudMonthly subscriptions
}

/** Returned from activate_license; firstPaymentBonus > 0 means welcome bonus was granted. */
export interface ActivationResult {
  license: LicenseStatus;
  firstPaymentBonus: number;
}

export interface UsageStatus {
  tier: string;
  cloudCredits: number;
}

// ─── Replay / event log types ─────────────────────────────────────────────────

export type MapName =
  | "bind"
  | "ascent"
  | "haven"
  | "split"
  | "lotus"
  | "sunset"
  | "icebox"
  | "abyss";

export type MatchEventType = "position" | "kill" | "death" | (string & {});

export interface MatchEvent {
  id: number;
  frame_idx: number;
  t_ms: number;
  event_type: MatchEventType;
  payload_json: string | null;
}

export interface MatchMeta {
  map_name: MapName | null;
  agent: string | null;
  ally_side_initial: string | null;
}

export interface ReplayData {
  events: MatchEvent[];
  meta: MatchMeta | null;
}

/** P2-3: プロンプトに注入するキル/デスの時系列ダイジェスト(position は除外) */
export interface TimelineDigestEvent {
  tMs: number;
  eventType: "kill" | "death";
  headshot?: boolean;
  ability?: boolean;
}

// ─── Analysis history types (P1-8) ────────────────────────────────────────────

export type SessionStatus = "recording" | "analyzing" | "done" | "error" | (string & {});

export interface SessionHistoryItem {
  id: number;
  startedAt: string;
  matchStartedAt: string | null;
  matchEndedAt: string | null;
  status: SessionStatus;
  mapName: MapName | null;
  agent: string | null;
  kda: { kills: number; deaths: number; assists: number } | null;
  wonRounds: number | null;
  totalRounds: number | null;
  reportId: number | null;
}

export interface StandaloneReportItem {
  id: number;
  createdAt: string;
}

export interface HistoryResponse {
  sessions: SessionHistoryItem[];
  standaloneReports: StandaloneReportItem[];
}

export interface SavedReport {
  id: number;
  sessionId: number | null;
  createdAt: string;
  report: CoachingReport;
}

// ─── Progress tracking types (P1-9) ──────────────────────────────────────────

export interface PreviousReportDigest {
  improvementTitles: string[];
  focus: string | null;
  trainingPlan: string[];
}

export interface PreviousContext {
  metrics: VideoAnalysisResult | null;
  metricsDate: string | null;
  report: PreviousReportDigest | null;
  reportDate: string | null;
}

