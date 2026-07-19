# Riot API の MCP サーバ移行 + サブスク向け単体利用 — 実現可能性検討

検討日: 2026-07-19

## 依頼内容

1. AI が function calling で Riot API の使用判断を行う前提で、API の実行を MCP サーバからの呼び出しに移行する
2. サブスクプランのユーザーは、その MCP サーバを単体(Claude Desktop 等の外部 MCP クライアント)でも利用可能にする

## 結論: 実現可能

必要な部品はコードベースに全て揃っている:

- ローカル Riot アクセス層: `backend/services/riotLockfile.js` / `riotLocalApi.js` / `riotMatchData.js`
- ライセンス基盤: `backend-remote` の `/license/activate`・`/license/status` + license JWT(`src-tauri/src/commands/license.rs`)、Stripe・クレジット台帳
- サイドカーの `@anthropic-ai/sdk` ^0.92(tool runner 対応)。`@modelcontextprotocol/sdk` は lock ファイルに既存(strands-agents の推移的依存)
- ツール定義の移植元: `backend/services/strands-agent.mjs`(未接続コードだが Zod スキーマ・ツール定義が再利用可能)

### 前提の訂正

現在の本番コードでは **AI の function calling は使われていない**。出荷中のフローは「試合統計をプロンプトに埋め込んで 1 回投げる」single-shot 方式(`src-tauri/src/prompt_builder.rs` → Claude)。したがって本移行は「function calling の新規導入」と「ツール実行の MCP 化」をセットで行うことになる。

### 最重要制約

Riot データはローカルクライアント API(lockfile 経由の `127.0.0.1` + `pd.{shard}.a.pvp.net`)からしか取得できず、Riot 開発者 Web API キーは存在しない。つまり **データ取得はユーザー端末上で Riot クライアント起動中しか実行できない**。この制約から:

- MCP サーバは必ずローカル実行(クラウドホスト不可)
- ツール実行ループもローカルで回す必要がある
- クラウド AI 経路(Anthropic キーは backend-remote 保持)は「LLM 呼び出しだけリモートにプロキシし、ループはローカル」という設計になる

## リスクと対処

| リスク | 対処 |
|---|---|
| Riot クライアント未起動(lockfile なし) | 全ツールが throw せず `isError` + 日本語の対処メッセージを返す。`get_riot_status` ツールで AI が事前確認できるようにする |
| エンタイトルメントトークンの期限切れ | 既存の `getEntitlements()` が exp ベースのキャッシュ更新を実装済み。そのまま再利用 |
| 単体利用のサブスクゲートはクライアント側でしか強制できない | ソフトゲートとして許容。金銭価値のある資産(Anthropic キー・クレジット台帳)はサーバ側強制のまま。標準利用の機能ゲートとして十分 |
| Claude Desktop が起動する MCP プロセスと Tauri サイドカーの競合 | stdio はポート不使用。SQLite は WAL モード + MCP 側は read-only オープン。3001 にはバインドしない |
| LLM プロキシの悪用(汎用 Claude プロキシ化) | 有料ティア限定・分析セッションごとのターン上限(8)と TTL(15 分)・ツール名 allowlist・メッセージ/max_tokens サイズ上限・初回ターンでクレジット消費。無料ティアは従来の single-shot `/analyze` のまま |
| ESM/CJS 混在(backend は CommonJS、MCP SDK は ESM) | `strands-agent.mjs` と同じ `.mjs` + `createRequire` パターン |
| Rust でのツールループ実装の複雑さ | Rust には実装しない。ループは Node サイドカーに委譲。Ollama 経路はツール利用に不向きなので single-shot のまま |
| `fetchLatestMatchStats` の最大 72 秒リトライ | MCP 経路ではリトライ 1 回に短縮し、`waitForNewMatch` オプションで従来動作を選択可能に |
| 単体プロセスからの settings.json 探索 | Claude Desktop config に `COACHMATE_SETTINGS_PATH` env を書き込んで決定的にする(OS 別ディレクトリ探索はフォールバック) |

## 経路ごとの構成

| 経路 | LLM 呼び出し | ツールループ | ツール実行 |
|---|---|---|---|
| BYO キー | サイドカー → api.anthropic.com(キーは Rust から loopback で受領) | サイドカー | in-process |
| クラウド(managed) | サイドカー → backend-remote `/agent/messages` プロキシ | サイドカー | in-process |
| 無料ティア / Ollama | 変更なし(single-shot) | なし | なし |
| Claude Desktop 単体 | Claude Desktop 自身のモデル | Claude Desktop | stdio MCP サーバ(サブスクゲート付き) |

ポイント: アプリ内ループは自分自身に MCP プロトコルで接続せず、同じツールモジュールを in-process import する。ツール実装は 1 つ、アダプタ(in-process / stdio MCP)が 2 つという構成で、二重実装を避ける。

## アーキテクチャ

### 新規ファイル

- `backend/mcp/tools.js` (CJS) — ツール定義の単一ソース `[{name, description, inputSchema(zod), handler}]`。既存の `riotLocalApi` / `riotMatchData` / DB / `agent_knowledge.toml` をラップ
- `backend/mcp/server.mjs` — stdio MCP サーバ(`McpServer` + `StdioServerTransport`)。stdout への console.log は JSON-RPC を壊すため禁止(ログは stderr)
- `backend/mcp/license-gate.mjs` — settings.json から `license_token` を読み取り `/license/status` で検証。72 時間のオフライン猶予キャッシュ付き
- `backend/routes/agentAnalyze.js` — `POST /agent/analyze`。tool runner によるループ(mode: `byok` | `proxy`)、Zod で CoachingReport を検証し、失敗時 1 回だけ修復リトライ
- `src-tauri/src/commands/mcp.rs` — `install_claude_desktop_config` / `get_mcp_status`(claude_desktop_config.json へのマージ書き込み)
- `backend/test/mcp.test.js`

