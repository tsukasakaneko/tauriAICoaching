# SABR 相当の VALORANT リプレイ解析機能 実装プラン

> このドキュメントは、SABR (VALORANT 向けリプレイ分析ツール) と同等以上の機能を `tauriAICoaching` に組み込むためのマスタープラン。
> 進捗管理は GitHub Issue を Single Source of Truth として行う。本書は設計の出典であり、サブタスクの状態は Issue 側で更新する。

## Context

きっかけは `@fps_g33ks` のツイートで紹介された **SABR**（元 100 Thieves 関係者 Joseph Jang 開発、VCT デモを公開した先進リプレイ分析ツール）。自然言語シーン検索、2D 俯瞰ミニマップ＋プレイヤー行動履歴／デス位置、ラウンド自動書き出し、スクリム分析を備えており、現存の `tauriAICoaching`（テキストレポートのみの AI コーチング）にとって直接の競合になり得る。

ユーザーの意図は **「個人用 PoC として SABR と同等以上を作り、そのまま製品化する」**。再学習・両入力ソース（ライブキャプチャ＋VOD アップロード）を許可。コスト制約（≈¥4/解析 の Claude 予算）と Japanese-only UI、既存ライセンス／クレジット階層は維持する。

ゴール: 既存の YOLOv8/ffmpeg/Tauri/Claude 基盤を最大活用し、フェーズ単位で動くものを順次出しながら、最終的に「ラウンドごとのミニマップ全員行動 + 自然言語検索 + VOD/スクリム解析」を提供する。

## 現状コードの再利用ポイント

- `backend/services/yoloInference.js` — ONNX + sharp の汎用推論基盤 (`detectObjects(buf, modelName, classes)`)。新モデルは `src-tauri/resources/models/*.onnx` に置くだけで動く。`SIMULATE_YOLO` スタブ機構も継承。
- `backend/services/videoAnalyzer.js:16-33` — `extractFrames(videoPath, outDir, intervalSecs)` 既存。`intervalSecs=0.5` に変更すれば 2fps。
- `backend/services/minimapAnalyzer.js` — `player_dot` 検出済み。ただし出力は集約値のみ。`processFrame` を `{x,y,frameIdx}` を返す形に拡張する。
- `backend/services/killfeedAnalyzer.js` — rising-edge でキル検出済み。イベント emit に拡張。
- `backend/services/resultAnalyzer.js` — Tesseract OCR ロジック流用可（HUD スコア OCR で再利用）。
- `backend/db.js` — SQLite + WAL + マイグレーション例あり。新テーブルは末尾に `IF NOT EXISTS` で追加。
- `src-tauri/src/ai_provider.rs:133-198`, `src-tauri/src/prompt_builder.rs` — Claude 呼び出し基盤。検索クエリ翻訳は同じ機構で別プロンプト追加。
- `src-tauri/src/license.rs` — credit 消費／cloud-tier ゲートを新機能にそのまま流用。
- `src/App.tsx` の Screen state-machine — 新画面追加だけで済む構造。

## セッション間トラッキング（GitHub Issues）

セッションが分かれても「今どこまで進んだか／次の一手は何か」が誰でも (= 別 Claude セッションでも) 分かるよう、**GitHub Issue を Single Source of Truth** にする。

**初回セッション（このプラン承認直後）でやること**:

1. **親エピック Issue を作成**（タイトル例: `[Epic] SABR 相当のリプレイ解析機能`）
   - 本文に「目的」「Phase 一覧へのリンク」「現在のフェーズ」を記載
   - ラベル `epic`, `feature:replay-analysis`
2. **Phase 0〜6 を子 Issue として作成** (計 7 個)
   - タイトル: `[Phase N] <フェーズ名>`
   - 本文 = 本プランの該当フェーズ節をコピー + サブタスクの GitHub チェックボックス (`- [ ]`) 化
   - 親 Issue から `- [ ] #<issue番号>` で参照
   - ラベル `feature:replay-analysis`, `phase:N`
3. 親 Issue を Pin する（リポジトリ Issue タブで常に上に来るように）

**セッション開始時の固定プロトコル**（このプラン承認後、毎セッション冒頭）:

1. `mcp__github__list_issues` で `label: feature:replay-analysis` を引き、親エピックと「open かつ最も Phase 番号の小さい子 Issue」を特定
2. 該当子 Issue を `mcp__github__issue_read` で読み、未チェックの先頭タスクを次の一手にする
3. ユーザーに「今 Phase N のサブタスク `<...>` から再開します」と一文で報告してから着手

**コミット粒度**:

