export type Screen = "login" | "form" | "report" | "autorecord" | "settings" | "replay";

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

export interface Improvement {
  title: string;
  description: string;
  cause: string;
  actions: string[];
}

export interface CoachingReport {
  improvements: Improvement[];
  training_plan: string[];
  summary: {
    strengths: string;
    weaknesses: string;
    focus: string;
  };
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
  deathsInLateRound: number;
  longestLoseStreak: number | null;
  totalRounds: number | null;
  wonRounds: number | null;
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

export interface MatchEvent {
  id: number;
  frame_idx: number;
  t_ms: number;
  event_type: "position" | "kill" | "death" | string;
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

