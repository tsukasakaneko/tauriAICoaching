import { useEffect, useRef, useState } from "react";
import { toPng } from "html-to-image";
import type { CoachingReport } from "../types";
import { tauriApi } from "../api";
import { PRODUCT_NAME, DOWNLOAD_URL } from "../constants";

interface Props {
  report: CoachingReport;
  sessionId: number | null;
  onBack: () => void;
  onUpgrade: () => void;
  onReplay: () => void;
}

const isTauri = () =>
  typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== "undefined";

export default function ReportScreen({ report, sessionId, onBack, onUpgrade, onReplay }: Props) {
  const [isFree, setIsFree] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [shareHint, setShareHint] = useState<string | null>(null);
  const captureRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    tauriApi.getUsageStatus()
      .then((s) => setIsFree(s.tier === "free"))
      .catch(() => {});
  }, []);

  // P1-11: レポート本文をブランドフッターごと PNG 化する
  const capturePng = async (): Promise<string> => {
    if (!captureRef.current) throw new Error("レポートが表示されていません");
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || "#0f1117";
    return toPng(captureRef.current, { backgroundColor: bg, pixelRatio: 2 });
  };

  // 保存先パスを返す(ブラウザ dev 時は <a download> フォールバックで null)
  const saveImage = async (): Promise<string | null> => {
    const dataUrl = await capturePng();
    if (isTauri()) {
      return tauriApi.saveReportImage(dataUrl.split(",")[1]);
    }
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `CoachMate_Report_${Date.now()}.png`;
    a.click();
    return null;
  };

  const handleSave = async () => {
    setSharing(true);
    setShareHint(null);
    try {
      const path = await saveImage();
      setShareHint(path ? `画像を保存しました: ${path}` : "画像をダウンロードしました");
    } catch (err) {
      setShareHint(`画像の保存に失敗しました: ${(err as Error).message}`);
    } finally {
      setSharing(false);
    }
  };

  const handleShareX = async () => {
    setSharing(true);
    setShareHint(null);
    try {
      const path = await saveImage();
      const text = `${PRODUCT_NAME} でAIコーチングレポートを生成しました🎯\n${DOWNLOAD_URL}\n#VALORANT #CoachMate`;
      const intentUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
      if (isTauri()) {
        await tauriApi.openExternalUrl(intentUrl);
      } else {
        window.open(intentUrl, "_blank");
      }
      setShareHint(
        path
          ? `保存した画像を投稿に添付してください: ${path}`
          : "ダウンロードした画像を投稿に添付してください"
      );
    } catch (err) {
      setShareHint(`共有に失敗しました: ${(err as Error).message}`);
    } finally {
      setSharing(false);
    }
  };

  return (
    <div className="screen report-screen">
      <div className="report-nav">
        <button className="back-btn" onClick={onBack}>
          ← フォームに戻る
        </button>
        <div className="brand-small">
          <span className="brand-accent">CoachMate</span> for VALORANT
        </div>
        <div className="report-actions">
          <button className="secondary-btn" onClick={handleSave} disabled={sharing}>
            {sharing ? "生成中..." : "画像を保存"}
          </button>
          <button className="secondary-btn" onClick={handleShareX} disabled={sharing}>
            Xで共有
          </button>
          {sessionId !== null && (
            <button className="secondary-btn" onClick={onReplay}>
              リプレイを見る →
            </button>
          )}
        </div>
      </div>

      {shareHint && <p className="share-hint">{shareHint}</p>}

      <div ref={captureRef} className="report-capture">
      <h1 className="report-title">AIコーチングレポート</h1>

      <section className="report-section summary-section">
        <h2>総括</h2>
        <div className="summary-grid">
          <div className="summary-card">
            <h3>強み</h3>
            <p>{report.summary.strengths}</p>
          </div>
          <div className="summary-card">
            <h3>弱み</h3>
            <p>{report.summary.weaknesses}</p>
          </div>
          <div className="summary-card focus-card">
            <h3>最優先課題</h3>
            <p>{report.summary.focus}</p>
          </div>
        </div>
      </section>

      {report.progress && report.progress.comparisons.length > 0 && (
        <section className="report-section progress-section">
          <h2>前回比</h2>
          <div className="progress-grid">
            {report.progress.comparisons.map((c, i) => (
              <div key={i} className={`progress-card progress-card--${c.assessment}`}>
                <h3>{c.metric}</h3>
                <p className="progress-values">
                  <span className="progress-prev">{c.previous}</span>
                  <span className="progress-arrow">
                    {c.assessment === "improved" ? "↑" : c.assessment === "declined" ? "↓" : "→"}
                  </span>
                  <span className="progress-curr">{c.current}</span>
                </p>
              </div>
            ))}
          </div>
          {report.progress.comment && (
            <p className="progress-comment">{report.progress.comment}</p>
          )}
        </section>
      )}

      <section className="report-section improvements-section">
        <h2>改善点</h2>
        {report.improvements.map((item, i) => (
          <div key={i} className="improvement-card">
            <h3>{item.title}</h3>
            <p>
              <span className="label">説明:</span> {item.description}
            </p>
            <p>
              <span className="label">原因:</span> {item.cause}
            </p>
            <div className="actions">
              <span className="label">アクション:</span>
              <ul>
                {item.actions.map((action, j) => (
                  <li key={j}>{action}</li>
                ))}
              </ul>
            </div>
          </div>
        ))}
      </section>

      <section className="report-section training-section">
        <h2>7日間トレーニングプラン</h2>
        <ol className="training-list">
          {report.training_plan.map((day, i) => (
            <li key={i}>{day}</li>
          ))}
        </ol>
      </section>

      {/* P1-11: 共有画像に焼き込まれるブランドフッター(常時表示) */}
      <div className="report-brand-footer">
        <span className="brand-accent">CoachMate</span> for VALORANT — {DOWNLOAD_URL}
      </div>
      </div>

      {isFree && (
        <div className="upgrade-cta-banner" onClick={onUpgrade}>
          <div className="upgrade-cta-text">
            <strong>気に入っていただけましたか？</strong>
            <p>無料プランを使い切る前にアップグレードして、毎試合コーチングを受け続けましょう。</p>
          </div>
          <button className="primary-btn upgrade-cta-btn">アップグレード →</button>
        </div>
      )}
    </div>
  );
}
