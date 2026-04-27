export type Screen = "login" | "form" | "report";

export interface User {
  id: number;
  email: string;
  isPaid: boolean;
}

export type Rank = "ブロンズ" | "シルバー" | "ゴールド" | "プラチナ";

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