### 変更ファイル

- `backend/services/riotMatchData.js` — `pdRequest` を一般化して `fetchRecentMatches({count})` と `fetchMatchDetails(matchId)` を追加(`fetchLatestMatchStats` は不変)
- `backend/package.json` — `@modelcontextprotocol/sdk`・`zod` を直接依存に昇格
- `backend/server.js` — agentAnalyze ルータをマウント
- `backend-remote/server.js` — `POST /agent/messages` を追加(`requireLicense` 再利用、free 拒否、ターン上限、allowlist、初回ターンで `licenseStore.consume`)
- `src-tauri/src/commands/ai.rs` — Claude 分岐をサイドカー `/agent/analyze` に委譲(API キーは webview を経由させない)。サイドカー到達不能時は既存 `call_claude` にフォールバック。Ollama 分岐は不変
- `src/api.ts` — 有料ティアの `analyzeRemote` をサイドカー経由に変更。失敗時は従来 `/analyze` にフォールバック
- 設定画面 — 「Claude Desktop と連携」ボタン(有料ティアのみ)+ 設定 JSON の手動コピー

### MCP ツール一覧(9 個)

| ツール | 入力 | 内容 |
|---|---|---|
| `get_riot_status` | — | クライアント起動状態・presence・puuid・shard |
| `get_latest_match` | `waitForNewMatch?` | 直近試合の KDA・エージェント・マップ・ラウンド |
| `get_match_history` | `count 1–10` | 直近 N 試合のサマリ(新設 `fetchRecentMatches`) |
| `get_match_details` | `matchId` | 特定試合の自分の成績(新設 `fetchMatchDetails`) |
| `get_session_analysis` | `sessionId?` | `match_sessions.video_analysis_json`(DB read-only) |
| `get_session_events_summary` | `sessionId` | `match_events` の時間帯・ゾーン集約(トークン節約のため要約) |
| `get_coaching_history` | `limit 1–5` | 過去コーチングレポートのダイジェスト(進捗比較用) |
| `lookup_agent_knowledge` | `agentName` | エージェント知識(strands-agent.mjs から移植) |
| `lookup_rank_guidance` | `rank` | ランク別指針(同上、RANK_MAP 含む) |

### 単体利用のライセンスゲート

1. settings.json の場所: `COACHMATE_SETTINGS_PATH` env が第一候補、なければ OS 別の `com.coaching.valorant` ディレクトリを探索
2. `GET /license/status`(Bearer license_token)で検証。許可ティア: `cloud` / `pro`
3. 結果を 72 時間の猶予付きでキャッシュ(オフライン許容)。401 は即時失効
4. 検証失敗時もサーバ自体は起動し、全ツールが「単体利用にはサブスクまたは Pro ライセンスが必要。CoachMate アプリの設定画面でアクティベートしてください」という `isError` を返す(サーバが起動しないより UX が良い)

既存の license JWT(30 日、アプリ起動時に `refresh_status_from_server` で更新、デバイスバインド済み)をそのまま使うため、backend-remote に新エンドポイントは不要。

### 配布

backend ツリーは既に Tauri リソースに同梱される(`tauri.conf.json`)。`install_claude_desktop_config` コマンドが `claude_desktop_config.json` に以下をマージ書き込みする:

```json
{ "mcpServers": { "coachmate-valorant": {
    "command": "node",
    "args": ["<resources>/backend/mcp/server.mjs"],
    "env": {
      "COACHMATE_SETTINGS_PATH": "<abs settings.json>",
      "REMOTE_API_URL": "https://<render-host>",
      "DB_PATH": "<abs coaching.db>"
    } } } }
```

システム Node ≥18 が前提(既存アプリのサイドカー起動と同じ要件)。npm/npx 配布(`npx @coachmate/valorant-mcp`)は将来オプション — ライセンスファイル依存があるため v1 はアプリインストール前提が妥当。

## 実装フェーズ(各フェーズ単体で出荷可能)

- **Phase 0 — ツール抽出**(挙動変更なし): `mcp/tools.js` 作成 + `riotMatchData.js` 拡張。検証: `node --test backend/test/`(`mockRiotServers.js` に複数試合履歴モックを追加)
- **Phase 1 — stdio MCP サーバ**(dev 用 `MCP_SKIP_LICENSE=1`): 検証: MCP Inspector(`npx @modelcontextprotocol/inspector node backend/mcp/server.mjs`)+ SDK stdio クライアントの round-trip テスト + Claude Desktop 手動確認
- **Phase 2 — ライセンスゲート + Claude Desktop 連携 UI**: 検証: dev キーで許可 / 拒否 / オフライン猶予 / 失効の 4 ケース
- **Phase 3 — アプリ内 function calling(BYO キー経路)**: 検証: `cargo build` + 実キー E2E(Riot 起動時にツール呼び出し結果がレポートに反映、Riot 停止時は graceful degradation)、Ollama・無料ティアの回帰確認
- **Phase 4 — クラウド経路**(`/agent/messages` プロキシ + `mode:'proxy'`): 検証: クレジットが 1 分析 1 回だけ消費されること、ターン上限・allowlist の拒否動作、無料ティア不変、Render ステージング
- **Phase 5(任意)**: ローカル Streamable HTTP MCP エンドポイント、structured outputs、プロキシ側 prompt caching、npx 配布

## 検討時の前提(要確認)

- function calling は今回新規導入する(strands-agent はツール定義・Zod スキーマの移植元として利用)
- 単体利用は stdio(Claude Desktop)主体
- ゲートはサーバ検証 + オフライン猶予
- 対象は BYO・クラウド両経路(フェーズ分割で段階導入)
