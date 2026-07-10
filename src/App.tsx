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
import HeatmapScreen from "./components/HeatmapScreen";
import UpgradeModal from "./components/UpgradeModal";

export default function App() {
  const [screen, setScreen] = useState<Screen>("login");
  const [user, setUser] = useState<User | null>(null);
  const [report, setReport] = useState<CoachingReport | null>(null);
  const [videoAnalysis, setVideoAnalysis] = useState<VideoAnalysisResult | null>(null);
  const [sessionId, setSessionId] = useState<number | null>(null);
  // 履歴から開いたレポート/リプレイは「戻る」で履歴に帰す
  const [reportOrigin, setReportOrigin] = useState<"form" | "history">("form");
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
    setReportOrigin("history");
    setScreen("report");
  };

  const handleOpenReplayFromHistory = (sid: number) => {
    setSessionId(sid);
    setReport(null);
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
          onHeatmap={() => setScreen("heatmap")}
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
          onReplay={() => setScreen("replay")}
        />
      )}

      {screen === "replay" && sessionId !== null && (
        <ReplayScreen
          sessionId={sessionId}
          backLabel={report ? "← レポートに戻る" : "← 履歴に戻る"}
          onBack={() => setScreen(report ? "report" : "history")}
          report={report}
        />
      )}

      {screen === "heatmap" && user && (
        <HeatmapScreen onBack={() => setScreen("form")} />
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
