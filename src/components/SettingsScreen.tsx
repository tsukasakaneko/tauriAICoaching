import { useState, useEffect } from "react";
import type { AiConfig, AiProvider, LicenseStatus, UsageStatus } from "../types";
import { tauriApi } from "../api";

interface Props {
  onBack: () => void;
}

export default function SettingsScreen({ onBack }: Props) {
  const [config, setConfig] = useState<AiConfig>({
    provider: "cloud",
    claude_api_key: null,
    claude_model: "claude-sonnet-4-6",
    ollama_url: "http://127.0.0.1:11434",
    ollama_model: "llama3.1:8b",
  });
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null);
  const [usageStatus, setUsageStatus] = useState<UsageStatus | null>(null);
  const [licenseKey, setLicenseKey] = useState("");
  const [claudeKeyInput, setClaudeKeyInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [activating, setActivating] = useState(false);
  const [successMsg, setSuccessMsg] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    Promise.all([
      tauriApi.getAiConfig(),
      tauriApi.getLicenseStatus(),
      tauriApi.getUsageStatus(),
    ]).then(([cfg, lic, usage]) => {
      setConfig(cfg);
      setLicenseStatus(lic);
      setUsageStatus(usage);
    }).catch((err) => {
      setLoadError(
        err instanceof Error ? err.message : "設定の読み込みに失敗しました"
      );
    }).finally(() => {
      setLoading(false);
    });
  }, []);

  const flash = (msg: string, isError = false) => {
    if (isError) { setErrorMsg(msg); setSuccessMsg(""); }
    else { setSuccessMsg(msg); setErrorMsg(""); }
    setTimeout(() => { setSuccessMsg(""); setErrorMsg(""); }, 4000);
  };

  const handleSaveConfig = async () => {
    setSaving(true);
    try {
      const updated: AiConfig = {
        ...config,
        claude_api_key: claudeKeyInput.trim() || config.claude_api_key,
      };
      await tauriApi.setAiConfig(updated);
      setConfig(updated);
      setClaudeKeyInput("");
      flash("設定を保存しました");
    } catch (err) {
      flash(err instanceof Error ? err.message : "保存に失敗しました", true);
    } finally {
      setSaving(false);
    }
  };

  const handleActivateLicense = async () => {
    const trimmed = licenseKey.trim().toUpperCase();
    if (!trimmed) return;
    setActivating(true);
    try {
      const result = await tauriApi.activateLicense(trimmed);
      setLicenseStatus(result);
      setLicenseKey("");
      const tierLabel =
        result.tier === "pro" ? "Proライセンス" :
        result.tier === "cloud" ? `クラウドAI (${result.cloud_credits}クレジット付与)` :
        "クレジット追加";
      flash(`✓ 有効化成功: ${tierLabel}`);
      // Refresh usage status
      tauriApi.getUsageStatus().then(setUsageStatus).catch(console.error);
    } catch (err) {
      flash(err instanceof Error ? err.message : "有効化に失敗しました", true);
    } finally {
      setActivating(false);
    }
  };

  const tierBadge = (tier: string) => {
    if (tier === "pro") return <span className="badge paid">Pro</span>;
    if (tier === "cloud") return <span className="badge cloud">Cloud AI</span>;
    return <span className="badge free">無料</span>;
  };

  if (loading) {
    return (
      <div className="screen settings-screen">
        <div className="loading">設定を読み込み中...</div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="screen settings-screen">
        <header className="form-header">
          <div className="brand-small">
            <span className="brand-accent">VALORANT</span> 設定
          </div>
          <button className="logout-btn" onClick={onBack}>
            ← 戻る
          </button>
        </header>
        <p className="error" style={{ marginTop: "2rem" }}>
          設定の読み込みに失敗しました: {loadError}
        </p>
      </div>
    );
  }

  return (
    <div className="screen settings-screen">
      <header className="form-header">
        <div className="brand-small">
          <span className="brand-accent">VALORANT</span> 設定
        </div>
        <button className="logout-btn" onClick={onBack}>
          ← 戻る
        </button>
      </header>

      <div className="settings-body">

        {/* ── License Section ─────────────────────── */}
        <section className="settings-section">
          <h3>ライセンス</h3>

          {licenseStatus && (
            <div className="license-status">
              <div className="license-row">
                <span>プラン</span>
                {tierBadge(licenseStatus.tier)}
              </div>
              {licenseStatus.tier === "cloud" && (
                <div className="license-row">
                  <span>クレジット残量</span>
                  <strong>{licenseStatus.cloud_credits} 回</strong>
                </div>
              )}
              {usageStatus && licenseStatus.tier === "free" && (
                <div className="license-row">
                  <span>無料分析残り</span>
                  <strong>
                    {Math.max(0, usageStatus.freeLimit - usageStatus.analysisCount)} / {usageStatus.freeLimit} 回
                  </strong>
                </div>
              )}
            </div>
          )}

          <div className="field">
            <label>アクティベーションキー</label>
            <div className="key-input-row">
              <input
                type="text"
                value={licenseKey}
                onChange={(e) => setLicenseKey(e.target.value)}
                placeholder="VCOACH-XXXXXXXX-XXXXXXXX"
                className="key-input"
              />
              <button
                className="primary-btn"
                onClick={handleActivateLicense}
                disabled={activating || !licenseKey.trim()}
              >
                {activating ? "認証中..." : "有効化"}
              </button>
            </div>
            <p className="hint-text">
              VCOACH (Pro) / VCLOUD (Cloud AI月次) / VCREDIT (追加クレジット)
            </p>
          </div>
        </section>

        {/* ── AI Provider Section ──────────────────── */}
        <section className="settings-section">
          <h3>AIプロバイダー</h3>

          <div className="field">
            <label>使用するAI</label>
            <div className="radio-group">
              {(["cloud", "local"] as AiProvider[]).map((p) => (
                <label key={p} className="radio-label">
                  <input
                    type="radio"
                    name="provider"
                    value={p}
                    checked={config.provider === p}
                    onChange={() => setConfig((c) => ({ ...c, provider: p }))}
                  />
                  {p === "cloud" ? "☁ クラウドAI (Claude)" : "🖥 ローカルAI (Ollama)"}
                </label>
              ))}
            </div>
          </div>

          {config.provider === "cloud" && (
            <>
              <div className="field">
                <label>Claude APIキー</label>
                <input
                  type="password"
                  value={claudeKeyInput}
                  onChange={(e) => setClaudeKeyInput(e.target.value)}
                  placeholder={config.claude_api_key ? "設定済み (変更する場合は入力)" : "sk-ant-..."}
                />
              </div>
              <div className="field">
                <label>モデル</label>
                <select
                  value={config.claude_model}
                  onChange={(e) => setConfig((c) => ({ ...c, claude_model: e.target.value }))}
                >
                  <option value="claude-sonnet-4-6">Claude Sonnet 4.6 (推奨)</option>
                  <option value="claude-opus-4-7">Claude Opus 4.7 (高精度)</option>
                  <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5 (高速)</option>
                </select>
              </div>
            </>
          )}

          {config.provider === "local" && (
            <>
              <div className="field">
                <label>Ollama URL</label>
                <input
                  type="text"
                  value={config.ollama_url}
                  onChange={(e) => setConfig((c) => ({ ...c, ollama_url: e.target.value }))}
                  placeholder="http://127.0.0.1:11434"
                />
              </div>
              <div className="field">
                <label>モデル名</label>
                <input
                  type="text"
                  value={config.ollama_model}
                  onChange={(e) => setConfig((c) => ({ ...c, ollama_model: e.target.value }))}
                  placeholder="llama3.1:8b"
                />
                <p className="hint-text">
                  Ollamaがインストール済みであること。推奨: llama3.1:8b / qwen2.5:7b
                </p>
              </div>
            </>
          )}

          {successMsg && <p className="success-msg">{successMsg}</p>}
          {errorMsg && <p className="error">{errorMsg}</p>}

          <button
            className="primary-btn"
            onClick={handleSaveConfig}
            disabled={saving}
          >
            {saving ? "保存中..." : "設定を保存"}
          </button>
        </section>

      </div>
    </div>
  );
}