- サブタスク 1〜数個ごとにコミット（≦半日分）
- コミットメッセージ末尾に `Refs #<issue番号>` を必ず付ける（Closes は使わず、全サブタスクが終わったタイミングで手動 close）
- PR を切る場合は本文に `Refs #<issue番号>` + 進捗チェックリスト更新を含める

**進捗反映**:

- コミット／PR をプッシュした後、`mcp__github__issue_write` で対応する子 Issue 本文のチェックボックスを `- [x]` に更新
- フェーズ完了時、子 Issue をクローズし、親エピックの該当行も `- [x]` に
- 「ブロッカー」が発生したら子 Issue 末尾に `### Blockers` セクションを追記（次セッションが即座に気付ける）

**対象リポジトリ**: `tsukasakaneko/tauriaicoaching`

## 着手前のデリスク（Phase 0）

**最大のリスクは「10 個のミニマップドット（味方 5・敵 5）を再学習なしで／再学習しても安定識別できるか」**。これが崩れると Phase 4 全体が破綻し、SABR 同等を名乗れない。

`research/minimap_dot_spike.ipynb` を作って 1 日で答えを出す:

1. 既存録画から 200 ミニマップクロップを 2fps 抽出
2. `ally_dot` / `enemy_dot` / `local_player_dot` / `dead_marker` を手動ラベル
3. Colab で YOLOv8n を fine-tune し、クラス別 mAP を測定
4. `enemy_dot` mAP < 0.7 なら **HSV 色バケット + ハンガリアン法のトラッキング** にフォールバック（個別 ally の再識別は諦め、「味方 5 連続軌跡」と「敵は見えた瞬間だけ点」で出す）

この結果で Phase 4 のスコープと工数が確定する。

## Phase 1 — 時系列イベントログ + マップ自動判別

**ゴール**: 1 試合解析するごとに、フレーム単位のタイムスタンプ・正規化座標・キル/デスイベント・検出マップ名が DB に残る。`VideoAnalysisResult` の集約値は従来通り。手動 SQL で確認可能。

- 新テーブル（`backend/db.js` 末尾に追加）:
  - `match_events(id, session_id, frame_idx, t_ms, event_type, payload_json)` — index `(session_id, t_ms)`
  - `match_meta(session_id PK, map_name, agent, ally_side_initial)`
- `backend/services/videoAnalyzer.js:47` のサンプリングを `0.5`（=2fps）へ。L59 の minimap stride を撤去。`sessionId` を引数に追加。
- 新規 `backend/services/eventLog.js`（500 行ごとの transaction batch writer）
- 新規 `backend/services/mapDetector.js` + `valorant_map` ONNX classifier（入力 224×224, 8 クラス: bind/ascent/haven/split/lotus/sunset/icebox/abyss から現ローテに合わせる。**最終ローテはユーザーに確認**）。`yoloInference.js:62-82` の softmax パターンをコピー。最初の 30 in-match フレームで多数決。
- `backend/routes/autorecord.js` を `sessionId` 伝播に対応。

**学習データ**: マップ分類器 = 8 マップ × 約 150 静止フレーム ≈ 1,200 枚。ユーザー録画 + VCT VOD から収集。`~/datasets/valorant_map/{train,val}/{name}/`。YOLOv8n-cls を Colab で <2h。

**リスク**: 2fps × 30 分試合 ≈ 3,600 フレーム → ONNX ~50ms × 11 種 で約 3 分／試合。許容範囲。tmp 容量は約 4 倍に増えるので、起動時の orphan sweep を追加。

**検証**: 1 試合走らせ、`SELECT event_type, COUNT(*) FROM match_events WHERE session_id=? GROUP BY event_type` で position 約 3600 / kill/death が result OCR と一致 / `match_meta.map_name` が実際のマップと合うことを確認。

## Phase 2 — 自分の位置軌跡を出すミニマップ UI

**ゴール**: 完了したセッションを開くと、対応マップ PNG 上に自分の position polyline と death マーカーが描画される。時間スライダーで時間範囲フィルタ。

- `src/types.ts` の `Screen` に `"replay"` 追加 + `MatchEvent` / `MapName` / `ReplayData` 型追加
- 新規 `src/components/ReplayScreen.tsx` + `src/components/MinimapCanvas.tsx`（HTML canvas）+ `src/hooks/useMatchEvents.ts`
- `src/components/ReportScreen.tsx` に「リプレイを見る」ボタン
- `backend/routes/autorecord.js` に `GET /api/sessions/:id/events`
- `src-tauri/resources/maps/{bind,ascent,...}.png` のキャリブレーション済みマップ画像

