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
    /// P1-9: 前回セッションの指標+前回レポートの課題ダイジェスト(前回比用)
    #[serde(rename = "previousSession", default)]
    pub previous_session: Option<PreviousSessionData>,
}

#[derive(Debug, Deserialize)]
pub struct PreviousSessionData {
    pub metrics: Option<VideoAnalysisData>,
    #[serde(rename = "metricsDate")]
    pub metrics_date: Option<String>,
    pub report: Option<PreviousReportDigest>,
}

#[derive(Debug, Deserialize)]
pub struct PreviousReportDigest {
    #[serde(rename = "improvementTitles", default)]
    pub improvement_titles: Vec<String>,
    #[serde(default)]
    pub focus: Option<String>,
    #[serde(rename = "trainingPlan", default)]
    pub training_plan: Vec<String>,
}

impl AnalyzePayload {
    /// 数値の前回比(progress)を要求できるのは、今回と前回の両方に
    /// 自動解析指標がある場合のみ。片方しか無いのに比較を要求すると
    /// AI が架空の数値を捏造するリスクがある。
    pub fn has_comparable_previous(&self) -> bool {
        self.video_analysis.is_some()
            && self
                .previous_session
                .as_ref()
                .is_some_and(|p| p.metrics.is_some())
    }
}

#[derive(Debug, Deserialize)]
pub struct VideoAnalysisData {
    /// P1-10: Riot ローカル API 由来(旧ペイロードには無いので default)
    #[serde(rename = "mapName", default)]
    pub map_name: Option<String>,
    #[serde(default)]
    pub agent: Option<String>,
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

pub fn build_system_prompt(agent: &str, rank: &str, has_previous: bool) -> String {
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

    // P1-9: 前回データがある場合のみ progress(前回比)セクションをスキーマに含める
    let progress_schema = if has_previous {
        r#",
  "progress": {
    "comparisons": [
      { "metric": "HS率", "previous": "前回の値", "current": "今回の値", "assessment": "improved" }
    ],
    "comment": "前回からの変化の総評（1〜2文）"
  }"#
    } else {
        ""
    };

    prompt.push_str(&format!(r#"
以下のJSON形式のみで返答してください：
{{
  "improvements": [
    {{
      "title": "改善点のタイトル",
      "description": "詳細な説明（数値データがあれば引用）",
      "cause": "問題の根本原因",
      "actions": ["具体的なアクション1", "アクション2", "アクション3"]
    }}
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
  "summary": {{
    "strengths": "プレイヤーの強みの説明",
    "weaknesses": "主な弱点の説明",
    "focus": "最優先で取り組むべき課題"
  }}{}
}}"#, progress_schema));

    if has_previous {
        prompt.push_str(r#"

progress（前回比）の規則:
- previous / current にはユーザープロンプト内の数値を一切変更せずそのまま記載すること（推測・丸め・単位変更は禁止）
- assessment は "improved"（改善）/ "declined"（悪化）/ "flat"（横ばい）のいずれか
- デス数・連敗数など「少ないほど良い」指標は方向に注意して判定すること
- comparisons には HS率・KDA・ポジショニング傾向・主な活動エリアなど比較可能な指標を最大5件含めること
"#);
    }

    prompt
}

fn push_video_metrics(prompt: &mut String, va: &VideoAnalysisData) {
    if let Some(map) = &va.map_name {
        prompt.push_str(&format!("- マップ: {}\n", map));
    }
    if let Some(agent) = &va.agent {
        prompt.push_str(&format!("- 使用エージェント: {}\n", agent));
    }
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
        prompt.push_str("\n【自動解析データ】\n");
        push_video_metrics(&mut prompt, va);
        prompt.push_str("\n上記の客観的データと、プレイヤーの自己評価を合わせて分析してください。\n");
    }

    // P1-9: 前回セッションのデータと前回レポートの課題を注入し、前回比を要求
    if let Some(prev) = &payload.previous_session {
        let mut has_prev_content = false;

        if let Some(metrics) = &prev.metrics {
            match &prev.metrics_date {
                Some(date) => prompt.push_str(&format!("\n【前回セッションのデータ ({})】\n", date)),
                None => prompt.push_str("\n【前回セッションのデータ】\n"),
            }
            push_video_metrics(&mut prompt, metrics);
            has_prev_content = true;
        }

        if let Some(report) = &prev.report {
            prompt.push_str("\n【前回のコーチング内容】\n");
            if !report.improvement_titles.is_empty() {
                prompt.push_str(&format!(
                    "- 前回指摘した課題: {}\n",
                    report.improvement_titles.join(" / ")
                ));
            }
            if let Some(focus) = &report.focus {
                prompt.push_str(&format!("- 前回の最優先課題: {}\n", focus));
            }
            if !report.training_plan.is_empty() {
                prompt.push_str(&format!(
                    "- 前回のトレーニングプラン: {}\n",
                    report.training_plan.join(" / ")
                ));
            }
            has_prev_content = true;
        }

        if has_prev_content {
            prompt.push_str("\n【前回比の指示】\n");
            if payload.has_comparable_previous() {
                prompt.push_str(
                    "今回のデータと前回のデータを比較し、progress セクションに前回比を必ず出力してください。\n",
                );
            }
            if prev.report.is_some() {
                prompt.push_str(
                    "improvements のアドバイスでは前回指摘した課題に対する進捗（改善できたか・課題が残っているか）に必ず言及してください。\n",
                );
            }
        }
    }

    prompt.push_str("\n上記の情報を基に、Valorantのコーチングレポートを生成してください。必ず有効なJSONのみを返してください。");
    prompt
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_payload() -> AnalyzePayload {
        AnalyzePayload {
            rank: "ゴールド".to_string(),
            agent: "Jett".to_string(),
            self_assessment: vec![],
            review: String::new(),
            video_analysis: None,
            previous_session: None,
        }
    }

    fn metrics(headshot_rate: f32) -> VideoAnalysisData {
        VideoAnalysisData {
            map_name: Some("ascent".to_string()),
            agent: Some("Jett".to_string()),
            kills: Some(12),
            deaths: Some(10),
            assists: Some(4),
            headshot_rate: Some(headshot_rate),
            damage_dealt: None,
            ability_kills: None,
            dominant_zone: Some("A site".to_string()),
            aggressiveness: Some(0.5),
            deaths_in_late_round: None,
            longest_lose_streak: None,
            total_rounds: Some(24),
            won_rounds: Some(11),
        }
    }

    // P0-3: リモート分析もこのビルダーを使うため、知識ベース注入を保証する
    #[test]
    fn system_prompt_injects_knowledge_base() {
        let prompt = build_system_prompt("Jett", "ゴールド", false);
        assert!(prompt.contains("エージェント特性"), "agent knowledge should be injected");
        assert!(prompt.contains("ゴールド帯へのコーチング指針"), "rank calibration should be injected");
        assert!(prompt.contains("improvements"), "JSON schema instruction should be present");
        assert!(!prompt.contains("\"progress\""), "progress schema must be absent without previous data");
    }

    // P1-9: 前回データがある場合のみ progress スキーマを含める
    #[test]
    fn system_prompt_with_previous_includes_progress_schema() {
        let prompt = build_system_prompt("Jett", "ゴールド", true);
        assert!(prompt.contains("\"progress\""), "progress schema should be present");
        assert!(prompt.contains("\"assessment\""), "assessment field should be in schema");
        assert!(prompt.contains("improved"), "assessment values should be documented");
    }

    #[test]
    fn user_prompt_includes_previous_session_block() {
        let mut payload = base_payload();
        payload.video_analysis = Some(metrics(0.28));
        payload.previous_session = Some(PreviousSessionData {
            metrics: Some(metrics(0.23)),
            metrics_date: Some("2026-07-01 12:00:00".to_string()),
            report: Some(PreviousReportDigest {
                improvement_titles: vec!["エイム精度の改善".to_string()],
                focus: Some("クロスヘア配置".to_string()),
                training_plan: vec!["Day1: エイム練習".to_string()],
            }),
        });

        let prompt = build_user_prompt(&payload);
        assert!(prompt.contains("前回セッションのデータ"), "previous metrics heading expected");
        assert!(prompt.contains("2026-07-01"), "previous session date expected");
        assert!(prompt.contains("23%"), "previous HS rate expected");
        assert!(prompt.contains("28%"), "current HS rate expected");
        assert!(prompt.contains("前回指摘した課題: エイム精度の改善"), "previous issues expected");
        assert!(prompt.contains("前回の最優先課題: クロスヘア配置"), "previous focus expected");
        assert!(prompt.contains("前回比の指示"), "comparison instruction expected");
        assert!(prompt.contains("progress セクション"), "numeric progress should be requested");
        assert!(payload.has_comparable_previous());
    }

    // P1-10: Riot ローカル API 由来のマップ/エージェントがプロンプトに入ること
    #[test]
    fn user_prompt_includes_map_and_agent() {
        let mut payload = base_payload();
        payload.video_analysis = Some(metrics(0.28));
        let prompt = build_user_prompt(&payload);
        assert!(prompt.contains("【自動解析データ】"), "source-agnostic header expected");
        assert!(prompt.contains("マップ: ascent"), "map line expected");
        assert!(prompt.contains("使用エージェント: Jett"), "agent line expected");
    }

    #[test]
    fn user_prompt_without_previous_has_no_progress_block() {
        let mut payload = base_payload();
        payload.video_analysis = Some(metrics(0.28));
        let prompt = build_user_prompt(&payload);
        assert!(!prompt.contains("前回"), "no previous-session text expected");
    }

    // 前回レポートだけ(指標なし=手動分析ユーザー)でも課題参照が効くこと
    #[test]
    fn user_prompt_with_report_only_previous() {
        let mut payload = base_payload();
        payload.previous_session = Some(PreviousSessionData {
            metrics: None,
            metrics_date: None,
            report: Some(PreviousReportDigest {
                improvement_titles: vec!["立ち回りの改善".to_string()],
                focus: None,
                training_plan: vec![],
            }),
        });
        let prompt = build_user_prompt(&payload);
        assert!(!prompt.contains("前回セッションのデータ"), "no metrics heading expected");
        assert!(prompt.contains("前回指摘した課題: 立ち回りの改善"), "previous issues expected");
        assert!(prompt.contains("前回指摘した課題に対する進捗"), "issue-progress instruction expected");
        assert!(
            !prompt.contains("progress セクション"),
            "numeric progress must not be requested without both metrics"
        );
        assert!(!payload.has_comparable_previous());
    }
}
