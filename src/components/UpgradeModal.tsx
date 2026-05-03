interface Props {
  onClose: () => void;
  onGoToSettings: () => void;
}

export default function UpgradeModal({ onClose, onGoToSettings }: Props) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-icon">🔒</div>
        <h2 className="modal-title">無料プランの上限に達しました</h2>
        <p className="modal-body">
          無料トライアル（5回）を使い切りました。<br />
          ライセンスキーを入力してアップグレードすることで、引き続きAIコーチングをご利用いただけます。
        </p>

        <div className="plan-grid">
          <div className="plan-card">
            <div className="plan-name">☁ Cloud AI</div>
            <div className="plan-desc">
              VCLOUDキー（月次）で30クレジット付与。<br />
              VCREDITキーで追加クレジット購入可能。
            </div>
          </div>
          <div className="plan-card plan-card--highlight">
            <div className="plan-name">⚡ Pro（永久）</div>
            <div className="plan-desc">
              VCOACHキーで無制限に分析可能。<br />
              一度購入すれば期限なし。
            </div>
          </div>
        </div>

        <div className="modal-actions">
          <button className="primary-btn" onClick={onGoToSettings}>
            ライセンスキーを入力する →
          </button>
          <button className="text-btn" onClick={onClose}>
            後で
          </button>
        </div>
      </div>
    </div>
  );
}
