# MVP統合アーキテクチャ仕様

## 概要

eSports AIコーチングアプリのMVP構成を定義する。
各専門エージェントの成果物を統合し、実装可能な最小構成を確定する。

---

## 1. 全体アーキテクチャ図

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Tauri Application                               │
├──────────────────────────────────┬──────────────────────────────────────────┤
│         Frontend (React/TS)      │           Backend (Rust/Tauri)           │
├──────────────────────────────────┼──────────────────────────────────────────┤
│                                  │                                          │
│  ┌────────────────────────────┐  │  ┌────────────────────────────────────┐  │
│  │       UI Layer             │  │  │        Core Services               │  │
│  │  ┌──────────────────────┐  │  │  │  ┌──────────────────────────────┐  │  │
│  │  │ Pages                │  │  │  │  │ License Module              │  │  │
│  │  │ - Dashboard          │  │  │  │  │ - verify.rs (Ed25519)       │  │  │
│  │  │ - VideoImport        │  │  │  │  │ - state.rs                  │  │  │
│  │  │ - AnalysisProgress   │◄─┼──┼──┼──┤ - types.rs                  │  │  │
│  │  │ - AnalysisResults    │  │  │  │  └──────────────────────────────┘  │  │
│  │  │ - History            │  │  │  │                                    │  │
│  │  │ - Settings           │  │  │  │  ┌──────────────────────────────┐  │  │
│  │  └──────────────────────┘  │  │  │  │ Analysis Pipeline           │  │  │
│  │                            │  │  │  │ - video_loader.rs           │  │  │
│  │  ┌──────────────────────┐  │  │  │  │ - yolo_inference.rs         │  │  │
│  │  │ State Management     │  │  │  │  │ - frame_processor.rs        │  │  │
│  │  │ - LicenseContext     │◄─┼──┼──┼──┤ - event_detector.rs         │  │  │
│  │  │ - AnalysisContext    │  │  │  │  └──────────────────────────────┘  │  │
│  │  │ - HistoryContext     │  │  │  │                                    │  │
│  │  └──────────────────────┘  │  │  │  ┌──────────────────────────────┐  │  │
│  │                            │  │  │  │ Coaching Engine             │  │  │
│  │  ┌──────────────────────┐  │  │  │  │ - rule_engine.rs            │  │  │
│  │  │ Components           │  │  │  │  │ - advice_generator.rs       │  │  │
│  │  │ - LockedFeature      │  │  │  │  │ - metrics_aggregator.rs     │  │  │
│  │  │ - AdSlot             │◄─┼──┼──┼──┤                              │  │  │
│  │  │ - SkillRadar         │  │  │  │  └──────────────────────────────┘  │  │
│  │  │ - ProBadge           │  │  │  │                                    │  │
│  │  └──────────────────────┘  │  │  │  ┌──────────────────────────────┐  │  │
│  │                            │  │  │  │ Storage                     │  │  │
│  └────────────────────────────┘  │  │  │ - history_db.rs (SQLite)    │  │  │
│                                  │  │  │ - cache_manager.rs          │  │  │
│                                  │  │  └──────────────────────────────┘  │  │
│                                  │  └────────────────────────────────────┘  │
├──────────────────────────────────┴──────────────────────────────────────────┤
│                            IPC (Tauri Commands)                              │
│  get_license_status / import_license / start_analysis / get_history / ...   │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
                    ┌──────────────────────────────────┐
                    │         Local File System         │
                    │  - license.dat                    │
                    │  - history.db                     │
                    │  - cache/ (temp frames)           │
                    │  - models/ (YOLO weights)         │
                    └──────────────────────────────────┘
```

---

## 2. モジュール間依存関係

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   License   │────▶│  Analysis   │────▶│  Coaching   │
│   Module    │     │  Pipeline   │     │   Engine    │
└─────────────┘     └─────────────┘     └─────────────┘
      │                   │                   │
      │                   │                   │
      ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────┐
│                    Storage Layer                     │
│            (SQLite + File System)                    │
└─────────────────────────────────────────────────────┘
```

### 依存方向

