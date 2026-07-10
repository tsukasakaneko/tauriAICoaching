import { invoke } from "@tauri-apps/api/core";
import type {
  AuthResponse,
  CoachingFormData,
  CoachingReport,
  User,
  VideoAnalysisResult,
  AiConfig,
  LicenseStatus,
  ActivationResult,
  UsageStatus,
  ReplayData,
  HistoryResponse,
  SavedReport,
  PreviousContext,
} from "./types";

const BASE_URL = "http://127.0.0.1:3001";
const REMOTE_API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "";

function getToken(): string | null {
  return localStorage.getItem("token");
}

export function setToken(token: string): void {
  localStorage.setItem("token", token);
}

export function clearToken(): void {
  localStorage.removeItem("token");
}

async function request<T>(path: string, options: RequestInit = {}, baseUrl = BASE_URL): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  // 呼び出し側が明示した Authorization(例: ライセンストークン)を優先する
  if (token && !headers["Authorization"]) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(`${baseUrl}${path}`, { ...options, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: "Unknown error" }));
    throw new Error((err as { message?: string }).message || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  register: (email: string, password: string) =>
    request<AuthResponse>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  login: (email: string, password: string) =>
    request<AuthResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  getMe: () => request<User>("/me"),

  deleteAccount: () => request<{ ok: boolean }>("/me", { method: "DELETE" }),

  // Auto-record endpoints
  startMonitoring: () =>
    request<{ ok: boolean; state: string }>("/autorecord/start", { method: "POST" }),

  stopMonitoring: () =>
    request<{ ok: boolean }>("/autorecord/stop", { method: "POST" }),

  getRecordState: () =>
    request<{ state: string; isRecording: boolean }>("/autorecord/state"),

  getLatestAnalysis: () =>
    request<VideoAnalysisResult | null>("/autorecord/latest"),

  getSessionEvents: (sessionId: number) =>
    request<ReplayData>(`/sessions/${sessionId}/events`),

  // Analysis history endpoints
  getHistory: () => request<HistoryResponse>("/history"),

  saveReport: (sessionId: number | null, report: CoachingReport) =>
    request<{ id: number }>("/reports", {
      method: "POST",
      body: JSON.stringify({ sessionId, report }),
    }),

  getReport: (id: number) => request<SavedReport>(`/reports/${id}`),

  // 前回比 (P1-9): 前回セッションの指標と前回レポートの課題ダイジェスト
  getPreviousContext: (excludeSession: number | null) =>
    request<PreviousContext>(
      `/previous-context${excludeSession != null ? `?excludeSession=${excludeSession}` : ""}`
    ),

  // SSE factory — EventSource needs the token as a query param
  createRecordingEventSource: (): EventSource => {
    const token = getToken() ?? "";
    return new EventSource(`${BASE_URL}/autorecord/status?token=${encodeURIComponent(token)}`);
  },

  // 録画動画の URL — <video> はヘッダを付けられないため token をクエリで渡す
  getSessionVideoUrl: (sessionId: number): string => {
    const token = getToken() ?? "";
    return `${BASE_URL}/sessions/${sessionId}/video?token=${encodeURIComponent(token)}`;
  },
};

// ─── Tauri command wrappers ───────────────────────────────────────────────────

export const tauriApi = {
  analyze: (
    formData: CoachingFormData,
    videoAnalysis: VideoAnalysisResult | null,
    previousSession: PreviousContext | null = null
  ): Promise<CoachingReport> =>
    invoke<CoachingReport>("ai_analyze", {
      payload: {
        rank: formData.rank,
        agent: formData.agent,
        selfAssessment: formData.selfAssessment,
        review: formData.review,
        videoAnalysis: videoAnalysis ?? null,
        previousSession: previousSession ?? null,
      },
    }),

  // free / cloud tier: routes through the remote server (developer's API key)
  // P0-1: 有料はライセンストークン認証+サーバー側クレジット消費。
  // P0-2: 無料はトークン無し+deviceHash で 3回/日(サーバー側 enforce)。
  // P0-3: プロンプトは Tauri 側 prompt_builder.rs(知識ベース入り)で構築して送る。
  analyzeRemote: async (
    formData: CoachingFormData,
    videoAnalysis: VideoAnalysisResult | null,
    previousSession: PreviousContext | null = null
  ): Promise<CoachingReport> => {
    const prompts = await invoke<{ systemPrompt: string; userPrompt: string }>(
      "build_analysis_prompts",
      {
        payload: {
          rank: formData.rank,
          agent: formData.agent,
          selfAssessment: formData.selfAssessment,
          review: formData.review,
          videoAnalysis: videoAnalysis ?? null,
          previousSession: previousSession ?? null,
        },
      }
    );
    const licenseToken = await invoke<string | null>("get_license_token");
    const deviceHash = licenseToken ? null : await invoke<string>("get_device_hash");
    return request<CoachingReport>("/analyze", {
      method: "POST",
      headers: licenseToken ? { Authorization: `Bearer ${licenseToken}` } : undefined,
      body: JSON.stringify({
        systemPrompt: prompts.systemPrompt,
        userPrompt: prompts.userPrompt,
        videoAnalysis: videoAnalysis !== null,
        ...(deviceHash ? { deviceHash } : {}),
      }),
    }, REMOTE_API_URL);
  },

  getAiConfig: (): Promise<AiConfig> => invoke<AiConfig>("get_ai_config"),

  setAiConfig: (config: AiConfig): Promise<void> =>
    invoke<void>("set_ai_config", { config }),

  getUsageStatus: (): Promise<UsageStatus> => invoke<UsageStatus>("get_usage_status"),

  activateLicense: (key: string): Promise<ActivationResult> =>
    invoke<ActivationResult>("activate_license", { key }),

  getLicenseStatus: (): Promise<LicenseStatus> => invoke<LicenseStatus>("get_license_status"),

  // P1-11: レポート画像を Downloads に保存し、保存先パスを返す
  saveReportImage: (base64Png: string): Promise<string> =>
    invoke<string>("save_report_image", { base64Png }),

  openExternalUrl: (url: string): Promise<void> =>
    invoke<void>("open_external_url", { url }),

  openCheckout: async (product: string): Promise<void> => {
    const { url } = await request<{ url: string }>(
      "/create-checkout-session",
      { method: "POST", body: JSON.stringify({ product }) },
      REMOTE_API_URL,
    );
    await invoke<void>("open_external_url", { url });
  },

  testClaudeKey: (apiKey: string, model: string): Promise<string> =>
    invoke<string>("test_claude_key", { apiKey, model }),

  testOllama: (url: string, model: string): Promise<string> =>
    invoke<string>("test_ollama", { url, model }),
};
