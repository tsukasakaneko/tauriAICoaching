interface Props {
  onClose: () => void;
  onGoToSettings: () => void;
}

export default function UpgradeModal({ onClose, onGoToSettings }: Props) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-icon">🎮</div>
        <h2 className="modal-title">ライセンスキーで今すぐ始めよう</h2>
        <p className="modal-body">
          AIコーチングのご利用にはライセンスキーが必要です。<br />
          <strong className="bonus-highlight">🎁 初回アクティベートで +10クレジットボーナス付与！</strong>
        </p>

        <div className="plan-grid">
          <div className="plan-card">
            <div className="plan-name">☁ Cloud AI (VCLOUD)</div>
            <div className="plan-desc">
              月次キーで <strong>30クレジット</strong> 付与。<br />
              初回は <strong>+10ボーナス = 40回</strong> 利用可。<br />
              VCREDITキーで追加購入も可能。
            </div>
          </div>
          <div className="plan-card plan-card--highlight">
            <div className="plan-name">⚡ Pro 永久 (VCOACH)</div>
            <div className="plan-desc">
              一度購入で<strong>無制限</strong>に分析可能。<br />
              初回ボーナス <strong>+10クレジット</strong> で<br />
              Cloud AI もすぐ試せる。
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