| From | To | 依存内容 |
|------|-----|---------|
| Analysis Pipeline | License Module | Pro機能フラグ取得（高精度モデル使用可否） |
| Coaching Engine | License Module | Proアドバイス生成可否 |
| Coaching Engine | Analysis Pipeline | 検出結果データ |
| Frontend | All Backend Modules | IPC経由でのデータ取得・操作 |

---

## 3. データフロー

### 3.1 解析実行フロー

```
[ユーザー]
    │
    ▼ (1) 動画選択
[VideoImport Page]
    │
    ▼ (2) start_analysis IPC
[Analysis Pipeline]
    │
    ├─▶ (3a) License確認 ──▶ [License Module]
    │         │
    │         ▼
    │     モデル選択（Free: 標準 / Pro: 高精度）
    │
    ├─▶ (3b) 動画読み込み ──▶ フレーム抽出
    │
    ├─▶ (3c) YOLO推論 ──▶ 検出結果
    │
    └─▶ (3d) イベント検出 ──▶ イベントログ
              │
              ▼
[Coaching Engine]
    │
    ├─▶ (4a) ルール適用 ──▶ アドバイス生成
    │
    └─▶ (4b) 統計計算（Pro）──▶ 詳細分析
              │
              ▼
[Storage] ←── (5) 結果保存
              │
              ▼
[AnalysisResults Page] ←── (6) 結果表示
```

### 3.2 ライセンス検証フロー

```
[アプリ起動]
    │
    ▼
[license.dat 読み込み]
    │
    ├─▶ ファイルなし ──▶ Free Mode
    │
    ├─▶ 署名無効 ──▶ Free Mode + Error Log
    │
    ├─▶ 期限切れ ──▶ Free Mode + 更新案内
    │
    └─▶ 有効 ──▶ Pro Mode
              │
              ▼
[LicenseContext 更新] ──▶ [UI状態反映]
```

---

## 4. 実装フェーズ定義

### Phase 1: 基盤構築（最優先）

**目標**: アプリの骨格を完成させ、Free版の基本機能を動作させる

| 順序 | タスク | 担当領域 | 依存 |
|------|--------|----------|------|
| 1-1 | Tauriプロジェクト初期化 | 共通 | なし |
| 1-2 | React基本構造 + ルーティング | UI | 1-1 |
| 1-3 | License Module (検証ロジック) | Backend | 1-1 |
| 1-4 | LicenseContext + useLicense | Frontend | 1-2, 1-3 |
| 1-5 | 画面スケルトン（6画面） | UI | 1-2 |
| 1-6 | LockedFeature コンポーネント | UI | 1-4 |
| 1-7 | SQLite初期化 + 履歴スキーマ | Storage | 1-1 |

**Phase 1 完了条件**:
- アプリが起動し、画面遷移が動作する
- ライセンスファイルでFree/Pro切り替えが動作する
- ロックUIが正しく表示される

---

### Phase 2: 解析コア機能

**目標**: 動画解析の一連のフローを完成させる

| 順序 | タスク | 担当領域 | 依存 |
|------|--------|----------|------|
| 2-1 | 動画読み込み + フレーム抽出 | Backend | 1-7 |
| 2-2 | YOLO推論統合（ort/onnxruntime） | Backend | 2-1 |
| 2-3 | イベント検出ロジック | Backend | 2-2 |
| 2-4 | VideoImport UI完成 | Frontend | 1-5, 2-1 |
| 2-5 | AnalysisProgress UI + 進捗表示 | Frontend | 2-3 |
| 2-6 | 広告スロット（Free版） | Frontend | 2-5 |
| 2-7 | 解析結果保存 | Storage | 2-3 |

**Phase 2 完了条件**:
- 動画を選択して解析が実行できる
- 解析中にプログレスが表示される
- 解析結果がDBに保存される

---

### Phase 3: コーチング機能 + 仕上げ

**目標**: AI コーチング機能を追加し、MVP完成

| 順序 | タスク | 担当領域 | 依存 |
|------|--------|----------|------|
| 3-1 | ルールエンジン実装 | Backend | 2-3 |
| 3-2 | アドバイス生成（Free: 3項目） | Backend | 3-1 |
| 3-3 | AnalysisResults UI完成 | Frontend | 2-7, 3-2 |
| 3-4 | Dashboard UI（サマリー表示） | Frontend | 2-7 |
| 3-5 | History UI | Frontend | 2-7 |
| 3-6 | Settings UI + ライセンス入力 | Frontend | 1-4 |
| 3-7 | Pro統計分析（デス位置等） | Backend | 3-1 |
| 3-8 | 課金導線UI | Frontend | 1-6 |

