import { type MemoryStore } from './db.js';
import { addDaysToDate, type DateString, lastWeekdayBefore, localToUtc } from '../util/time.js';

/**
 * Demo fixtures so evaluators can immediately ask:
 *   - "What did I ask you on 3 November? Is your answer still correct today?"
 *   - "On Monday we shortlisted 5 CRM tools … has any of them changed pricing since?"
 *   - "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"
 *
 * Dates are computed relative to "now" (plus the literal 3 November), so the demo works on any day.
 * Fixture assistant answers deliberately contain NO price claims — the agent must verify live.
 * Seeding is idempotent: each turn carries a unique `seedKey`.
 */

interface SeedConversation {
  key: string;
  date: DateString;
  time: string;
  user: string;
  assistant: string;
}

const SEED_SESSION_PREFIX = 'seed';

export function buildSeedConversations(today: DateString): SeedConversation[] {
  const year = Number(today.slice(0, 4));
  const nov3ThisYear: DateString = `${year}-11-03`;
  const nov3 = nov3ThisYear <= today ? nov3ThisYear : `${year - 1}-11-03`;
  const lastMonday = lastWeekdayBefore(today, 1);
  const lastTuesday = lastWeekdayBefore(today, 2);

  const postgresUser =
    'I am choosing managed Postgres hosting for a small SaaS. Compare Neon, Supabase, AWS RDS and Render, ' +
    'and tell me what the pricing looks like.';
  const postgresAssistant =
    'Shortlist noted: Neon (serverless, branching), Supabase (Postgres plus auth/storage), AWS RDS (most control, ' +
    'most operational overhead) and Render (simple managed Postgres). I described pricing only in broad terms ' +
    '(free/entry tiers, usage-based compute and storage) and did not verify current plan prices, so treat my ' +
    'pricing remarks as unverified.';

  const conversations: SeedConversation[] = [
    {
      key: `postgres-hosting@${nov3}`,
      date: nov3,
      time: '10:15',
      user: postgresUser,
      assistant: postgresAssistant,
    },
    {
      key: `crm-shortlist@${lastMonday}`,
      date: lastMonday,
      time: '11:30',
      user:
        'We shortlisted 5 CRM tools for a 20-person sales team: HubSpot Sales Hub, Salesforce Sales Cloud, ' +
        'Pipedrive, Zoho CRM and Freshsales. Keep that list in mind.',
      assistant:
        'Noted. Your CRM shortlist for a 20-person sales team is HubSpot Sales Hub, Salesforce Sales Cloud, ' +
        'Pipedrive, Zoho CRM and Freshsales. I have not verified live pricing or feature changes for them yet, ' +
        'so I will check the web whenever you ask what has changed.',
    },
    {
      key: `postgres-hosting@${lastTuesday}`,
      date: lastTuesday,
      time: '10:15',
      user: postgresUser,
      assistant: postgresAssistant,
    },
    {
      key: `dns-ttl@${addDaysToDate(today, -3)}`,
      date: addDaysToDate(today, -3),
      time: '16:40',
      user: 'Remind me what a DNS TTL is.',
      assistant:
        'A DNS TTL (time to live) is how long, in seconds, resolvers may cache a record before asking the ' +
        'authoritative server again. Lower TTLs make changes propagate faster at the cost of more queries.',
    },
  ];

  // Drop fixtures that would land in the future or on today (they would not be "past" turns).
  return conversations.filter((c) => c.date < today);
}

/** Inserts fixtures; returns how many *new* messages were written (0 when already seeded). */
export function seedDemoData(store: MemoryStore, today: DateString, timeZone: string): number {
  let inserted = 0;
  for (const convo of buildSeedConversations(today)) {
    const sessionId = `${SEED_SESSION_PREFIX}-${convo.key}`;
    const userAt = localToUtc(convo.date, convo.time, timeZone);
    const assistantAt = new Date(userAt.getTime() + 20_000);
    const metadata = { fixture: true };
    if (store.append({ sessionId, role: 'user', content: convo.user, createdAt: userAt, metadata: { ...metadata, seedKey: `${convo.key}:u` } })) inserted++;
    if (store.append({ sessionId, role: 'assistant', content: convo.assistant, createdAt: assistantAt, metadata: { ...metadata, seedKey: `${convo.key}:a` } })) inserted++;
  }
  return inserted;
}
