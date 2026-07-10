import type { MatchEvent, TimelineDigestEvent } from "../types";

/** 試合内経過時間を "M:SS" 表記にする(レポート/リプレイ共通) */
export function formatMatchTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

// プロンプトの肥大化と AI の注意散漫を防ぐための上限。キル/デスは
// 1試合で通常 10〜40 件程度なので、超過時は先頭から切り詰めるだけでよい。
const MAX_DIGEST_EVENTS = 40;

/**
 * P2-3: リプレイイベントから AI プロンプト用のキル/デスダイジェストを作る。
 * position イベント(数千件)は含めない。
 */
export function buildTimelineDigest(events: MatchEvent[]): TimelineDigestEvent[] {
  const digest: TimelineDigestEvent[] = [];
  for (const e of events) {
    if (e.event_type !== "kill" && e.event_type !== "death") continue;
    let payload: { headshot?: boolean; ability?: boolean } | null = null;
    if (e.payload_json) {
      try {
        payload = JSON.parse(e.payload_json);
      } catch {
        payload = null;
      }
    }
    digest.push({
      tMs: e.t_ms,
      // MatchEventType は未知値許容の (string & {}) を含むため明示ナローイング
      eventType: e.event_type as "kill" | "death",
      ...(payload?.headshot ? { headshot: true } : {}),
      ...(payload?.ability ? { ability: true } : {}),
    });
    if (digest.length >= MAX_DIGEST_EVENTS) break;
  }
  return digest;
}
