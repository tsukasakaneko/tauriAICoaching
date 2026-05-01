import { useState, useEffect } from "react";
import type { Screen, User, CoachingReport } from "./types";
import { api, setToken, clearToken } from "./api";
import LoginScreen from "./components/LoginScreen";
import FormScreen from "./components/FormScreen";
import ReportScreen from "./components/ReportScreen";

export default function App() {
  const [screen, setScreen] = useState<Screen>("login");
  const [user, setUser] = useState<User | null>(null);
  const [report, setReport] = useState<CoachingReport | null>(null);
  const [loading, setLoading] = useState(true);

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
    setScreen("login");
  };

  const handleReportReady = (r: CoachingReport) => {
    setReport(r);
    setScreen("report");
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
          onReportReady={handleReportReady}
          onLogout={handleLogout}
        />
      )}
      {screen === "report" && report && (
        <ReportScreen report={report} onBack={() => setScreen("form")} />
      )}
    </div>
  );
}
