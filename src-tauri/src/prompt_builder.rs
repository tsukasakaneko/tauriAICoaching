use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct AnalyzePayload {
    pub rank: String,
    pub agent: String,
    #[serde(rename = "selfAssessment")]
    pub self_assessment: Vec<String>,
    pub review: String,
    #[serde(rename = "videoAnalysis")]
    pub video_analysis: Option<VideoAnalysisData>,
}

#[derive(Debug, Deserialize)]
pub struct VideoAnalysisData {
    pub kills: Option<u32>,
    pub deaths: Option<u32>,
    pub assists: Option<u32>,
    #[serde(rename = "headshotRate")]
    pub headshot_rate: Option<f32>,
    #[serde(rename = "damageDealt")]
    pub damage_dealt: Option<u32>,
    #[serde(rename = "abilityKills")]
    pub ability_kills: Option<u32>,
    #[serde(rename = "dominantZone")]
    pub dominant_zone: Option<String>,
    pub aggressiveness: Option<f32>,
    #[serde(rename = "deathsInLateRound")]
    pub deaths_in_late_round: Option<u32>,
    #[serde(rename = "longestLoseStreak")]
    pub longest_lose_streak: Option<u32>,
    #[serde(rename = "totalRounds")]
    pub total_rounds: Option<u32>,
    #[serde(rename = "wonRounds")]
    pub won_rounds: Option<u32>,
}

pub fn build_system_prompt() -> String {
    r#"あなたはValorantのプロコーチです。
ブロンズからプラチナのプレイヤーに対して、具体的で実行可能な改善アドバイスを提供してください。
抽象的な表現は禁止。必ず"行動レベル"に落としてください。
データがある場合は必ず数値を引用して根拠を示してください（例: 「HS率が23%と低いため…」）。

以下のJSON形式のみで返答してください：
{
  "improvements": [
    {
      "title": "改善点のタイトル",
      "description": "詳細な説明（数値データがあれば引用）",
      "cause": "問題の根本原因",
      "actions": ["具体的なアクション1", "アクション2", "アクション3"]
    }
  ],
  "training_plan": [
    "Day1: 具体的なトレーニング内容",
    "Day2: ...",
    "Day3: ...",
    "Day4: ...",
    "Day5: ...",
    "Day6: ...",
    "Day7: ..."
  ],
  "summary": {
    "strengths": "プレイヤーの強みの説明",
    "weaknesses": "主な弱点の説明",
    "focus": "最優先で取り組むべき課題"
  }
}"#.to_string()
}

pub fn build_user_prompt(payload: &AnalyzePayload) -> String {
    let assessment_text = if payload.self_assessment.is_empty() {
        "特になし".to_string()
    } else {
        payload.self_assessment.join("、")
    };

    let mut prompt = format!(
        "プレイヤー情報:\n- ランク: {}\n- エージェント: {}\n- 自己評価の課題: {}\n- プレイ振り返り: {}\n",
        payload.rank,
        payload.agent,
        assessment_text,
        if payload.review.is_empty() { "特になし" } else { &payload.review }
    );

    if let Some(va) = &payload.video_analysis {
        prompt.push_str("\n【自動解析データ (YOLOv8)】\n");

        if let (Some(k), Some(d), Some(a)) = (va.kills, va.deaths, va.assists) {
            prompt.push_str(&format!("- KDA: {}/{}/{}\n", k, d, a));
        }
        if let Some(hs) = va.headshot_rate {
            prompt.push_str(&format!("- ヘッドショット率: {:.0}%\n", hs * 100.0));
        }
        if let Some(dmg) = va.damage_dealt {
            prompt.push_str(&format!("- ダメージ合計: {}\n", dmg));
        }
        if let Some(ab) = va.ability_kills {
            prompt.push_str(&format!("- アビリティキル: {}回\n", ab));
        }
        if let Some(zone) = &va.dominant_zone {
            prompt.push_str(&format!("- 主な活動エリア: {}\n", zone));
        }
        if let Some(agg) = va.aggressiveness {
            let agg_label = if agg > 0.7 { "積極的" } else if agg > 0.4 { "バランス型" } else { "慎重" };
            prompt.push_str(&format!("- ポジショニング傾向: {} (スコア: {:.2})\n", agg_label, agg));
        }
        if let Some(late) = va.deaths_in_late_round {
            prompt.push_str(&format!("- ラウンド後半デス数: {}回\n", late));
        }
        if let Some(streak) = va.longest_lose_streak {
            prompt.push_str(&format!("- 最長連敗ストリーク: {}ラウンド\n", streak));
        }
        if let (Some(total), Some(won)) = (va.total_rounds, va.won_rounds) {
            prompt.push_str(&format!("- ラウンド勝敗: {}/{}\n", won, total));
        }

        prompt.push_str("\n上記の客観的データと、プレイヤーの自己評価を合わせて分析してください。\n");
    }

    prompt.push_str("\n上記の情報を基に、Valorantのコーチングレポートを生成してください。必ず有効なJSONのみを返してください。");
    prompt
}