**リスク（最重要）**: `minimapAnalyzer.js:18-21` の 0-1 正規化は **YOLO 640×640 クロップ基準**で、ゲーム内ミニマップ座標系ではない。マップごとにアフィン変換（rotate/scale/translate）が必要。VALORANT の「ミニマップ回転オフ」設定をユーザー側で固定する前提にし、マップごとに校正用スクショ 1 枚で平行移動 + スケールを決める。

**検証**: 既知の試合（A サイト lurk が分かっているもの）でリプレイし、軌跡がコールアウトに沿うことを目視確認。

## Phase 3 — ラウンド分割 + バイフェーズ／スパイクイベント検出

**ゴール**: ReplayScreen にラウンド選択ドロップダウン（R1〜R24）。バイフェーズ／アクション／設置済の局面ラベルが表示される。

- 新テーブル `match_rounds(session_id, round_idx, t_start_ms, t_end_ms, phase_changes_json, outcome)`
- 新規 `backend/services/roundSegmenter.js` + `backend/services/roundUiDetector.js`
- 新モデル `valorant_round_ui`（クラス: `buy_menu`, `spike_planted_banner`, `spike_defused_banner`, `round_start_countdown`, `round_won_banner`, `round_lost_banner`）
- HUD スコア OCR を `resultAnalyzer.js` の Tesseract セットアップ流用で実装、ラウンド境界の ground truth に
- `backend/routes/autorecord.js` の events エンドポイントに `?round=N` クエリ
- `ReplayScreen` にラウンドドロップダウン + フェーズラベル（「バイフェーズ」「アクション」「スパイク設置済」）

**学習データ**: round_ui 検出器 = 6 クラス × 約 100 枚 ≈ 600 枚。`spike_planted_banner` のリコール重視（false negative で全フェーズ判定が壊れる）。`~/datasets/valorant_round_ui/`。YOLOv8s を学習。

**リスク**: スコア OCR が `1-O` / `1-0` を取り違える → Tesseract whitelist を数字限定、monotonic 増加のみ accept。OT (R25+) は別途分岐。

**検証**: 手動カウント済み試合で segmenter のラウンド数・勝利数が一致。

## Phase 4 — 10 人トラッキング（または 5+5 グレースフル劣化）

**ゴール**: 1 ラウンド内で最大 10 ドットの軌跡がチーム別配色で出る。Phase 0 の結果次第で、個別 ally 再識別が無理なら「5 ally 軌跡 + 敵は見えた瞬間の点」に縮退。

- `valorant_minimap` 再学習（クラス: `local_player`, `ally_dot`, `enemy_dot`, `dead_marker`）
- 新規 `backend/services/multiPlayerTracker.js` — フレーム間ハンガリアン割当（距離 + 色類似度）。`actor_id ∈ {self, ally_1..4, enemy_1..5}`（ラウンドごとにリセット）
- `match_events.payload_json` に `actor_id`, `team` を含める
- `minimapAnalyzer.js` を大幅書き換え
- `MinimapCanvas.tsx` をマルチ軌跡レンダリング + 個別 ON/OFF チェックボックス

**学習データ（プロジェクト中最大）**: minimap 再学習 = 8 マップ × 250 ≈ 2,000 ミニマップクロップ、Roboflow/CVAT で全可視ドットを box ラベル。`~/datasets/valorant_minimap_v2/`。

**リスク**: スモーク中の track break / 敵オクルージョン → break イベントを許容し、新 ID から再追跡。Phase 0 の結果でスコープが ±数週変動。

**検証**: 既知ラウンド VOD と並べて 10 軌跡が実際の動きと一致するか目視。

## Phase 5 — 自然言語シーン検索

**ゴール**: ReplayScreen 上部の検索バーに「Bindで初接触したラウンド」「スパイク設置後に死んだ場面」と入力 → 結果リスト → クリックで動画の該当タイムスタンプへシーク。

- SQLite **FTS5**（外部ベクタストア不要）で `event_index_fts`。各行 = 1 イベントの可読サマリー文字列（`"R3 ascent buy enemy_first_contact mid 0:42"`）。日本語は trigram tokenizer
- 新規 `backend/routes/search.js`: ユーザークエリを **Claude 1 呼び出し**で `(map, round_phase, event_type, actor_team, round_idx)` の SQL WHERE 句 JSON に翻訳 → FTS5 と join 実行
- `src-tauri/src/prompt_builder.rs` に `SearchTranslationPrompt` モード追加（system prompt は cache 化）
- 新規 `src/components/SearchBar.tsx` + `ReplayScreen` に HTML5 `<video>` 埋め込み（`recording_path` を `currentTime=t_ms/1000` でシーク）
- `src-tauri/src/license.rs` 既存ゲートで cloud-tier 限定

