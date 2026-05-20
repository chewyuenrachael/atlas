/**
 * The 6 demo chips for /ask. Each one carries a fixed SQL string and a
 * `demoCallout` line that's shown beneath the result table.
 *
 * Important: chip SQL must be safe to execute under `atlas_run_select`.
 * That means single statement, leading SELECT/WITH, no semicolons, and
 * (defensively) a LIMIT clause even though the function adds one.
 */

export interface ChipDef {
  id: string;
  label: string;
  question: string;
  sql: string;
  demoCallout: string;
}

export const CHIPS: ChipDef[] = [
  {
    id: 'engagement-vs-announcements',
    label: 'Engagement vs announcements',
    question: 'What are the highest-engagement Reddit posts about Cursor?',
    sql: `SELECT
  engagement_likes AS points,
  author_handle_raw AS author,
  substring(content_text, 1, 80) AS snippet,
  content_url AS source_url
FROM communication
WHERE source_platform = 'reddit'
ORDER BY engagement_likes DESC
LIMIT 8`,
    demoCallout:
      "Da_ha3ker's throttling complaint (1257 pts) beats Cursor's CEO mntruell announcing student free tier (829 pts) by 50%.",
  },
  {
    id: 'topic-share',
    label: 'Pricing dominates conversation',
    question: 'What topics dominate community discussion about Cursor?',
    sql: `SELECT topic, count(*) AS mentions, sum(engagement_likes) AS total_engagement
FROM (
  SELECT
    CASE
      WHEN content_text ~* 'pricing|\\$[0-9]+|expensive|cost|paywall|throttl|rate limit|burn' THEN 'pricing'
      WHEN content_text ~* 'composer' THEN 'composer'
      WHEN content_text ~* 'agent' THEN 'agent'
      WHEN content_text ~* 'mcp' THEN 'mcp'
      WHEN content_text ~* 'bugbot' THEN 'bugbot'
      WHEN content_text ~* 'tab(\\s|$)' THEN 'tab'
      ELSE NULL
    END AS topic,
    engagement_likes
  FROM communication
) AS t
WHERE topic IS NOT NULL
GROUP BY topic
ORDER BY mentions DESC
LIMIT 20`,
    demoCallout:
      '~18% of all Cursor-related public discourse touches cost, throttling, or pricing — more than any single product feature.',
  },
  {
    id: 'competitors',
    label: 'Perceived competitors',
    question:
      'When the community discusses alternatives to Cursor, what do they name?',
    sql: `SELECT competitor, count(*) AS co_mentions
FROM (
  SELECT 'Claude Code' AS competitor FROM communication WHERE content_text ~* 'claude\\s*code'
  UNION ALL SELECT 'Codex' FROM communication WHERE content_text ~* '\\mcodex\\M|openai\\s*codex'
  UNION ALL SELECT 'Gemini' FROM communication WHERE content_text ~* 'gemini'
  UNION ALL SELECT 'Zed' FROM communication WHERE content_text ~* '\\mzed\\M'
  UNION ALL SELECT 'GitHub Copilot' FROM communication WHERE content_text ~* 'copilot'
  UNION ALL SELECT 'Antigravity' FROM communication WHERE content_text ~* 'antigravity'
  UNION ALL SELECT 'Windsurf' FROM communication WHERE content_text ~* 'windsurf'
) AS t
GROUP BY competitor
ORDER BY co_mentions DESC
LIMIT 20`,
    demoCallout:
      'Claude Code and Codex are the named threats — not Copilot. The model labs are the structural competition.',
  },
  {
    id: 'feature-awareness',
    label: 'Composer vs Bugbot awareness',
    question: 'Which Cursor features are people actually talking about?',
    sql: `SELECT feature, count(*) AS mentions
FROM (
  SELECT 'Agent' AS feature FROM communication WHERE content_text ~* 'agent\\s+mode|background\\s+agent'
  UNION ALL SELECT 'Composer' FROM communication WHERE content_text ~* 'composer'
  UNION ALL SELECT 'MCP' FROM communication WHERE content_text ~* '\\mmcp\\M'
  UNION ALL SELECT 'Tab' FROM communication WHERE content_text ~* 'tab\\s+key|tab\\s+autocomplete'
  UNION ALL SELECT 'Bugbot' FROM communication WHERE content_text ~* 'bugbot'
  UNION ALL SELECT 'Rules' FROM communication WHERE content_text ~* '\\.cursorrules|cursor\\s+rules'
) AS t
GROUP BY feature
ORDER BY mentions DESC
LIMIT 20`,
    demoCallout:
      'Bugbot has 2 mentions across 250 communications. Composer dominates. The flagship gap is real.',
  },
  {
    id: 'hn-hubs',
    label: 'HN community hubs',
    question:
      'Who is the most replied-to person in Cursor-related HN discussions?',
    sql: `SELECT
  p.canonical_name AS handle,
  sum(ppe.strength) AS inbound_replies
FROM person_person_edge ppe
JOIN person p ON p.id = ppe.target_person_id
WHERE ppe.edge_type IN ('replies_to', 'mentions')
GROUP BY p.id
ORDER BY inbound_replies DESC
LIMIT 8`,
    demoCallout:
      "asar surfaced the Composer 2.5 blog post and is the highest-leverage external amplifier in our dataset. They're not in any Cursor program.",
  },
  {
    id: 'no-formal-connection',
    label: 'Voices outside formal programs',
    question:
      'Which high-engagement community voices have no formal Cursor connection?',
    sql: `SELECT
  p.canonical_name AS handle,
  count(c.id) AS comms,
  sum(c.engagement_likes) AS total_engagement,
  max(c.content_url) AS sample_post
FROM person p
JOIN communication c ON c.author_person_id = p.id
WHERE NOT EXISTS (
  SELECT 1 FROM person_platform_identity ppi
  WHERE ppi.person_id = p.id AND ppi.platform = 'luma'
)
GROUP BY p.id
ORDER BY total_engagement DESC
LIMIT 10`,
    demoCallout:
      "Cursor's own CEO (mntruell) and team member Lee Robinson (lrobinson2011) sit in the Atlas as anonymous Reddit users — the strongest argument for Phase 2E cross-platform identity bridging.",
  },
];

export function findChipById(id: string): ChipDef | null {
  return CHIPS.find((c) => c.id === id) ?? null;
}
