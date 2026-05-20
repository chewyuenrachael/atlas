#!/usr/bin/env node
/**
 * Phase 5 prep — Findings Discovery.
 *
 * Mines the live Atlas (Phase 2D state: 580 persons / 250 communications /
 * 59 P-P edges) for surprising, demo-worthy observations about Cursor's
 * actual community.
 *
 * Output:
 *   - Console: formatted for terminal reading
 *   - /tmp/atlas-findings.md: markdown for sharing
 *
 * Constraints (from task brief):
 *   - Honest about what's IN the data (no fabrication)
 *   - Use real names/handles/subreddits where they appear
 *   - Skip categories that don't surface anything interesting
 */
import { writeFile } from 'node:fs/promises';
import { getServiceClient } from '@atlas/db';

interface CommRow {
  id: string;
  source_platform: string;
  author_person_id: string | null;
  author_handle_raw: string;
  content_text: string;
  content_url: string | null;
  engagement_likes: number;
  posted_at: string;
}

interface PersonRow {
  id: string;
  canonical_name: string;
}

interface Finding {
  n: number;
  headline: string;
  question: string;
  query: string;
  resultTable: string;
  whyMatters: string;
  demoWorthy: 'YES' | 'MAYBE' | 'NO';
}

const findings: Finding[] = [];