**コスト**: ¥0.5/クエリ × 50 cloud ユーザー × 10 クエリ/日 ≈ ¥7,500/月。`BUSINESS_PLAN.md` 余裕内。

**検証**: 手作りクエリ 10 個で 7 個以上が「明らかに正しい結果」をトップに返すこと。

## Phase 6 — VOD アップロード + スクリムモード + 製品化仕上げ

**ゴール**: `.mp4` をドラッグ＆ドロップして同じ解析が走る。cloud-tier ユーザーは 2 POV をアップロードしてスパイク設置時刻でアラインしたスクリム解析もできる。

- 新 Screen `"vod_upload"`、`src/components/VodUploadScreen.tsx`、ドラッグ＆ドロップ + バリデーション（<2 GB, mp4/mkv/webm）
- `match_sessions` に `source ('live_capture' | 'vod_upload' | 'scrim_merged')`, `parent_session_id` 追加
- `backend/routes/autorecord.js` に multipart アップロード対応 → 録画ディレクトリにコピー → 既存 `analyzeVideo` パイプラインに合流
- スクリムマージ: 両 POV を独立解析後、スパイク設置タイムスタンプで時間オフセット推定 → イベントログを join。失敗時は手動オフセットスライダーにフォールバック
- ライセンス: VOD = 2 クレジット（自動録画と同等）、スクリムマージ = 4 クレジット。`src-tauri/src/license.rs` で消費
- `BUSINESS_PLAN.md` に「VOD Replay Analysis」セクション追記 + 改訂コストモデル

**重要制約**: VOD 解析は **必ずローカル Node backend** で実行。Render 側に動画を上げない（帯域コスト不可）。Render は auth/license と Phase 5 の検索翻訳 LLM 呼び出しのみ。

**検証**: 同一試合でライブキャプチャと VOD アップロードを並走比較 → 結果が ±2 kills 以内で一致。

## 横断的な決定事項

- **後方互換**: 各フェーズで既存 `VideoAnalysisResult` 集約は維持。新機能はすべて加算的。既存 ReportScreen は壊れない。
- **計算ローカル主義**: ONNX/ffmpeg/Tesseract は全てローカル Node backend。Render は軽量 API のみ。
- **日本語 UI**: 新規 UI 文字列は全て日本語。マップ名は Bind/Ascent などローマ字（コミュニティ慣習に合わせる）。
- **コスト**: Phase 1-4 で /解析 Claude コスト不変（¥4）。Phase 5 で検索 ¥0.5/query（cloud-tier 限定）。

## 修正・新規ファイル一覧（主要のみ）

- 修正: `backend/services/videoAnalyzer.js`, `backend/services/minimapAnalyzer.js`, `backend/services/yoloInference.js`, `backend/services/killfeedAnalyzer.js`, `backend/db.js`, `backend/routes/autorecord.js`, `src/App.tsx`, `src/types.ts`, `src/components/ReportScreen.tsx`, `src-tauri/src/ai_provider.rs`, `src-tauri/src/prompt_builder.rs`, `src-tauri/src/license.rs`, `BUSINESS_PLAN.md`
- 新規 backend: `backend/services/eventLog.js`, `backend/services/mapDetector.js`, `backend/services/roundSegmenter.js`, `backend/services/roundUiDetector.js`, `backend/services/multiPlayerTracker.js`, `backend/routes/search.js`
- 新規 frontend: `src/components/ReplayScreen.tsx`, `src/components/MinimapCanvas.tsx`, `src/components/SearchBar.tsx`, `src/components/VodUploadScreen.tsx`, `src/hooks/useMatchEvents.ts`
- 新規アセット: `src-tauri/resources/maps/*.png`, `src-tauri/resources/models/{valorant_map,valorant_round_ui,valorant_minimap_v2}.onnx`
- 新規研究: `research/minimap_dot_spike.ipynb`
- データセット（リポジトリ外）: `~/datasets/valorant_map/`, `~/datasets/valorant_round_ui/`, `~/datasets/valorant_minimap_v2/`

## エンドツーエンド検証手順

各フェーズ完了時に以下を実行:

1. `npm run dev:all`（Vite + Node backend 同時起動）+ `npm run tauri dev`（Tauri シェル）
2. テスト用の既知録画（手動カウント済みのキル数・ラウンド数を持つ 1 試合）を流す
3. Phase ごとの DB クエリ／UI 表示を期待値と突き合わせる
4. `SIMULATE_YOLO=true` でモデル不在時のスタブ動作も並行確認
5. 製品化時（Phase 6 後）: 既存の Stripe/Render フローでクラウド購入 → ライセンスアクティベート → cloud-tier 限定機能が解放されることを実機確認
