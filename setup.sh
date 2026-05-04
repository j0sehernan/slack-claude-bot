#!/usr/bin/env bash
# ============================================================
# Slack Claude Bot — one-shot setup
# ============================================================
set -euo pipefail

cd "$(dirname "$0")"

bold()  { printf "\033[1m%s\033[0m\n" "$1"; }
ok()    { printf "  ✅  %s\n" "$1"; }
warn()  { printf "  ⚠️   %s\n" "$1"; }
fail()  { printf "  ❌  %s\n" "$1"; exit 1; }
info()  { printf "  •   %s\n" "$1"; }

bold "🤖 Slack Claude Bot — setup"
echo
REPO_DIR="$(pwd)"

# ---------------------------------------------------------------------------
# 1. Pre-requisites
# ---------------------------------------------------------------------------
bold "1) Checking prerequisites"

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js not found. Install Node 18+ from https://nodejs.org or with: brew install node"
fi
NODE_MAJOR="$(node -v | sed 's/v\([0-9]*\).*/\1/')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  fail "Detected Node $NODE_MAJOR. Node 18 or higher is required."
fi
ok "Node $(node -v)"

if ! command -v npm >/dev/null 2>&1; then
  fail "npm not found."
fi
ok "npm $(npm -v)"

CLAUDE_BIN=""
for cand in "$HOME/.local/bin/claude" "$HOME/.claude/local/claude" "/opt/homebrew/bin/claude" "/usr/local/bin/claude" "/usr/bin/claude"; do
  if [ -x "$cand" ]; then CLAUDE_BIN="$cand"; break; fi
done
if [ -z "$CLAUDE_BIN" ] && command -v claude >/dev/null 2>&1; then
  CLAUDE_BIN="$(command -v claude)"
fi
if [ -z "$CLAUDE_BIN" ]; then
  fail "Claude Code CLI not found. Install from: https://docs.claude.com/claude-code/quickstart"
fi
ok "claude CLI ($CLAUDE_BIN)"

if ! command -v gh >/dev/null 2>&1; then
  warn "gh CLI not found — the /pr-review skill needs it. Install with: brew install gh && gh auth login"
else
  ok "gh CLI $(gh --version | head -1 | awk '{print $3}')"
  if ! gh auth status >/dev/null 2>&1; then
    warn "gh is not authenticated. Run: gh auth login   (without this the /pr-review skill cannot read PRs)"
  else
    ok "gh authenticated"
  fi
fi

# Quick sanity check that claude has been used at least once. We don't run
# claude itself (could trigger an interactive auth flow), but we look for the
# config dir.
if [ ! -d "$HOME/.claude" ]; then
  warn "Looks like you have never run 'claude' on this machine. Launch it once to authenticate before starting the bot:  claude"
fi

echo

# ---------------------------------------------------------------------------
# 2. Install npm deps
# ---------------------------------------------------------------------------
bold "2) Installing npm dependencies"
npm install --silent --no-audit --no-fund
ok "node_modules installed"
echo

# ---------------------------------------------------------------------------
# 3. .env
# ---------------------------------------------------------------------------
bold "3) Configuration file"
if [ ! -f .env ]; then
  cp .env.example .env
  ok ".env created from .env.example"
  NEEDS_TOKENS=1
else
  ok ".env already exists (not overwriting)"
  if ! grep -q '^SLACK_BOT_TOKEN=xoxb-' .env || ! grep -q '^SLACK_APP_TOKEN=xapp-' .env; then
    NEEDS_TOKENS=1
  else
    NEEDS_TOKENS=0
  fi
fi
echo

# ---------------------------------------------------------------------------
# 4. Install /pr-review skill (only if user does not already have one)
# ---------------------------------------------------------------------------
bold "4) Installing /pr-review skill"
SKILLS_DIR="$HOME/.claude/skills"
TARGET="$SKILLS_DIR/pr-review"
mkdir -p "$SKILLS_DIR"

if [ -d "$TARGET" ]; then
  ok "Skill /pr-review already exists at $TARGET — not overwriting"
  info "If you want the version bundled in this repo, delete that folder and re-run ./setup.sh"
else
  mkdir -p "$TARGET"
  cp skills/pr-review/SKILL.md "$TARGET/SKILL.md"
  ok "Skill /pr-review installed at $TARGET"
fi
echo

# ---------------------------------------------------------------------------
# 5. Final instructions
# ---------------------------------------------------------------------------
bold "🎉 Setup complete"
echo
if [ "${NEEDS_TOKENS:-0}" = "1" ]; then
  echo "📝  Slack credentials still need to be configured:"
  echo "   1. Open https://api.slack.com/apps → 'Create New App' → 'From a manifest'"
  echo "   2. Pick your workspace, switch to the YAML tab and paste the FULL content of:"
  echo "      $REPO_DIR/manifest.yaml"
  echo "   3. Click 'Create' and then in the newly created app:"
  echo "      • OAuth & Permissions → 'Install to Workspace' → copy the Bot Token (xoxb-…)"
  echo "      • Basic Information → App-Level Tokens → 'Generate Token and Scopes'"
  echo "        scope: connections:write → copy the token (xapp-…)"
  echo "   4. Edit $REPO_DIR/.env and paste both tokens"
  echo "   5. In Slack, invite the bot to a channel:  /invite @claude-code"
  echo
  if command -v open >/dev/null 2>&1; then
    echo "   💡 Tip: run  open https://api.slack.com/apps   to jump straight to the page."
    echo
  fi
fi
echo "▶️   Start the bot:                       npm start"
echo "🔁  Start and keep listening forever:    ./install-autostart.sh"
echo