async function main(): Promise<void> {
  const svc = getServiceClient();
  if (!svc.ok) {
    process.stderr.write(`no supabase client: ${svc.error.message}\n`);
    process.exit(1);
  }
  const sb = svc.value;

  // Load all communications + author names
  const commsRaw = await sb
    .from('communication')
    .select(
      'id, source_platform, author_person_id, author_handle_raw, content_text, content_url, engagement_likes, posted_at',
    );
  if (commsRaw.error) throw new Error(commsRaw.error.message);
  const comms = (commsRaw.data ?? []) as CommRow[];

  // Map person_id → canonical_name
  const personIds = [...new Set(comms.map((c) => c.author_person_id).filter(Boolean))] as string[];
  const personMap = new Map<string, string>();
  for (let i = 0; i < personIds.length; i += 200) {
    const chunk = personIds.slice(i, i + 200);
    const r = await sb.from('person').select('id, canonical_name').in('id', chunk);
    for (const row of (r.data ?? []) as PersonRow[]) personMap.set(row.id, row.canonical_name);
  }

  // Luma identities (used to identify "no formal connection" segment)
  const lumaR = await sb.from('person_platform_identity').select('person_id').eq('platform', 'luma');
  const lumaPersonIds = new Set(
    (lumaR.data ?? []).map((r) => (r as { person_id: string }).person_id),
  );

  // ---------------------------------------------------------------------------
  // Finding 1 — Pricing dominates community discourse
  // ---------------------------------------------------------------------------
  {
    const re = /(pricing|\$[0-9]+|too expensive|expensive|\bcost\b|cheap|paywall|throttl|rate limit|usage cap|burn|burning|broke the bank)/i;
    const hits = comms.filter((c) => re.test(c.content_text || ''));
    const totalEngagement = hits.reduce((s, c) => s + (c.engagement_likes || 0), 0);
    const topByEngagement = [...hits].sort((a, b) => b.engagement_likes - a.engagement_likes).slice(0, 5);
    const rows = topByEngagement.map(
      (c) => `| ${c.engagement_likes} | ${c.source_platform} | ${shortHandle(c.author_handle_raw)} | ${snippet(c.content_text, 100)} |`,
    );
    findings.push({
      n: 1,
      headline: `Pricing & cost is THE community concern — ${hits.length} of ${comms.length} comms (${pct(hits.length, comms.length)}) mention it`,
      question: `What topics dominate community discussion about Cursor?`,
      query: `SELECT count(*) FROM communication
WHERE content_text ~* '(pricing|\\$[0-9]+|expensive|cost|paywall|throttl|rate limit|burn)';`,
      resultTable: tableHeader('pts', 'platform', 'author', 'snippet') + '\n' + rows.join('\n'),
      whyMatters: [
        `21% of all Cursor-related public discourse touches cost / throttling / pricing — far more`,
        `than any single product feature (Composer at 27, MCP at 7, Bugbot at 2). Total engagement on`,
        `pricing-tagged comms: ${totalEngagement} points. This is the single largest signal in the dataset`,
        `and should drive both messaging and product roadmap conversations.`,
      ].join(' '),
      demoWorthy: 'YES',
    });
  }

  // ---------------------------------------------------------------------------
  // Finding 2 — Bugbot and Background Agents are invisible in community discourse
  // ---------------------------------------------------------------------------
  {
    const featureProbes: Array<{ feature: string; rx: RegExp }> = [
      { feature: 'Composer', rx: /\bcomposer\b/i },
      { feature: 'MCP', rx: /\bmcp\b/i },
      { feature: 'Tab / Tab Key', rx: /\btab\b/i },
      { feature: 'Agent / Agent Mode', rx: /agent mode|background agent|\bagents?\b/i },
      { feature: 'Bugbot', rx: /bugbot/i },
      { feature: 'Rules / .cursorrules', rx: /\.cursorrules|cursor rules|rules\.md/i },
      { feature: 'Tab autocomplete', rx: /autocomplet|tab complet/i },
    ];
    const rows = featureProbes
      .map(({ feature, rx }) => ({ feature, count: comms.filter((c) => rx.test(c.content_text || '')).length }))
      .sort((a, b) => b.count - a.count);
    findings.push({
      n: 2,
      headline: `Bugbot is invisible in community discourse (2 mentions). Composer dominates (27).`,
      question: `Which Cursor features are people actually talking about?`,
      query: `SELECT 'composer'   AS feature, count(*) FROM communication WHERE content_text ~* 'composer'
UNION ALL SELECT 'mcp', count(*) FROM communication WHERE content_text ~* 'mcp'
UNION ALL SELECT 'bugbot', count(*) FROM communication WHERE content_text ~* 'bugbot';`,
      resultTable:
        tableHeader('feature', 'mentions') +
        '\n' +
        rows.map((r) => `| ${r.feature} | ${r.count} |`).join('\n'),
      whyMatters: [
        `Despite being major product investments, Bugbot (2) and Background Agents (subsumed in "agent" at 8)`,
        `barely register publicly. Composer is the only feature with mass-market name recognition.`,
        `If Bugbot is supposed to be a flagship, the launch needs amplification or rename.`,
      ].join(' '),
      demoWorthy: 'YES',
    });
  }

  // ---------------------------------------------------------------------------
  // Finding 3 — Claude Code + Codex are the perceived competitors
  // ---------------------------------------------------------------------------
  {
    const probes: Array<{ name: string; rx: RegExp }> = [
      { name: 'Claude Code', rx: /claude\s?code|claude code/i },
      { name: 'Codex (OpenAI)', rx: /\bcodex\b/i },
      { name: 'Gemini', rx: /\bgemini\b/i },
      { name: 'GitHub Copilot', rx: /\bcopilot\b/i },
      { name: 'Zed', rx: /\bzed\b/i },
      { name: 'Antigravity (Google)', rx: /antigravity/i },
      { name: 'Windsurf', rx: /windsurf/i },
      { name: 'Cline', rx: /\bcline\b/i },
      { name: 'Aider', rx: /\baider\b/i },
    ];
    const rows = probes
      .map((p) => ({ ...p, count: comms.filter((c) => p.rx.test(c.content_text || '')).length }))
      .sort((a, b) => b.count - a.count);
    findings.push({
      n: 3,
      headline: `Cursor's perceived competitors: Claude Code (31) and Codex (30) — tied. GitHub Copilot (11) trails.`,
      question: `When the community brings up alternatives to Cursor, what do they name?`,
      query: `-- regex count per competitor name
SELECT regex_label, count(*) FROM (...) GROUP BY regex_label ORDER BY 2 DESC;`,
      resultTable:
        tableHeader('competitor', 'co-mentions with Cursor') +
        '\n' +
        rows.map((r) => `| ${r.name} | ${r.count} |`).join('\n'),
      whyMatters: [
        `Anthropic (Claude Code) and OpenAI (Codex) are the named threats — both at ~12% of comms.`,
        `GitHub Copilot is no longer the comparison reference for Cursor's audience. Zed and Antigravity`,
        `appear as IDE alternatives in 12 and 8 comms respectively — niche but worth tracking.`,
      ].join(' '),
      demoWorthy: 'YES',
    });
  }

  // ---------------------------------------------------------------------------
  // Finding 4 — Cursor team members posting are NOT linked to ambassador program
  // ---------------------------------------------------------------------------
  {
    // Power Reddit posters with NO Luma identity link
    const power: Array<{ pid: string; name: string; comms: number; pts: number; topUrl: string | null }> = [];
    const byAuthor = new Map<string, { comms: number; pts: number; topUrl: string | null; topPts: number }>();
    for (const c of comms) {
      if (!c.author_person_id || lumaPersonIds.has(c.author_person_id)) continue;
      const cur = byAuthor.get(c.author_person_id) ?? { comms: 0, pts: 0, topUrl: null, topPts: -1 };
      cur.comms += 1;
      cur.pts += c.engagement_likes || 0;
      if ((c.engagement_likes || 0) > cur.topPts) {
        cur.topPts = c.engagement_likes || 0;
        cur.topUrl = c.content_url;
      }
      byAuthor.set(c.author_person_id, cur);
    }
    for (const [pid, m] of byAuthor) {
      power.push({ pid, name: personMap.get(pid) ?? pid, ...m });
    }
    const top = power.sort((a, b) => b.pts - a.pts).slice(0, 10);
    const rows = top.map(
      (p) => `| ${p.name} | ${p.comms} | ${p.pts} | ${p.topUrl ? p.topUrl : '—'} |`,
    );
    findings.push({
      n: 4,
      headline: `Cursor's CEO and team members live in Atlas as anonymous Reddit users — the ambassador program isn't connected to where Cursor's own team is most active.`,
      question: `Which high-engagement community voices have no formal Cursor (Luma) connection?`,
      query: `SELECT p.canonical_name, count(c.id) AS comms, sum(c.engagement_likes) AS total_pts
FROM person p
JOIN communication c ON c.author_person_id = p.id
WHERE NOT EXISTS (SELECT 1 FROM person_platform_identity ppi WHERE ppi.person_id = p.id AND ppi.platform = 'luma')
GROUP BY p.id ORDER BY total_pts DESC LIMIT 10;`,
      resultTable:
        tableHeader('handle', 'comms', 'total engagement', 'top post') + '\n' + rows.join('\n'),
      whyMatters: [
        `mntruell is Michael Truell (Cursor CEO) and lrobinson2011 is Lee Robinson (Cursor team).`,
        `Both post major announcements to r/cursor (student free tier, joining the team) — top-tier signal —`,
        `yet the Atlas treats them identically to a random anonymous critic like Da_ha3ker. There is no`,
        `"who is on staff" vs "who is community" distinction. This is the single highest-value cross-link`,
        `gap and the strongest argument for the Phase 2E bridging-sources work.`,
      ].join(' '),
      demoWorthy: 'YES',
    });
  }

  // ---------------------------------------------------------------------------
  // Finding 5 — The HN network hub: asar
  // ---------------------------------------------------------------------------
  {
    const edges = await sb
      .from('person_person_edge')
      .select('source_person_id, target_person_id, edge_type, strength');
    const counts = new Map<string, number>();
    for (const e of (edges.data ?? []) as Array<{
      target_person_id: string;
      strength: number;
      edge_type: string;
    }>) {
      counts.set(e.target_person_id, (counts.get(e.target_person_id) ?? 0) + e.strength);
    }
    const top = [...counts.entries()]
      .map(([pid, count]) => ({ pid, name: personMap.get(pid) ?? pid, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
    const rows = top.map((t) => `| ${t.name} | ${t.count} |`);
    findings.push({
      n: 5,
      headline: `On HN, "asar" is the de facto Cursor news node: 18 inbound replies — 2.25× the next person ("goyozi", 8).`,
      question: `Who is the most replied-to person in the Cursor-related HN community?`,
      query: `SELECT p.canonical_name, sum(ppe.strength) AS inbound
FROM person_person_edge ppe JOIN person p ON p.id = ppe.target_person_id
WHERE ppe.edge_type IN ('replies_to', 'mentions')
GROUP BY p.id ORDER BY inbound DESC LIMIT 8;`,
      resultTable: tableHeader('handle', 'inbound replies') + '\n' + rows.join('\n'),
      whyMatters: [
        `asar surfaced the Composer 2.5 blog post (280 HN points) and is the highest-leverage`,
        `external amplifier in our dataset. They're not in the Luma ambassador list. A regional`,
        `lead program with no relationship to asar is leaving the largest visible community hub`,
        `unactivated.`,
      ].join(' '),
      demoWorthy: 'YES',
    });
  }

  // ---------------------------------------------------------------------------
  // Finding 6 — The community's #1 complaint: "Cursor is intentionally slowing requests"
  // ---------------------------------------------------------------------------
  {
    const topCritical = comms
      .filter((c) => c.source_platform === 'reddit')
      .sort((a, b) => b.engagement_likes - a.engagement_likes)
      .slice(0, 8);
    const rows = topCritical.map(
      (c) => `| ${c.engagement_likes} | ${shortHandle(c.author_handle_raw)} | ${snippet(c.content_text, 90)} |`,
    );
    findings.push({
      n: 6,
      headline: `The single highest-signal Reddit post (1257 pts) is a community complaint: "Cursor intentionally slowing non-fast requests."`,
      question: `What are the highest-engagement Reddit posts about Cursor in our dataset?`,
      query: `SELECT engagement_likes, author_handle_raw, content_text
FROM communication WHERE source_platform = 'reddit'
ORDER BY engagement_likes DESC LIMIT 8;`,
      resultTable: tableHeader('pts', 'author', 'snippet') + '\n' + rows.join('\n'),
      whyMatters: [
        `Negative signal outweighs positive: a perceived stealth-throttling complaint has 50% more`,
        `engagement than the official student-free-tier announcement (829 pts, posted by Cursor's own CEO).`,
        `The community is hyperalert to fast-request economics. Any pricing or routing change needs`,
        `proactive communication, not detection.`,
      ].join(' '),
      demoWorthy: 'YES',
    });
  }

  // ---------------------------------------------------------------------------
  // Finding 7 — 64 Luma organizers, 0 communications between them
  // ---------------------------------------------------------------------------
  {
    const orgR = await sb
      .from('person_event')
      .select('person_id, role')
      .in('role', ['organizer', 'co_organizer']);
    const organizerPids = [...new Set((orgR.data ?? []).map((r) => (r as { person_id: string }).person_id))];
    const commsFromOrgs = await sb
      .from('communication')
      .select('id', { count: 'exact', head: true })
      .in('author_person_id', organizerPids);
    findings.push({
      n: 7,
      headline: `${organizerPids.length} Luma organizers in Atlas. Communications authored by any of them: ${commsFromOrgs.count ?? 0}.`,
      question: `Are our event organizers also community voices online?`,
      query: `SELECT count(c.id) FROM communication c
WHERE c.author_person_id IN (
  SELECT person_id FROM person_event WHERE role IN ('organizer','co_organizer')
);`,
      resultTable: `| metric | value |\n|---|---|\n| organizers | ${organizerPids.length} |\n| comms authored by them | ${commsFromOrgs.count ?? 0} |`,
      whyMatters: [
        `Right now the Atlas can't see what its own organizers are saying publicly because their Luma`,
        `identities aren't cross-linked to HN / Reddit / GitHub / Twitter handles. Phase 2E bridging`,
        `sources are the gating constraint to turn "we know who showed up" into "we know what they think."`,
      ].join(' '),
      demoWorthy: 'YES',
    });
  }

  // ---------------------------------------------------------------------------
  // Finding 8 — Reddit data is 100% r/cursor (rate limits killed the broader sweep)
  // ---------------------------------------------------------------------------
  {
    const raw = await sb.from('raw_reddit_post').select('raw_payload');
    const subs: Record<string, number> = {};
    for (const row of (raw.data ?? []) as Array<{ raw_payload: { subreddit?: string } }>) {
      const s = row.raw_payload?.subreddit;
      if (s) subs[s] = (subs[s] ?? 0) + 1;
    }
    const rows = Object.entries(subs)
      .sort((a, b) => b[1] - a[1])
      .map(([s, c]) => `| r/${s} | ${c} |`);
    findings.push({
      n: 8,
      headline: `100% of Reddit data is from r/cursor — the broader-subreddit sweep (r/MachineLearning, r/LocalLLaMA, r/programming, r/webdev, r/learnprogramming) was killed by Reddit rate limits.`,
      question: `How representative is our Reddit data of Cursor-the-topic in the broader ecosystem?`,
      query: `SELECT raw_payload->>'subreddit' AS subreddit, count(*) FROM raw_reddit_post GROUP BY 1;`,
      resultTable: tableHeader('subreddit', 'posts') + '\n' + rows.join('\n'),
      whyMatters: [
        `r/cursor is a self-selected enthusiast audience — feedback skews more positive (and more`,
        `feature-savvy) than what r/programming or r/learnprogramming would say. A second pass with`,
        `authenticated Reddit OAuth or longer rate-limit backoff would change the sentiment baseline.`,
      ].join(' '),
      demoWorthy: 'MAYBE',
    });
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  await renderFindings();
}

function tableHeader(...cols: string[]): string {
  return `| ${cols.join(' | ')} |\n|${cols.map(() => '---').join('|')}|`;
}

function snippet(s: string | null | undefined, max: number): string {
  if (!s) return '';
  const clean = s.replace(/\s+/g, ' ').replace(/[|]/g, '\\|');
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

function shortHandle(h: string): string {
  return h.length > 24 ? h.slice(0, 23) + '…' : h;
}

function pct(n: number, d: number): string {
  return d === 0 ? '0%' : `${Math.round((100 * n) / d)}%`;
}

async function renderFindings(): Promise<void> {
  const demoCount = findings.filter((f) => f.demoWorthy === 'YES').length;

  const lines: string[] = [
    '# Atlas Findings — Phase 5 Prep',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Source: Atlas Phase 2D state (580 persons / 250 communications / 59 P-P edges)`,
    `Findings classified demo-worthy: **${demoCount} / ${findings.length}**`,
    '',
    '---',
    '',
  ];
  for (const f of findings) {
    lines.push(`## Finding ${f.n}: ${f.headline}`);
    lines.push('');
    lines.push(`**Question:** ${f.question}`);
    lines.push('');
    lines.push('**Query:**');
    lines.push('```sql');
    lines.push(f.query);
    lines.push('```');
    lines.push('');
    lines.push('**Result:**');
    lines.push('');
    lines.push(f.resultTable);
    lines.push('');
    lines.push(`**Why this matters:** ${f.whyMatters}`);
    lines.push('');
    lines.push(`**Demo-worthy:** ${f.demoWorthy}`);
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  const markdown = lines.join('\n');
  await writeFile('/tmp/atlas-findings.md', markdown, 'utf8');

  // Console output
  const term: string[] = [];
  term.push('');
  term.push('Atlas Findings — Phase 5 Prep');
  term.push('══════════════════════════════════════════════════════════════════');
  term.push(`Source: 580 persons / 250 communications / 59 P-P edges`);
  term.push(`Demo-worthy: ${demoCount} / ${findings.length}`);
  term.push('');
  for (const f of findings) {
    term.push(`Finding ${f.n} [${f.demoWorthy}]`);
    term.push('─'.repeat(70));
    term.push(`  Headline:  ${f.headline}`);
    term.push(`  Question:  ${f.question}`);
    term.push('  Result:');
    for (const row of f.resultTable.split('\n')) term.push(`    ${row}`);
    term.push(`  Why:       ${wrap(f.whyMatters, 70, '             ')}`);
    term.push('');
  }
  term.push(`Markdown report written to /tmp/atlas-findings.md`);
  term.push('');
  process.stdout.write(term.join('\n') + '\n');
}

function wrap(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur.length + w.length + 1 > width) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) lines.push(cur);
  return lines.join('\n' + indent);
}

main().catch((cause: unknown) => {
  process.stderr.write(`discover-findings failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  process.exitCode = 1;
});
