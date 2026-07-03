# CoachMate for VALORANT

VALORANT プレイヤー向けの日本語専用 AI コーチング・デスクトップアプリ(Tauri 製)。
試合後の録画を YOLOv8 でローカル解析し、Claude によるパーソナライズされたコーチングレポート
(改善点・根本原因・7日間トレーニングプラン)を生成します。

## 主な機能

- **手動AIコーチング**: ランク・エージェント・自己評価・振り返りからレポート生成
- **自動録画・解析**: 試合を自動録画し、KDA・HS率・ポジショニング等をローカルで計測(録画データは外部へ送信しません)
- **リプレイ解析**: ミニマップ上の行動履歴の可視化(開発中)
- **ライセンス/クレジット制**: 無料は手動分析 1日3回。有料はクレジット消費(手動1・自動録画2)

## 開発ポリシー(Riot サードパーティポリシー準拠)

- **試合中のリアルタイム助言機能は今後も実装しません。** 本アプリは試合後の VOD 解析・コーチングに徹します。
  ゲームプレイ中に競争上の優位を与えるオーバーレイ・自動化・リアルタイム支援は開発対象外です。
- ゲームクライアントのメモリ読み取り・改変・入力自動化は行いません。解析は画面録画の事後処理のみです。

## 開発

```bash
npm install          # フロントエンド依存
cd backend && npm install    # ローカル解析バックエンド
npm run tauri dev    # 開発起動
```

リモートAPI(ライセンス台帳・クラウド分析)は `backend-remote/` を参照(Render にデプロイ)。

## 法務ドキュメント

販売に関する法務文書は `docs/legal/` に置いています(購入 LP(P1-12)から掲載・リンクします)。

- [特定商取引法に基づく表記](docs/legal/tokushoho.md)
- [返金ポリシー](docs/legal/refund-policy.md)
- [プライバシーポリシー](docs/legal/privacy-policy.md)

※ 事業者情報のプレースホルダ(【】)は販売開始前に記入してください。

## 法的表記

CoachMate for VALORANT は Riot Games によって承認・後援されたものではなく、Riot Games または
VALORANT の制作・管理に公式に関与するいかなる者の見解も反映するものではありません。
VALORANT および Riot Games は Riot Games, Inc. の商標または登録商標です。

CoachMate for VALORANT is not endorsed by Riot Games and does not reflect the views or opinions of
Riot Games or anyone officially involved in producing or managing Riot Games properties. Riot Games
and VALORANT are trademarks or registered trademarks of Riot Games, Inc.
