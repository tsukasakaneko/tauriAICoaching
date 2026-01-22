# ライセンス・課金設計仕様

## 概要

eSports AIコーチングアプリにおけるFree/Pro判定とライセンス管理の仕様。
ローカル完結・実装容易性を重視した設計。

---

## 1. ライセンス検証フロー

### 1.1 ライセンスファイル形式

```
形式: JSON + 署名
ファイル名: license.dat
配置場所: アプリデータディレクトリ
```

**ライセンスファイル構造:**

```json
{
  "license_id": "uuid-v4",
  "user_email": "user@example.com",
  "tier": "pro",
  "issued_at": "2025-01-01T00:00:00Z",
  "expires_at": "2026-01-01T00:00:00Z",
  "features": ["unlimited_analysis", "no_ads", "priority_models"],
  "signature": "base64-encoded-ed25519-signature"
}
```

### 1.2 署名検証

- **アルゴリズム**: Ed25519（高速・コンパクト）
- **公開鍵**: アプリにハードコード（Rustバイナリ内）
- **検証対象**: signature以外のJSON部分をcanonical化したもの

```rust
// 疑似コード
fn verify_license(license: &License, public_key: &[u8]) -> bool {
    let payload = canonicalize_json(&license.without_signature());
    ed25519_verify(public_key, payload, &license.signature)
}
```

### 1.3 検証タイミング

| タイミング | 処理 |
|-----------|------|
| アプリ起動時 | ライセンス読み込み＆検証 |
| 解析開始時 | 有効期限チェック |
| 設定画面表示時 | ステータス表示用に再検証 |

### 1.4 検証失敗時の挙動

```
署名無効 → Freeモードにフォールバック（エラーログのみ）
ファイル不在 → Freeモード
期限切れ → Freeモード + 更新案内表示
```

---

## 2. 有効期限管理

### 2.1 時刻取得

**原則: ローカル時刻を使用**

```rust
let now = chrono::Utc::now();
let is_valid = license.expires_at > now;
```

### 2.2 時刻改ざん対策

**やること:**
- ファイルのmtimeと現在時刻の比較による簡易チェック
- 最終起動時刻の記録（次回起動時に時刻の巻き戻し検出）

**やらないこと:**
- NTPによるオンライン時刻検証（常時オンライン禁止のため）
- ハードウェアクロック直接参照

### 2.3 期限切れ予告

```
残り30日 → 設定画面に更新ボタン表示
残り7日 → アプリ起動時にトースト通知
残り0日 → 起動時にダイアログ表示 + Freeモード移行
```

---

## 3. 不正対策「やらないこと」定義

### 3.1 実装しないこと

| 対策 | 理由 |
|------|------|
| オンラインアクティベーション必須 | 常時オンライン禁止要件に違反 |
| ハードウェアバインディング | PC買い替え時のサポート負荷大 |
| コードオブファスケーション | 保守性低下、効果限定的 |
| タンパー検出による強制終了 | UX悪化、誤検出リスク |
| ライセンスサーバーへの定期通信 | ローカル完結要件に違反 |

### 3.2 許容するリスク

```
- ライセンスファイルの共有（署名があるため生成は困難）
- 時刻改ざんによる期限延長（簡易チェックのみ）
- バイナリ改変による検証バイパス（対策コスト > 損失）
```

### 3.3 設計思想

```
「クラックされても困らない程度の価格設定」
「正規ユーザーの利便性を最優先」
「不正対策コストは最小限に」
```

---

## 4. 将来オンライン化への移行パス

### 4.1 段階的移行計画

**Phase 1: 現状（ローカル完結）**
```
- オフラインライセンス検証
- 手動でのライセンスファイル配布
```

**Phase 2: オプショナルオンライン**
```
- ライセンス自動ダウンロード機能追加
- オフライン検証は維持（フォールバック）
- 新機能: ライセンス更新通知
```

**Phase 3: オンライン推奨**
```
- サブスクリプション対応
- オフラインモード（7日間キャッシュ）
- ライセンスポータルWebアプリ
```

### 4.2 後方互換性

```rust
// ライセンスファイルのバージョニング
{
  "version": 1,  // 追加予定
  // ... existing fields
}
```

**移行時の保証:**
- 旧形式ライセンスは新バージョンでも有効
- オフライン検証ロジックは削除しない

### 4.3 将来のデータ構造拡張予約

```json
{
  "version": 2,
  "license_id": "...",
  "user_email": "...",
  "tier": "pro",
  "issued_at": "...",
  "expires_at": "...",
  "features": [...],
  "device_limit": 3,           // Phase 2で追加予定
  "subscription_id": "...",    // Phase 3で追加予定
  "refresh_token": "...",      // Phase 3で追加予定
  "signature": "..."
}
```

---

## 5. 実装ガイドライン

### 5.1 Rust側（Tauri Backend）

```
src-tauri/
├── src/
│   ├── license/
│   │   ├── mod.rs          # モジュール公開
│   │   ├── types.rs        # License構造体定義
│   │   ├── verify.rs       # 署名検証ロジック
│   │   └── state.rs        # ライセンス状態管理
```

### 5.2 Frontend側

```
src/
├── hooks/
│   └── useLicense.ts       # ライセンス状態フック
├── contexts/
│   └── LicenseContext.tsx  # ライセンスコンテキスト
├── components/
│   └── license/
│       ├── LicenseStatus.tsx    # ステータス表示
│       └── UpgradePrompt.tsx    # アップグレード案内
```

### 5.3 Tauri IPC コマンド

```rust
#[tauri::command]
fn get_license_status() -> LicenseStatus { ... }

#[tauri::command]
fn import_license(file_path: String) -> Result<(), LicenseError> { ... }

#[tauri::command]
fn get_feature_flags() -> FeatureFlags { ... }
```

---

## 6. Free/Pro 機能差分

| 機能 | Free | Pro |
|------|------|-----|
| 動画解析 | 1日3回まで | 無制限 |
| 解析中広告 | 表示 | 非表示 |
| 解析モデル | 標準 | 高精度含む |
| 解析履歴保存 | 7日間 | 無制限 |
| エクスポート | 透かし入り | 透かしなし |

---

## 変更履歴

| 日付 | 変更者 | 内容 |
|------|--------|------|
| 2025-01-22 | LicenseMonetizationAgent | 初版作成 |
