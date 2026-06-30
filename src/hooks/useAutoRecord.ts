import { useState, useEffect, useRef, useCallback } from "react";
import type { RecordingState, VideoAnalysisResult } from "../types";
import { api } from "../api";

export interface AutoRecordStatus {
  state: RecordingState;
  isRecording: boolean;
  analysisProgress: number;    // 0–1
  analysisStep: string;
  videoAnalysis: VideoAnalysisResult | null;
  sessionId: number | null;
  errorMessage: string | null;
  matchStartTime: Date | null;
}

const INITIAL_STATUS: AutoRecordStatus = {
  state: "idle",
  isRecording: false,
  analysisProgress: 0,
  analysisStep: "",
  videoAnalysis: null,
  sessionId: null,
  errorMessage: null,
  matchStartTime: null,
};

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 2000;

export function useAutoRecord() {
  const [status, setStatus] = useState<AutoRecordStatus>(INITIAL_STATUS);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intentionalStopRef = useRef(false);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (esRef.current) return;

    const es = api.createRecordingEventSource();
    esRef.current = es;

    es.addEventListener("connected", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      reconnectAttemptsRef.current = 0;
      setConnected(true);
      setStatus((prev) => ({
        ...prev,
        state: data.state as RecordingState,
        isRecording: data.isRecording ?? false,
      }));
    });

    es.addEventListener("state_change", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      setStatus((prev) => ({
        ...prev,
        state: data.state as RecordingState,
        errorMessage: null,
      }));
    });

    es.addEventListener("recording_started", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      setStatus((prev) => ({
        ...prev,
        state: "in_match",
        isRecording: true,
        matchStartTime: new Date(data.matchStartTime),
      }));
    });

    es.addEventListener("analysis_progress", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      const stepLabels: Record<string, string> = {
        extracting_frames: "フレーム抽出中...",
        killfeed_analysis: "キルフィード解析中...",
        minimap_analysis: "ミニマップ解析中...",
        result_screen_ocr: "リザルト読み取り中...",
        complete: "解析完了",
      };
      setStatus((prev) => ({
        ...prev,
        analysisProgress: data.progress ?? prev.analysisProgress,
        analysisStep: stepLabels[data.step] ?? data.step ?? prev.analysisStep,
      }));
    });

    es.addEventListener("form_ready", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
      setStatus((prev) => ({
        ...prev,
        state: "done",
        isRecording: false,
        videoAnalysis: data.videoAnalysis ?? null,
        sessionId: data.sessionId ?? null,
        analysisProgress: 1,
      }));
    });

    es.addEventListener("error", (e) => {
      if ((e as MessageEvent).data) {
        const data = JSON.parse((e as MessageEvent).data);
        setStatus((prev) => ({
          ...prev,
          state: "error",
          isRecording: false,
          errorMessage: data.errorMessage ?? "不明なエラーが発生しました",
        }));
      } else {
        // Network/connection error — attempt reconnect with exponential backoff
        setConnected(false);
        es.close();
        esRef.current = null;

        if (
          !intentionalStopRef.current &&
          reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS
        ) {
          const delay =
            RECONNECT_BASE_DELAY_MS * Math.pow(2, reconnectAttemptsRef.current);
          reconnectAttemptsRef.current += 1;
          reconnectTimerRef.current = setTimeout(() => {
            reconnectTimerRef.current = null;
            connect();
          }, delay);
        }
      }
    });

    es.addEventListener("heartbeat", () => {
      // Keep-alive — no state update needed
    });
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const disconnect = useCallback(() => {
    intentionalStopRef.current = true;
    clearReconnectTimer();
    reconnectAttemptsRef.current = 0;
    esRef.current?.close();
    esRef.current = null;
    setConnected(false);
  }, [clearReconnectTimer]);

  const startMonitoring = useCallback(async () => {
    intentionalStopRef.current = false;
    connect();
    await api.startMonitoring();
  }, [connect]);

  const stopMonitoring = useCallback(async () => {
    await api.stopMonitoring();
    disconnect();
    setStatus(INITIAL_STATUS);
  }, [disconnect]);

  const resetStatus = useCallback(() => {
    setStatus(INITIAL_STATUS);
  }, []);

  useEffect(() => {
    return () => {
      intentionalStopRef.current = true;
      clearReconnectTimer();
      esRef.current?.close();
      esRef.current = null;
    };
  }, [clearReconnectTimer]);

  return {
    status,
    connected,
    startMonitoring,
    stopMonitoring,
    resetStatus,
  };
}
