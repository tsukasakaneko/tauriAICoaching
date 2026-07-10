import { useState, useEffect } from "react";
import type { Screen, User, CoachingReport, VideoAnalysisResult, SavedReport } from "./types";
import { api, setToken, clearToken } from "./api";
import LoginScreen from "./components/LoginScreen";
import FormScreen from "./components/FormScreen";
import ReportScreen from "./components/ReportScreen";
import AutoRecordScreen from "./components/AutoRecordScreen";
import ReplayScreen from "./components/ReplayScreen";
import SettingsScreen from "./components/SettingsScreen";
import HistoryScreen from "./components/HistoryScreen";
import UpgradeModal from "./components/UpgradeModal";

export default function App() {
  const [screen, setScreen] = useState<Screen>("login");
  const [user, setUser] = useState<User | null>(null);
  const [report, setReport] = useState<CoachingReport | null>(null);
  const [videoAnalysis, setVideoAnalysis] = useState<VideoAnalysisResult | null>(null);
  const [sessionId, setSessionId] = useState<number | null>(null);
  // 履歴から開いたレポート/リプレイは「戻る」で履歴に帰す
  const [reportOrigin, setReportOrigin] = useState<"form" | "history">("form");
  // P2-2: 履歴からリプレイを開く場合のレポートID(本体は ReplayScreen が取得)
  const [replayReportId, setReplayReportId] = useState<number | null>(null);
  // P2-3: レポートの time_refs から遷移した際の初期シーク時刻
  const [replaySeekMs, setReplaySeekMs] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      setLoading(false);
      return;
    }
    api
      .getMe()
      .then((u) => {
        setUser(u);
        setScreen("form");
      })
      .catch(() => {
        clearToken();
      })
      .finally(() => setLoading(false));
  }, []);

  const handleAuthSuccess = (token: string, u: User) => {
    setToken(token);
    setUser(u);
    setScreen("form");
  };

  const handleLogout = () => {
    clearToken();
    setUser(null);
    setReport(null);
    setVideoAnalysis(null);
    setSessionId(null);
    setScreen("login");
  };

  const handleReportReady = (r: CoachingReport) => {
    // 履歴用に永続化(fire-and-forget — 保存失敗でも画面表示は妨げない)
    api.saveReport(sessionId, r).catch((e) => console.warn("report save failed:", e));
    setReport(r);
    setReportOrigin("form");
    setScreen("report");
  };

  const handleOpenSavedReport = (saved: SavedReport) => {
    setReport(saved.report);
    setSessionId(saved.sessionId);
    setReplayReportId(null);
    setReplaySeekMs(null);
    setReportOrigin("history");
    setScreen("report");
  };

  const handleOpenReplayFromHistory = (sid: number, reportId: number | null) => {
    setSessionId(sid);
    setReport(null);
    setReplayReportId(reportId);
    setReplaySeekMs(null);
    setScreen("replay");
  };

  // P2-3: レポートの time_refs チップから該当時刻のリプレイへジャンプ
  const handleReplayAt = (tMs: number | null) => {
    setReplaySeekMs(tMs);
    setScreen("replay");
  };

  const handleAnalysisDone = (analysis: VideoAnalysisResult, sid: number | null) => {
    setVideoAnalysis(analysis);
    setSessionId(sid);
    setScreen("form");
  };

  if (loading) {
    return <div className="loading">Loading...</div>;
  }

  return (
    <div className="app">
      {screen === "login" && (
        <LoginScreen onAuthSuccess={handleAuthSuccess} />
      )}

      {screen === "form" && user && (
        <FormScreen
          user={user}
          videoAnalysis={videoAnalysis}
          sessionId={sessionId}
          onReportReady={handleReportReady}
          onLogout={handleLogout}
          onAutoRecord={() => setScreen("autorecord")}
          onSettings={() => setScreen("settings")}
          onHistory={() => setScreen("history")}
          onUpgradeNeeded={() => setShowUpgradeModal(true)}
        />
      )}

      {screen === "report" && report && (
        <ReportScreen
          report={report}
          sessionId={sessionId}
          onBack={() => {
            if (reportOrigin === "history") {
              setScreen("history");
            } else {
              setVideoAnalysis(null);
              setScreen("form");
            }
          }}
          onUpgrade={() => setShowUpgradeModal(true)}
          onReplay={() => handleReplayAt(null)}
          onReplayAt={handleReplayAt}
        />
      )}

      {screen === "replay" && sessionId !== null && (
        <ReplayScreen
          sessionId={sessionId}
          report={report}
          reportId={replayReportId}
          initialSeekMs={replaySeekMs}
          backLabel={report ? "← レポートに戻る" : "← 履歴に戻る"}
          onBack={() => setScreen(report ? "report" : "history")}
        />
      )}

      {screen === "history" && user && (
        <HistoryScreen
          onOpenReport={handleOpenSavedReport}
          onOpenReplay={handleOpenReplayFromHistory}
          onBack={() => setScreen("form")}
        />
      )}

      {showUpgradeModal && (
        <UpgradeModal
          onClose={() => setShowUpgradeModal(false)}
          onGoToSettings={() => { setShowUpgradeModal(false); setScreen("settings"); }}
        />
      )}

      {screen === "autorecord" && (
        <AutoRecordScreen
          onAnalysisDone={handleAnalysisDone}
          onBack={() => setScreen("form")}
        />
      )}

      {screen === "settings" && (
        <SettingsScreen
          onBack={() => setScreen("form")}
          onAccountDeleted={handleLogout}
        />
      )}
    </div>
  );
}
