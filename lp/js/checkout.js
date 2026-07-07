'use strict';

// Stripe Checkout 導線 (P1-12)
// backend-remote の POST /create-checkout-session を呼び、返ってきた
// Stripe Checkout URL にリダイレクトする。
// NOTE: API_BASE は Render のサービス名由来の推定値。デプロイ後に
//       Render ダッシュボードで実際の URL を確認して合わせること。
const API_BASE = 'https://valorant-coaching-api.onrender.com';

const errorBox = document.getElementById('checkout-error');

function showError(message) {
  if (!errorBox) return;
  errorBox.textContent = message;
  errorBox.classList.add('visible');
}

async function startCheckout(button) {
  const product = button.dataset.product;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = '接続中...';
  errorBox?.classList.remove('visible');

  try {
    const res = await fetch(`${API_BASE}/create-checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ product }),
    });
    if (res.status === 503) {
      showError('決済は現在準備中です。今しばらくお待ちください。');
      return;
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showError(err.message || '決済ページへの接続に失敗しました。時間をおいてお試しください。');
      return;
    }
    const { url } = await res.json();
    if (!url) {
      showError('決済ページの URL を取得できませんでした。');
      return;
    }
    window.location.href = url;
  } catch {
    showError('決済サーバーに接続できませんでした。ネットワークをご確認のうえ、時間をおいてお試しください。');
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

document.querySelectorAll('[data-product]').forEach((button) => {
  button.addEventListener('click', () => startCheckout(button));
});

// Top app bar のスクロール elevation
const appbar = document.getElementById('appbar');
if (appbar) {
  const onScroll = () => appbar.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}
