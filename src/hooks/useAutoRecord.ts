import { useState, useEffect, useRef, useCallback } from "react";
import type { RecordingState, VideoAnalysisResult } from "../types";
import { api } from "../api";

export interface AutoRecordStatus {
  state: RecordingState;
  isRecording: boolean;
  analysisProgress: number;    // 0–1
  analysisStep: string;
  videoAnalysis: VideoAnalysisResult | null;
  errorMessage: string | null;
  matchStartTime: Date | null;
}

const INITIAL_STATUS: AutoRecordStatus = {
  state: "idle",
  isRecording: false,
  analysisProgress: 0,
  analysisStep: "",
  videoAnalysis: null,
  errorMessage: null,
  matchStartTime: null,
};

export function useAutoRecord() {
  const [status, setStatus] = useState<AutoRecordStatus>(INITIAL_STATUS);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  const connect = useCallback(() => {
    if (esRef.current) return;

    const es = api.createRecordingEventSource();
    esRef.current = es;

    es.addEventListener("connected", (e) => {
      const data = JSON.parse((e as MessageEvent).data);
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
        // SSE connection error
        setConnected(false);
        es.close();
        esRef.current = null;
      }
    });

    es.addEventListener("heartbeat", () => {
      // Keep-alive — no state update needed
    });
  }, []);

  const disconnect = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
    setConnected(false);
  }, []);

  const startMonitoring = useCallback(async () => {
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
      esRef.current?.close();
      esRef.current = null;
    };
  }, []);

  return {
    status,
    connected,
    startMonitoring,
    stopMonitoring,
    resetStatus,
  };
}