**Phase 3 完了条件**:
- 解析後にAIアドバイスが表示される
- ダッシュボードに履歴サマリーが表示される
- Pro版の全機能が動作する

---

## 5. MVPで「作らないもの」

### 5.1 明確に除外する機能

| 機能 | 除外理由 | 将来対応 |
|------|----------|---------|
| オンラインライセンス認証 | ローカル完結要件 | Phase 2+ (オプショナル) |
| 複数ゲームタイトル対応 | 複雑性増大 | 1ゲームで検証後に拡張 |
| リアルタイム解析（ライブ） | 技術的難易度高 | 録画解析で価値検証後 |
| クラウドバックアップ | ローカル完結要件 | 将来検討 |
| チーム/マルチユーザー | スコープ外 | 将来検討 |
| カスタムYOLOモデル学習 | 運用負荷大 | 事前学習済みモデル使用 |
| 動画編集・クリップ作成 | コア機能外 | 将来検討 |
| ソーシャル共有 | MVP不要 | 将来検討 |

### 5.2 簡略化する機能

| 機能 | MVP実装 | フル実装（将来） |
|------|---------|-----------------|
| ゲーム自動検出 | 手動選択のみ | 画面認識で自動 |
| 解析プリセット | Basic固定 | Custom（Pro） |
| 言語対応 | 日本語のみ | 多言語 |
| テーマ | ダークのみ | ライト/ダーク |
| エクスポート形式 | JSON only | PDF/CSV/JSON |
| 広告SDK | プレースホルダー | AdMob統合 |

### 5.3 実装するが制限する機能

| 機能 | Free | Pro (MVP) |
|------|------|-----------|
| 解析回数 | 無制限（MVP） | 無制限 |
| 履歴保存 | 10件 | 無制限 |
| AIアドバイス | 3件/解析 | 無制限 |
| ヒートマップ | × | ○ |
| エクスポート | × | JSON |

---

## 6. 技術的リスクと回避策

### 6.1 高リスク項目

| リスク | 影響度 | 発生確率 | 回避策 |
|--------|-------|----------|--------|
| YOLO推論パフォーマンス不足 | 高 | 中 | GPU対応必須化 / モデル軽量化 / フレームスキップ |
| Tauri + ONNX Runtime統合困難 | 高 | 中 | ort crateで検証済み / フォールバック: Python subprocess |
| 動画デコード互換性 | 中 | 高 | ffmpeg依存（バンドル） / 対応形式限定 |
| ライセンス署名鍵漏洩 | 高 | 低 | 秘密鍵は配布物に含めない / 公開鍵のみ埋め込み |

### 6.2 中リスク項目

| リスク | 影響度 | 発生確率 | 回避策 |
|--------|-------|----------|--------|
| メモリ使用量過多（長時間動画） | 中 | 中 | ストリーミング処理 / チャンク分割 |
| クロスプラットフォーム差異 | 中 | 中 | Windows優先 / macOS後回し |
| YOLO検出精度不足 | 中 | 中 | 閾値調整可能に / ユーザーフィードバック収集 |
| 広告SDK統合 | 低 | 中 | MVP: プレースホルダーで代替 |

### 6.3 リスク軽減アクション

| アクション | 対象リスク | タイミング |
|------------|-----------|-----------|
| YOLO推論PoC実施 | パフォーマンス | Phase 1開始前 |
| 動画デコードライブラリ選定 | 互換性 | Phase 1 |
| メモリプロファイリング | メモリ過多 | Phase 2 |
| Windows環境での統合テスト | プラットフォーム差異 | 各Phase終了時 |

---

## 7. 技術スタック確定

### 7.1 Frontend

| 領域 | 選定技術 | 理由 |
|------|----------|------|
| フレームワーク | React 18 | 要件通り |
| 言語 | TypeScript 5 | 要件通り |
| 状態管理 | React Context + useReducer | 軽量、追加ライブラリ不要 |
| スタイリング | Tailwind CSS | 高速開発、一貫性 |
| チャート | Recharts | React統合、軽量 |
| ルーティング | React Router v6 | デファクト |

