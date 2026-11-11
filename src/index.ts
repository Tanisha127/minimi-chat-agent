import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { ChatAgent, type AgentEvents } from './agent/orchestrator.js';
import { createModel } from './agent/model.js';
import { describeReferences, planTurn } from './agent/planner.js';
import { formatTurn } from './agent/context.js';
import { ConfigError, loadConfig, type AppConfig } from './config.js';
import { MemoryStore } from './memory/db.js';
import { seedDemoData } from './memory/seed.js';
import { TavilyClient } from './tools/search.js';
import { describeNow, isValidDateString } from './util/time.js';

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint(2);
const cyan = paint(36);
const green = paint(32);
const yellow = paint(33);
const red = paint(31);
const bold = paint(1);

const HELP = `Commands:
  /help              show this help
  /now               show the date/time the agent believes it is
  /dates             list dates that have stored conversation turns
  /history [date]    show stored turns for YYYY-MM-DD (default: today)
  /plan <text>       dry-run the temporal planner on <text> (no model call)
  /seed              (re)insert demo conversations (idempotent)
  /exit              quit

Try:
  What did I ask you on 3 November? Is your answer still correct today?
  On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?
  Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?`;

function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));

  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(red(`\n${error.message}\n`));
      process.exitCode = 1;
      return Promise.resolve();
    }
    throw error;
  }

  const clock = (): Date => config.nowOverride ?? new Date();
  const store = new MemoryStore(config.dbPath, config.timeZone);

  if (!args.has('--no-seed')) {
    const added = seedDemoData(store, describeNow(clock(), config.timeZone).localDate, config.timeZone);
    if (added > 0) console.log(dim(`Seeded ${added} demo messages (3 Nov, last Monday, last Tuesday).`));
  }
  if (args.has('--seed-only')) {
    console.log(`Database ready at ${config.dbPath} (${store.count()} messages).`);
    store.close();
    return Promise.resolve();
  }

  if (!config.tavilyApiKey) {
    console.log(yellow('! TAVILY_API_KEY is not set — memory questions work, live web search will report as unavailable.'));
  }

  const events: AgentEvents = {
    onPlan: (plan, policy) => {
      const refs = describeReferences(plan);
      if (refs.length > 0) console.log(dim(`[Resolved dates: ${refs.join('; ')}]`));
      console.log(dim(`[Search policy: ${policy}${plan.anchorDate ? ` · change window ${plan.anchorDate} → ${plan.now.localDate}` : ''}]`));
    },
    onMemory: (memory) => {
      if (memory.turns.length > 0) {
        const dates = [...new Set(memory.turns.map((t) => t.localDate))].join(', ');
        console.log(dim(`[Memory: ${memory.turns.length} stored turn(s) from ${dates}]`));
      } else if (memory.emptyReferences.length > 0) {
        console.log(dim(`[Memory: nothing stored for ${memory.emptyReferences.join('; ')}]`));
      }
    },
    onSearchStart: ({ query, since }) =>
      console.log(cyan(`[Searching web for: "${query}"${since ? ` (since ${since})` : ''}]`)),
    onSearchEnd: (outcome) => {
      const summary =
        outcome.status === 'ok'
          ? `${outcome.hits.length} result(s)${outcome.windowRelaxed ? ', date window relaxed' : ''}`
          : outcome.status === 'empty'
            ? 'no results'
            : `failed: ${outcome.message}`;
      console.log(dim(`[Search done: ${summary}]`));
    },
    onNotice: (message) => console.log(yellow(`[${message}]`)),
  };

  const agent = new ChatAgent({
    store,
    model: createModel(config),
    search: config.tavilyApiKey
      ? new TavilyClient({ apiKey: config.tavilyApiKey, timeoutMs: config.searchTimeoutMs })
      : null,
    timeZone: config.timeZone,
    maxSearchesPerTurn: config.maxSearchesPerTurn,
    turnTimeoutMs: config.turnTimeoutMs,
    events,
    clock,
    sessionId: `session-${randomUUID()}`,
  });

  const now = describeNow(clock(), config.timeZone);
  console.log(bold('\nminimi chat agent') + dim(`  ·  ${config.provider}/${config.model}`));
  console.log(dim(`Today is ${now.weekday}, ${now.localDate} ${now.localTime} (${config.timeZone}). Type /help for commands.\n`));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  let busy: AbortController | null = null;
  rl.on('SIGINT', () => {
    if (busy) {
      busy.abort();
      console.log(yellow('\n[Cancelled]'));
    } else {
      rl.close();
    }
  });

  const handleCommand = (line: string): boolean => {
    const [cmd = '', ...rest] = line.split(/\s+/);
    const arg = rest.join(' ').trim();
    switch (cmd.toLowerCase()) {
      case '/help':
        console.log(HELP);
        return true;
      case '/now': {
        const n = describeNow(clock(), config.timeZone);
        console.log(`${n.weekday}, ${n.localDate} ${n.localTime} (${n.timeZone}) — UTC ${n.iso}`);
        return true;
      }
      case '/dates': {
        const rows = store.listActiveDates(30);
        console.log(rows.length ? rows.map((r) => `${r.date} ${r.dayOfWeek.padEnd(9)} ${r.turns} turn(s)`).join('\n') : 'No stored turns.');
        return true;
      }
      case '/history': {
        const date = arg || describeNow(clock(), config.timeZone).localDate;
        if (!isValidDateString(date)) {
          console.log(red('Usage: /history YYYY-MM-DD'));
          return true;
        }
        const turns = store.getByDate(date);
        console.log(turns.length ? turns.map((t) => formatTurn(t, config.timeZone)).join('\n') : `No stored turns on ${date}.`);
        return true;
      }
      case '/plan': {
        const plan = planTurn(arg, describeNow(clock(), config.timeZone));
        console.log(JSON.stringify({ references: plan.references, anchorDate: plan.anchorDate, cues: plan.cues, searchPolicy: plan.searchPolicy, searchWindow: plan.searchWindow }, null, 2));
        return true;
      }
      case '/seed': {
        const added = seedDemoData(store, describeNow(clock(), config.timeZone).localDate, config.timeZone);
        console.log(added > 0 ? `Inserted ${added} demo messages.` : 'Demo data already present.');
        return true;
      }
      case '/exit':
      case '/quit':
        rl.close();
        return true;
      default:
        return false;
    }
  };

  rl.setPrompt(green('you › '));
  rl.prompt();

  return (async () => {
    for await (const raw of rl) {
      const line = raw.trim();
      if (line) {
        if (line.startsWith('/') && handleCommand(line)) {
          // handled
        } else {
          busy = new AbortController();
          try {
            const reply = await agent.respond(line, busy.signal);
            console.log(`\n${bold('agent ›')} ${reply.text}\n`);
          } catch (error) {
            console.log(red(`\n[Error] ${error instanceof Error ? error.message : String(error)}\n`));
          } finally {
            busy = null;
          }
        }
      }
      rl.prompt();
    }
    store.close();
    console.log(dim('\nBye.'));
  })();
}

main().catch((error: unknown) => {
  console.error(red(`Fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`));
  process.exitCode = 1;
});
