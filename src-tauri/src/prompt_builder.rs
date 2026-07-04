use serde::Deserialize;
use std::collections::HashMap;
use std::sync::OnceLock;

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

// ─── Agent knowledge base ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct AgentKnowledge {
    role: String,
    playstyle: String,
    tips: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct RankKnowledge {
    calibration: String,
}

#[derive(Debug, Deserialize)]
struct KnowledgeBase {
    agents: HashMap<String, AgentKnowledge>,
    ranks: HashMap<String, RankKnowledge>,
}

static KNOWLEDGE_BASE: OnceLock<KnowledgeBase> = OnceLock::new();

fn get_knowledge_base() -> &'static KnowledgeBase {
    KNOWLEDGE_BASE.get_or_init(|| {
        let content = include_str!("../resources/agent_knowledge.toml");
        toml::from_str(content).unwrap_or_else(|_| KnowledgeBase {
            agents: HashMap::new(),
            ranks: HashMap::new(),
        })
    })
}

fn rank_to_english(rank: &str) -> &str {
    match rank {
        "アイアン"     => "Iron",
        "ブロンズ"     => "Bronze",
        "シルバー"     => "Silver",
        "ゴールド"     => "Gold",
        "プラチナ"     => "Platinum",
        "ダイヤモンド" => "Diamond",
        "アセンダント" => "Ascendant",
        "イモータル"   => "Immortal",
        "レディアント" => "Radiant",
        _ => rank,
    }
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

pub fn build_system_prompt(agent: &str, rank: &str) -> String {
    let kb = get_knowledge_base();

    let mut prompt = r#"あなたはValorantのプロコーチです。
全ランク帯（アイアン〜レディアント）のプレイヤーに対して、そのランクに合った具体的で実行可能な改善アドバイスを提供してください。
抽象的な表現は禁止。必ず"行動レベル"に落としてください。
データがある場合は必ず数値を引用して根拠を示してください（例: 「HS率が23%と低いため…」）。
"#.to_string();

    // Inject agent-specific knowledge if available
    let primary_agent = agent.split(',').next().unwrap_or(agent).trim();
    let capitalized = {
        let mut chars = primary_agent.chars();
        match chars.next() {
            None => String::new(),
            Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        }
    };

    if let Some(agent_kb) = kb.agents.get(&capitalized) {
        prompt.push_str(&format!(
            "\n【{}のエージェント特性】\nロール: {}\nスタイル: {}\nコーチング上の重要ポイント:\n",
            capitalized, agent_kb.role, agent_kb.playstyle
        ));
        for tip in &agent_kb.tips {
            prompt.push_str(&format!("- {}\n", tip));
        }
    }

    // Inject rank-specific calibration
    let rank_en = rank_to_english(rank);
    if let Some(rank_kb) = kb.ranks.get(rank_en) {
        prompt.push_str(&format!(
            "\n【{}帯へのコーチング指針】\n{}\n",
            rank, rank_kb.calibration
        ));
    }

    prompt.push_str(r#"
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
}"#);

    prompt
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

#[cfg(test)]
mod tests {
    use super::*;

    // P0-3: リモート分析もこのビルダーを使うため、知識ベース注入を保証する
    #[test]
    fn system_prompt_injects_knowledge_base() {
        let prompt = build_system_prompt("Jett", "ゴールド");
        assert!(prompt.contains("エージェント特性"), "agent knowledge should be injected");
        assert!(prompt.contains("ゴールド帯へのコーチング指針"), "rank calibration should be injected");
        assert!(prompt.contains("improvements"), "JSON schema instruction should be present");
    }
}