### 7.2 Backend (Rust)

| 領域 | 選定技術 | 理由 |
|------|----------|------|
| フレームワーク | Tauri 2.x | 要件通り |
| ML推論 | ort (ONNX Runtime) | Rustネイティブ、GPU対応 |
| 動画処理 | ffmpeg-next | 安定、対応形式多 |
| DB | SQLite (rusqlite) | ローカル完結、組み込み |
| 署名検証 | ed25519-dalek | 高速、安全 |
| シリアライズ | serde_json | デファクト |

### 7.3 ビルド・配布

| 領域 | 選定技術 |
|------|----------|
| バンドラ | Vite |
| パッケージ形式 | MSI (Windows) / DMG (macOS) |
| 自動更新 | Tauri Updater（将来） |

---

## 8. ファイル構成（参考）

```
esports-coach/
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   ├── license/
│   │   │   ├── mod.rs
│   │   │   ├── types.rs
│   │   │   ├── verify.rs
│   │   │   └── state.rs
│   │   ├── analysis/
│   │   │   ├── mod.rs
│   │   │   ├── video_loader.rs
│   │   │   ├── yolo_inference.rs
│   │   │   ├── frame_processor.rs
│   │   │   └── event_detector.rs
│   │   ├── coaching/
│   │   │   ├── mod.rs
│   │   │   ├── rule_engine.rs
│   │   │   ├── advice_generator.rs
│   │   │   └── metrics.rs
│   │   ├── storage/
│   │   │   ├── mod.rs
│   │   │   ├── db.rs
│   │   │   └── cache.rs
│   │   └── commands.rs
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/
│   ├── pages/
│   │   ├── Dashboard.tsx
│   │   ├── VideoImport.tsx
│   │   ├── AnalysisProgress.tsx
│   │   ├── AnalysisResults.tsx
│   │   ├── History.tsx
│   │   └── Settings.tsx
│   ├── components/
│   │   ├── common/
│   │   │   ├── LockedFeature.tsx
│   │   │   ├── ProBadge.tsx
│   │   │   └── AdSlot.tsx
│   │   ├── dashboard/
│   │   ├── analysis/
│   │   └── results/
│   ├── contexts/
│   │   ├── LicenseContext.tsx
│   │   ├── AnalysisContext.tsx
│   │   └── HistoryContext.tsx
│   ├── hooks/
│   │   ├── useLicense.ts
│   │   ├── useAnalysis.ts
│   │   └── useHistory.ts
│   ├── App.tsx
│   └── main.tsx
├── package.json
└── vite.config.ts
```

---

## 9. 各エージェント成果物との対応

| エージェント | 成果物 | 本仕様での反映箇所 |
|-------------|--------|-------------------|
| LicenseMonetizationAgent | license-monetization.md | セクション3.2, Phase 1-3/1-4 |
| UIUXAgent | screens.md | セクション1 (UI Layer), Phase 1-5 |
| UIUXAgent | pro-locked-ui.md | Phase 1-6 |
| UIUXAgent | ad-slot.md | Phase 2-6 |
| UIUXAgent | monetization.md | Phase 3-8 |
| CoachingLogicAgent | coaching-logic.md | セクション3.1, Phase 3-1/3-2/3-7 |
| AnalysisPipelineAgent | (未作成) | Phase 2-1/2-2/2-3 で要定義 |

---

## 10. 未解決事項・要確認

| 項目 | 内容 | 担当 |
|------|------|------|
| 対象ゲームタイトル | MVP対象の1タイトルを確定 | プロダクト判断 |
| YOLOモデル選定 | YOLOv8n / YOLOv5s 等の具体選定 | AnalysisPipelineAgent |
| 動画形式サポート範囲 | MP4/MOV/AVI どこまで | AnalysisPipelineAgent |
| 広告ネットワーク | AdMob / Carbon Ads / 自前 | プロダクト判断 |
| ライセンス購入フロー | 外部決済 or 手動発行 | プロダクト判断 |

---

## 変更履歴

| 日付 | 変更者 | 内容 |
|------|--------|------|
| 2025-01-22 | OrchestratorAgent | 初版作成 |
