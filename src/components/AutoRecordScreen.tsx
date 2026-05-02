import { useEffect, useRef, useState } from "react";
import type { VideoAnalysisResult } from "../types";
import { useAutoRecord } from "../hooks/useAutoRecord";

interface Props {
  onAnalysisDone: (analysis: VideoAnalysisResult) => void;
  onBack: () => void;
}

const STATE_LABELS: Record<string, { label: string; step: number }> = {
  idle:           { label: "待機中", step: 0 },
  queue_wait:     { label: "キュー待ち中...", step: 1 },
  agent_select:   { label: "エージェント選択中...", step: 2 },
  in_match:       { label: "試合中 — 録画中", step: 3 },
  result_screen:  { label: "リザルト検出", step: 4 },
  analyzing:      { label: "動画解析中...", step: 4 },
  done:           { label: "解析完了！", step: 5 },
  error:          { label: "エラー", step: -1 },
  unknown:        { label: "検出中...", step: 0 },
};

export default function AutoRecordScreen({ onAnalysisDone, onBack }: Props) {
  const { status, connected, startMonitoring, stopMonitoring } = useAutoRecord();
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<number | null>(null);

  // Start monitoring on mount
  useEffect(() => {
    startMonitoring().catch(console.error);
    return () => {
      stopMonitoring().catch(console.error);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Match elapsed timer
  useEffect(() => {
    if (status.isRecording && status.matchStartTime) {
      timerRef.current = window.setInterval(() => {
        setElapsed(Math.floor((Date.now() - status.matchStartTime!.getTime()) / 1000));
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      if (!status.isRecording) setElapsed(0);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [status.isRecording, status.matchStartTime]);

  // Navigate when done
  useEffect(() => {
    if (status.state === "done" && status.videoAnalysis) {
      onAnalysisDone(status.videoAnalysis);
    }
  }, [status.state, status.videoAnalysis, onAnalysisDone]);

  const { label, step } = STATE_LABELS[status.state] ?? { label: "不明", step: 0 };
  const steps = ["待機", "キュー", "エージェント選択", "試合中", "解析中", "完了"];

  const formatElapsed = (secs: number) => {
    const m = Math.floor(secs / 60).toString().padStart(2, "0");
    const s = (secs % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  };

  return (
    <div className="screen autorecord-screen">
      <header className="form-header">
        <div className="brand-small">
          <span className="brand-accent">VALORANT</span> 自動録画・解析
        </div>
        <button className="logout-btn" onClick={onBack}>
          ← 戻る
        </button>
      </header>

      <div className="autorecord-body">
        {/* Connection indicator */}
        <div className={`connection-badge ${connected ? "connected" : "disconnected"}`}>
          {connected ? "● 監視中" : "○ 未接続"}
        </div>

        {/* Step indicator */}
        <div className="step-indicator">
          {steps.map((s, i) => (
            <div
              key={s}
              className={`step-item ${i < step ? "completed" : i === step ? "active" : "pending"}`}
            >
              <div className="step-dot">{i < step ? "✓" : i + 1}</div>
              <div className="step-label">{s}</div>
            </div>
          ))}
        </div>

        {/* Status message */}
        <div className="record-status">
          <p className="status-label">{label}</p>

          {status.isRecording && (
            <div className="recording-timer">
              <span className="rec-dot">●</span>
              REC {formatElapsed(elapsed)}
            </div>
          )}

          {(status.state === "analyzing" || status.analysisProgress > 0 && status.analysisProgress < 1) && (
            <div className="progress-bar-wrap">
              <div
                className="progress-bar-fill"
                style={{ width: `${Math.round(status.analysisProgress * 100)}%` }}
              />
              <span className="progress-label">
                {status.analysisStep || "解析中..."} {Math.round(status.analysisProgress * 100)}%
              </span>
            </div>
          )}

          {status.errorMessage && (
            <p className="error">{status.errorMessage}</p>
          )}
        </div>

        {/* Instructions */}
        {status.state === "idle" && (
          <div className="autorecord-hint">
            <p>Valorantを起動してください。</p>
            <p>キューに入ると自動で録画を開始し、試合終了後に自動解析します。</p>
          </div>
        )}

        {status.state === "in_match" && (
          <div className="autorecord-hint">
            <p>試合中は最小化して通常通りプレイしてください。</p>
            <p>リザルト画面を表示すると自動で録画を停止します。</p>
          </div>
        )}

        {/* Manual stop */}
        {(status.isRecording || status.state !== "idle") && status.state !== "done" && status.state !== "error" && (
          <button
            className="stop-btn"
            onClick={() => stopMonitoring()}
          >
            監視を停止
          </button>
        )}
      </div>
    </div>
  );
}
