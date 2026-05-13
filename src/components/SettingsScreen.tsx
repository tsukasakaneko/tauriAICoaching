import { useState, useEffect } from "react";
import type { AiConfig, AiProvider, LicenseStatus, UsageStatus } from "../types";
import { api, tauriApi } from "../api";

interface Props {
  onBack: () => void;
  onAccountDeleted: () => void;
}

export default function SettingsScreen({ onBack, onAccountDeleted }: Props) {
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
  const [testingCloud, setTestingCloud] = useState(false);
  const [testingOllama, setTestingOllama] = useState(false);
  const [cloudTestResult, setCloudTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [ollamaTestResult, setOllamaTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [activating, setActivating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
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

  const handleTestClaude = async () => {
    const key = claudeKeyInput.trim() || config.claude_api_key || "";
    if (!key) {
      setCloudTestResult({ ok: false, msg: "APIキーを入力してください" });
      return;
    }
    setTestingCloud(true);
    setCloudTestResult(null);
    try {
      const msg = await tauriApi.testClaudeKey(key, config.claude_model);
      setCloudTestResult({ ok: true, msg });
    } catch (err) {
      setCloudTestResult({ ok: false, msg: err instanceof Error ? err.message : "接続に失敗しました" });
    } finally {
      setTestingCloud(false);
    }
  };

  const handleTestOllama = async () => {
    setTestingOllama(true);
    setOllamaTestResult(null);
    try {
      const msg = await tauriApi.testOllama(config.ollama_url, config.ollama_model);
      setOllamaTestResult({ ok: true, msg });
    } catch (err) {
      setOllamaTestResult({ ok: false, msg: err instanceof Error ? err.message : "接続に失敗しました" });
    } finally {
      setTestingOllama(false);
    }
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
      setLicenseStatus(result.license);
      setLicenseKey("");
      const lic = result.license;
      const tierLabel =
        lic.tier === "pro" ? "Proライセンス（無制限）" :
        lic.tier === "cloud" ? `クラウドAI (${lic.cloud_credits}クレジット)` :
        "クレジット追加";
      const bonusMsg = result.firstPaymentBonus > 0
        ? ` 🎁 初回ボーナス +${result.firstPaymentBonus}クレジット付与！`
        : "";
      flash(`✓ 有効化成功: ${tierLabel}${bonusMsg}`);
      tauriApi.getUsageStatus().then(setUsageStatus).catch(console.error);
    } catch (err) {
      flash(err instanceof Error ? err.message : "有効化に失敗しました", true);
    } finally {
      setActivating(false);
    }
  };

  const handleDeleteAccount = async () => {
    setDeleting(true);
    try {
      await api.deleteAccount();
      onAccountDeleted();
    } catch (err) {
      flash(err instanceof Error ? err.message : "削除に失敗しました", true);
      setDeleteConfirm(false);
    } finally {
      setDeleting(false);
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
              {licenseStatus.tier === "cloud" && licenseStatus.cloud_expires_at && (
                <div className="license-row">
                  <span>サブスクリプション期限</span>
                  <strong className="expiry-date">{licenseStatus.cloud_expires_at}</strong>
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
                placeholder="VCLOUD-XXXXXXXX / VCREDIT-XXXXXXXX"
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
              VCLOUD（月額/年額サブスク） / VCREDIT（クレジットパック）
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
                  onChange={(e) => { setClaudeKeyInput(e.target.value); setCloudTestResult(null); }}
                  placeholder={config.claude_api_key ? "設定済み (変更する場合は入力)" : "sk-ant-..."}
                />
                <button
                  className="text-btn test-btn"
                  onClick={handleTestClaude}
                  disabled={testingCloud}
                >
                  {testingCloud ? "確認中..." : "接続テスト"}
                </button>
                {cloudTestResult && (
                  <p className={cloudTestResult.ok ? "success-msg" : "error"}>
                    {cloudTestResult.ok ? "✓ " : "✗ "}{cloudTestResult.msg}
                  </p>
                )}
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
                  onChange={(e) => { setConfig((c) => ({ ...c, ollama_url: e.target.value })); setOllamaTestResult(null); }}
                  placeholder="http://127.0.0.1:11434"
                />
              </div>
              <div className="field">
                <label>モデル名</label>
                <input
                  type="text"
                  value={config.ollama_model}
                  onChange={(e) => { setConfig((c) => ({ ...c, ollama_model: e.target.value })); setOllamaTestResult(null); }}
                  placeholder="llama3.1:8b"
                />
                <p className="hint-text">
                  Ollamaがインストール済みであること。推奨: llama3.1:8b / qwen2.5:7b
                </p>
                <button
                  className="text-btn test-btn"
                  onClick={handleTestOllama}
                  disabled={testingOllama}
                >
                  {testingOllama ? "確認中..." : "接続テスト"}
                </button>
                {ollamaTestResult && (
                  <p className={ollamaTestResult.ok ? "success-msg" : "error"}>
                    {ollamaTestResult.ok ? "✓ " : "✗ "}{ollamaTestResult.msg}
                  </p>
                )}
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

        {/* ── Account Deletion Section (GDPR Right to Erasure) ─── */}
        <section className="settings-section danger-zone">
          <h3>アカウント管理</h3>
          <p className="hint-text">
            アカウントを削除すると、すべての分析履歴・個人情報が完全に削除され、復元できません。
          </p>
          {!deleteConfirm ? (
            <button
              className="danger-btn"
              onClick={() => setDeleteConfirm(true)}
            >
              アカウントを削除する
            </button>
          ) : (
            <div className="delete-confirm-box">
              <p>本当に削除しますか？この操作は取り消せません。</p>
              <div className="delete-confirm-actions">
                <button
                  className="danger-btn"
                  onClick={handleDeleteAccount}
                  disabled={deleting}
                >
                  {deleting ? "削除中..." : "はい、削除します"}
                </button>
                <button
                  className="text-btn"
                  onClick={() => setDeleteConfirm(false)}
                  disabled={deleting}
                >
                  キャンセル
                </button>
              </div>
            </div>
          )}
        </section>

      </div>
    </div>
  );
}
