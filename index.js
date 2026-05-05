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

// Stream Claude output as NDJSON events. Calls `onProgress` with
// {kind: 'tool', name} or {kind: 'writing'} as work progresses, and resolves
// with the final result + session id when claude exits.
function runClaude(prompt, sessionId, onProgress) {
  return new Promise((resolve, reject) => {
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
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

    let stderr = '';
    let buffer = '';
    let finalResult = '';
    let finalSessionId = sessionId;
    let accumulatedText = '';

    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.stdout.on('data', (d) => {
      buffer += d.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }

        if (DEBUG) console.error(`[claude:event] ${event.type}${event.subtype ? '/' + event.subtype : ''}`);

        if (event.type === 'system' && event.session_id) {
          finalSessionId = event.session_id;
        } else if (event.type === 'assistant' && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'tool_use' && block.name) {
              onProgress?.({ kind: 'tool', name: block.name, input: block.input });
            } else if (block.type === 'text' && block.text?.trim()) {
              accumulatedText += block.text;
              onProgress?.({ kind: 'writing' });
            }
          }
        } else if (event.type === 'result') {
          finalResult = (event.result || '').toString();
          finalSessionId = event.session_id || finalSessionId;
        }
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn claude (${CLAUDE_BIN}): ${err.message}`));
    });

    proc.on('close', (code, signal) => {
      if (DEBUG && stderr) console.error(`[claude:stderr]\n${stderr}`);

      if (signal === 'SIGTERM') {
        return reject(new Error(`Claude run timed out after ${CLAUDE_TIMEOUT_MS / 1000}s`));
      }
      if (code !== 0) {
        const tail = (stderr || buffer).trim().split('\n').slice(-10).join('\n');
        return reject(new Error(`claude exited with code ${code}\n${tail}`));
      }

      const output = (finalResult || accumulatedText).trim();
      resolve({ output, sessionId: finalSessionId });
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

// Extract the first GitHub PR URL from the message text. Slack wraps URLs in
// `<...>` (and may add a `|label` suffix), so we ignore those characters when
// matching. Returns null if no PR URL is present.
function extractPrUrl(rawText) {
  const stripped = rawText.replace(/<@[A-Z0-9]+>/g, '');
  const m = stripped.match(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/);
  return m ? m[0] : null;
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

// Friendly status text per tool name. Falls back to the raw tool name.
function statusForTool(name) {
  const map = {
    Bash: ':gear: Running shell command…',
    Read: ':open_book: Reading file…',
    Edit: ':pencil2: Editing file…',
    Write: ':pencil2: Writing file…',
    Grep: ':mag: Searching…',
    Glob: ':mag: Searching files…',
    WebFetch: ':globe_with_meridians: Fetching URL…',
    WebSearch: ':globe_with_meridians: Searching the web…',
    Task: ':robot_face: Delegating to subagent…',
  };
  return map[name] || `:gear: Running \`${name}\`…`;
}

const STATUS_MIN_INTERVAL_MS = 1500;

async function handlePrompt({ prompt, threadTs, say, client, channel }) {
  const initialText = ':hourglass_flowing_sand: Starting…';
  const placeholder = await say({ text: initialText, thread_ts: threadTs });
  const placeholderTs = placeholder?.ts;

  // Throttled progressive update of the placeholder message.
  let currentStatus = initialText;
  let pendingStatus = null;
  let lastUpdateAt = 0;
  let flushTimer = null;

  const scheduleFlush = () => {
    if (flushTimer || !placeholderTs) return;
    const wait = Math.max(0, STATUS_MIN_INTERVAL_MS - (Date.now() - lastUpdateAt));
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      if (!pendingStatus || pendingStatus === currentStatus) return;
      const target = pendingStatus;
      pendingStatus = null;
      try {
        await client.chat.update({ channel, ts: placeholderTs, text: target });
        currentStatus = target;
        lastUpdateAt = Date.now();
      } catch (e) {
        if (DEBUG) console.error(`[status] update failed: ${e.message}`);
      }
      if (pendingStatus) scheduleFlush();
    }, wait);
  };

  const onProgress = (event) => {
    let next = currentStatus;
    if (event.kind === 'tool') next = statusForTool(event.name);
    else if (event.kind === 'writing') next = ':pencil: Writing review…';
    if (!next || next === currentStatus) return;
    pendingStatus = next;
    scheduleFlush();
  };

  try {
    const existing = sessions.get(threadTs);
    console.log(`[claude] channel=${channel} thread=${threadTs} session=${existing || 'new'} prompt="${prompt.slice(0, 100).replace(/\n/g, ' ')}…"`);

    const { output, sessionId } = await runClaude(prompt, existing, onProgress);
    console.log(`[claude] done session=${sessionId} bytes=${output.length}`);

    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (sessionId) {
      sessions.set(threadTs, sessionId);
      saveSessions();
    }

    const parts = splitMessage(output);
    // Replace the placeholder with the first chunk, then post the rest as
    // separate replies so the original message becomes the final answer.
    if (placeholderTs) {
      try {
        await client.chat.update({ channel, ts: placeholderTs, text: parts[0] });
      } catch (e) {
        if (DEBUG) console.error(`[final] update failed, falling back to new message: ${e.message}`);
        await say({ text: parts[0], thread_ts: threadTs });
      }
    } else {
      await say({ text: parts[0], thread_ts: threadTs });
    }
    for (const part of parts.slice(1)) {
      await say({ text: part, thread_ts: threadTs });
    }
  } catch (err) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    console.error(`[error] ${err.message}`);
    const safe = err.message.length > 1500 ? `${err.message.slice(0, 1500)}…` : err.message;
    const errText = `:x: Error running claude:\n\`\`\`${safe}\`\`\``;
    if (placeholderTs) {
      try { await client.chat.update({ channel, ts: placeholderTs, text: errText }); return; } catch {}
    }
    await say({ text: errText, thread_ts: threadTs });
  }
}

app.event('app_mention', async ({ event, say, client }) => {
  if (!isAuthorized(event)) {
    console.log(`[skip] unauthorized mention from user=${event.user} channel=${event.channel}`);
    return;
  }
  const threadTs = event.thread_ts || event.ts;
  const url = extractPrUrl(event.text || '');
  if (!url) {
    await say({
      text: 'I only review GitHub pull requests. Mention me with a PR URL, e.g.\n`@me https://github.com/org/repo/pull/123`',
      thread_ts: threadTs,
    });
    return;
  }
  const skill = DEFAULT_SKILL || 'pr-review';
  const prompt = `/${skill} ${url}`;
  await handlePrompt({ prompt, threadTs, say, client, channel: event.channel });
});

app.event('message', async ({ event, say, client }) => {
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
  await handlePrompt({ prompt: text, threadTs, say, client, channel: event.channel });
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
