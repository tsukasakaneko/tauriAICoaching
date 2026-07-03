import { useState } from "react";
import { tauriApi } from "../api";

interface Props {
  onClose: () => void;
  onGoToSettings: () => void;
}

type Product = "monthly" | "yearly" | "pro_pack" | "standard" | "starter";

const PLAN_INFO: { id: Product; label: string; price: string; credits: string; highlight?: boolean }[] = [
  { id: "yearly",   label: "年額プラン",        price: "¥8,800/年", credits: "600クレジット付与（50/月相当）", highlight: true },
  { id: "monthly",  label: "月額プラン",        price: "¥980/月",   credits: "50クレジット/月付与" },
  { id: "pro_pack", label: "プロパック",        price: "¥1,980",    credits: "80クレジット付与（6ヶ月有効）" },
  { id: "standard", label: "スタンダード",      price: "¥800",      credits: "30クレジット付与（6ヶ月有効）" },
];

export default function UpgradeModal({ onClose, onGoToSettings }: Props) {
  const [loading, setLoading] = useState<Product | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleBuy(product: Product) {
    setLoading(product);
    setError(null);
    try {
      await tauriApi.openCheckout(product);
    } catch (e) {
      setError(e instanceof Error ? e.message : "エラーが発生しました");
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card modal-card--wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-icon">🎮</div>
        <h2 className="modal-title">プランを選択</h2>
        <p className="modal-body">
          購入後、ライセンスキーをメールでお届けします。<br />
          消費レート: 手動分析 1クレジット / 自動録画の分析 2クレジット<br />
          <strong className="bonus-highlight">🎁 初回アクティベートで +10クレジットボーナス！</strong>
        </p>

        {error && <p className="error-text">{error}</p>}

        <div className="plan-grid plan-grid--4col">
          {PLAN_INFO.map((plan) => (
            <div key={plan.id} className={`plan-card${plan.highlight ? " plan-card--highlight" : ""}`}>
              {plan.highlight && <div className="plan-badge">人気</div>}
              <div className="plan-name">{plan.label}</div>
              <div className="plan-price">{plan.price}</div>
              <div className="plan-desc">{plan.credits}</div>
              <button
                className="plan-buy-btn"
                onClick={() => handleBuy(plan.id)}
                disabled={loading !== null}
              >
                {loading === plan.id ? "処理中..." : "購入する"}
              </button>
            </div>
          ))}
        </div>

        <div className="modal-actions">
          <button className="text-btn" onClick={onGoToSettings}>
            すでにキーをお持ちの方 →
          </button>
          <button className="text-btn" onClick={onClose}>
            後で
          </button>
        </div>
      </div>
    </div>
  );
}
