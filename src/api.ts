import { invoke } from "@tauri-apps/api/core";
import type {
  AuthResponse,
  CoachingFormData,
  CoachingReport,
  User,
  VideoAnalysisResult,
  AiConfig,
  LicenseStatus,
  UsageStatus,
} from "./types";

const BASE_URL = "http://127.0.0.1:3001";

function getToken(): string | null {
  return localStorage.getItem("token");
}

export function setToken(token: string): void {
  localStorage.setItem("token", token);
}

export function clearToken(): void {
  localStorage.removeItem("token");
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
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

  // Auto-record endpoints
  startMonitoring: () =>
    request<{ ok: boolean; state: string }>("/autorecord/start", { method: "POST" }),

  stopMonitoring: () =>
    request<{ ok: boolean }>("/autorecord/stop", { method: "POST" }),

  getRecordState: () =>
    request<{ state: string; isRecording: boolean }>("/autorecord/state"),

  getLatestAnalysis: () =>
    request<VideoAnalysisResult | null>("/autorecord/latest"),

  // SSE factory — EventSource needs the token as a query param
  createRecordingEventSource: (): EventSource => {
    const token = getToken() ?? "";
    return new EventSource(`${BASE_URL}/autorecord/status?token=${encodeURIComponent(token)}`);
  },
};

// ─── Tauri command wrappers ───────────────────────────────────────────────────

export const tauriApi = {
  analyze: (
    formData: CoachingFormData,
    videoAnalysis: VideoAnalysisResult | null
  ): Promise<CoachingReport> =>
    invoke<CoachingReport>("ai_analyze", {
      payload: {
        rank: formData.rank,
        agent: formData.agent,
        selfAssessment: formData.selfAssessment,
        review: formData.review,
        videoAnalysis: videoAnalysis ?? null,
      },
    }),

  getAiConfig: (): Promise<AiConfig> => invoke<AiConfig>("get_ai_config"),

  setAiConfig: (config: AiConfig): Promise<void> =>
    invoke<void>("set_ai_config", { config }),

  getUsageStatus: (): Promise<UsageStatus> => invoke<UsageStatus>("get_usage_status"),

  activateLicense: (key: string): Promise<LicenseStatus> =>
    invoke<LicenseStatus>("activate_license", { key }),

  getLicenseStatus: (): Promise<LicenseStatus> => invoke<LicenseStatus>("get_license_status"),
};
