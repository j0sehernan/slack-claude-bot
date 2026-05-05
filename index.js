// Identify this process so `ps`, `pgrep`, Activity Monitor, etc. don't just
// show a generic "node" entry.  Set before any other init.
process.title = 'slack-claude-bot';

require('dotenv').config();

const { App } = require('@slack/bolt');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config & startup validation
// ---------------------------------------------------------------------------

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;
const DEFAULT_SKILL = (process.env.DEFAULT_SKILL || '').trim();
const WORKING_DIR = process.env.WORKING_DIR || __dirname;
const ALLOWED_CHANNELS = (process.env.ALLOWED_CHANNELS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ALLOWED_USERS = (process.env.ALLOWED_USERS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const CLAUDE_TIMEOUT_MS = Number.parseInt(process.env.CLAUDE_TIMEOUT_MS, 10) || 600000;
const DEBUG = process.env.DEBUG === '1';

function fatal(msg) {
  console.error(`\n  ❌  ${msg}\n`);
  process.exit(1);
}

if (!SLACK_BOT_TOKEN || !SLACK_BOT_TOKEN.startsWith('xoxb-')) {
  fatal('SLACK_BOT_TOKEN is missing or invalid. It must start with "xoxb-". Edit .env and try again.');
}
if (!SLACK_APP_TOKEN || !SLACK_APP_TOKEN.startsWith('xapp-')) {
  fatal('SLACK_APP_TOKEN is missing or invalid. It must start with "xapp-". Edit .env and try again.');
}
if (!fs.existsSync(WORKING_DIR)) {
  fatal(`WORKING_DIR does not exist: ${WORKING_DIR}`);
}

// Resolve `claude` binary.  We prefer an absolute path so the bot keeps working
// when launched by launchd / systemd where PATH is minimal.
function resolveClaudeBin() {
  const fromEnv = process.env.CLAUDE_BIN;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const candidates = [
    `${process.env.HOME}/.local/bin/claude`,
    `${process.env.HOME}/.claude/local/claude`,
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'claude';
}
const CLAUDE_BIN = resolveClaudeBin();

// ---------------------------------------------------------------------------
// Session persistence (slack thread_ts -> claude session_id)
// ---------------------------------------------------------------------------

const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const sessions = new Map();

if (fs.existsSync(SESSIONS_FILE)) {
  try {
    const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    Object.entries(data).forEach(([k, v]) => sessions.set(k, v));
    console.log(`[init] Loaded ${sessions.size} sessions from disk`);
  } catch (e) {
    console.error(`[init] Failed to parse sessions.json: ${e.message}`);
  }
}

function saveSessions() {
  try {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions), null, 2));
  } catch (e) {
    console.error(`[sessions] Failed to persist: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Claude runner
// ---------------------------------------------------------------------------

function runClaude(prompt, sessionId) {
  return new Promise((resolve, reject) => {
    const args = [
      '--print',
      '--output-format', 'json',
      '--dangerously-skip-permissions',
    ];

    if (sessionId) args.push('--resume', sessionId);
    args.push(prompt);

    // Strip CLAUDECODE so the spawned claude does not think it is nested.
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    const proc = spawn(CLAUDE_BIN, args, {
      cwd: WORKING_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CLAUDE_TIMEOUT_MS,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn claude (${CLAUDE_BIN}): ${err.message}`));
    });

    proc.on('close', (code, signal) => {
      if (DEBUG && stderr) console.error(`[claude:stderr]\n${stderr}`);

      if (signal === 'SIGTERM') {
        return reject(new Error(`Claude run timed out after ${CLAUDE_TIMEOUT_MS / 1000}s`));
      }
      if (code !== 0) {
        const tail = (stderr || stdout).trim().split('\n').slice(-10).join('\n');
        return reject(new Error(`claude exited with code ${code}\n${tail}`));
      }

      // Parse JSON output for reliable session id + result extraction.
      let result = stdout.trim();
      let newSessionId = sessionId;
      try {
        const parsed = JSON.parse(stdout);
        result = (parsed.result || parsed.message || '').toString().trim() || stdout.trim();
        newSessionId = parsed.session_id || parsed.sessionId || sessionId;
      } catch {
        // Fallback: legacy stderr scan
        const m = stderr.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
        if (m) newSessionId = m[1];
      }

      resolve({ output: result, sessionId: newSessionId });
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitMessage(text, limit = 3900) {
  if (!text) return ['(claude returned no output)'];
  if (text.length <= limit) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > 0) {
    let cut = remaining.lastIndexOf('\n', limit);
    if (cut <= 0) cut = limit;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  return parts;
}

function buildPrompt(rawText) {
  const text = rawText.replace(/<@[A-Z0-9]+>/g, '').trim();
  if (!text) return '';
  if (!DEFAULT_SKILL) return text;
  if (text.startsWith('/')) return text; // user explicitly invoked a slash command / skill
  return `/${DEFAULT_SKILL} ${text}`;
}

function isAuthorized(event) {
  if (ALLOWED_CHANNELS.length && !ALLOWED_CHANNELS.includes(event.channel)) return false;
  if (ALLOWED_USERS.length && !ALLOWED_USERS.includes(event.user)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Slack app
// ---------------------------------------------------------------------------

const app = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
});

async function handlePrompt({ prompt, threadTs, say, channel }) {
  await say({ text: ':hourglass_flowing_sand: Working on it…', thread_ts: threadTs });

  try {
    const existing = sessions.get(threadTs);
    console.log(`[claude] channel=${channel} thread=${threadTs} session=${existing || 'new'} prompt="${prompt.slice(0, 100).replace(/\n/g, ' ')}…"`);

    const { output, sessionId } = await runClaude(prompt, existing);
    console.log(`[claude] done session=${sessionId} bytes=${output.length}`);

    if (sessionId) {
      sessions.set(threadTs, sessionId);
      saveSessions();
    }

    const parts = splitMessage(output);
    for (const part of parts) {
      await say({ text: part, thread_ts: threadTs });
    }
  } catch (err) {
    console.error(`[error] ${err.message}`);
    const safe = err.message.length > 1500 ? `${err.message.slice(0, 1500)}…` : err.message;
    await say({ text: `:x: Error running claude:\n\`\`\`${safe}\`\`\``, thread_ts: threadTs });
  }
}

app.event('app_mention', async ({ event, say }) => {
  if (!isAuthorized(event)) {
    console.log(`[skip] unauthorized mention from user=${event.user} channel=${event.channel}`);
    return;
  }
  const prompt = buildPrompt(event.text || '');
  if (!prompt) return;
  const threadTs = event.thread_ts || event.ts;
  await handlePrompt({ prompt, threadTs, say, channel: event.channel });
});

app.event('message', async ({ event, say }) => {
  if (event.bot_id || event.subtype) return;
  if (!event.thread_ts) return;
  if (event.text && /<@[A-Z0-9]+>/.test(event.text)) return; // handled by app_mention
  if (!isAuthorized(event)) return;

  const threadTs = event.thread_ts;
  if (!sessions.has(threadTs)) return; // only continue threads with a known session

  const text = (event.text || '').trim();
  if (!text) return;
  // For follow-up messages we never re-prepend the default skill — the session
  // is already inside the skill / conversation context.
  await handlePrompt({ prompt: text, threadTs, say, channel: event.channel });
});

app.error(async (error) => {
  console.error('[bolt]', error);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async () => {
  await app.start();
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Slack Claude Bot — listening');
  console.log(`  claude binary : ${CLAUDE_BIN}`);
  console.log(`  working dir   : ${WORKING_DIR}`);
  console.log(`  default skill : ${DEFAULT_SKILL || '(none — pass-through)'}`);
  console.log(`  channel filter: ${ALLOWED_CHANNELS.length ? ALLOWED_CHANNELS.join(',') : 'all channels'}`);
  console.log(`  user filter   : ${ALLOWED_USERS.length ? ALLOWED_USERS.join(',') : 'all users'}`);
  console.log(`  timeout       : ${CLAUDE_TIMEOUT_MS / 1000}s`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
})().catch((err) => fatal(`Failed to start bot: ${err.message}`));

process.on('SIGINT', () => { console.log('\n[bot] SIGINT — bye'); process.exit(0); });
process.on('SIGTERM', () => { console.log('[bot] SIGTERM — bye'); process.exit(0); });
