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
# 5. Generate personalized Slack manifest (JSON)
# ---------------------------------------------------------------------------
bold "5) Generating Slack manifest"

RAW_NAME="$(whoami 2>/dev/null || true)"
[ -z "$RAW_NAME" ] && RAW_NAME="$(git config user.name 2>/dev/null || true)"
[ -z "$RAW_NAME" ] && RAW_NAME="user"
# Strip JSON-breaking chars (quotes, backslashes) and keep only printable
SAFE_NAME="$(printf '%s' "$RAW_NAME" | tr -d '"\\' | tr -cd '[:print:]')"
# Slug for the @mention handle: lowercase, alnum+dashes, collapse, trim
SLUG="$(printf '%s' "$SAFE_NAME" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')"
[ -z "$SLUG" ] && SLUG="user"

APP_NAME="$SLUG-pr-review-bot"
BOT_HANDLE="$SLUG-pr-review-bot"

FORCE_MANIFEST=0
NO_AUTOSTART=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE_MANIFEST=1 ;;
    --no-autostart) NO_AUTOSTART=1 ;;
  esac
done

if [ -f manifest.json ] && [ "$FORCE_MANIFEST" != "1" ]; then
  ok "manifest.json already exists — not overwriting"
  info "Re-run with './setup.sh --force' (or delete manifest.json) to regenerate."
else
  cat > manifest.json <<EOF
{
  "display_information": {
    "name": "$APP_NAME",
    "description": "Code review and Claude Code assistant via Slack",
    "background_color": "#1a1a1a",
    "long_description": "Bot that listens for mentions in Slack and delegates to the Claude Code instance running on your local machine. Designed for code reviews, debugging, and technical questions that benefit from access to your local repo, gh CLI, and configured skills."
  },
  "features": {
    "app_home": {
      "home_tab_enabled": false,
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "bot_user": {
      "display_name": "$BOT_HANDLE",
      "always_online": true
    }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "app_mentions:read",
        "chat:write",
        "chat:write.public",
        "channels:history",
        "groups:history",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "users:read"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim"
      ]
    },
    "interactivity": {
      "is_enabled": false
    },
    "org_deploy_enabled": false,
    "socket_mode_enabled": true,
    "token_rotation_enabled": false
  }
}
EOF
  ok "manifest.json generated  →  app: \"$APP_NAME\"  |  mention: @$BOT_HANDLE"
fi
echo

# ---------------------------------------------------------------------------
# 6. Final instructions
# ---------------------------------------------------------------------------
bold "🎉 Setup complete"
echo
if [ "${NEEDS_TOKENS:-0}" = "1" ]; then
  echo "📝  Slack credentials still need to be configured:"
  echo "   1. Open https://api.slack.com/apps → 'Create New App' → 'From a manifest'"
  echo "   2. Pick your workspace. The dialog opens on the JSON tab (default) — paste"
  echo "      the FULL content of:"
  echo "         $REPO_DIR/manifest.json"
  echo "   3. Click 'Next' → 'Create'. Then in the newly created app:"
  echo "      • OAuth & Permissions → 'Install to Workspace' → copy the Bot Token (xoxb-…)"
  echo "      • Basic Information → App-Level Tokens → 'Generate Token and Scopes'"
  echo "        scope: connections:write → copy the token (xapp-…)"
  echo "   4. Edit $REPO_DIR/.env and paste both tokens"
  echo "   5. In Slack, invite the bot to a channel:  /invite @$BOT_HANDLE"
  echo
  if command -v open >/dev/null 2>&1; then
    echo "   💡 Tip: run  open https://api.slack.com/apps   to jump straight to the page."
    echo
  fi
fi
echo "▶️   Start the bot manually:             npm start"
echo "📜  Tail logs:                            npm run logs"
echo "🔁  Install/refresh autostart service:   ./install-autostart.sh"
echo

# ---------------------------------------------------------------------------
# 7. Auto-install autostart if tokens are valid (opt-out with --no-autostart)
# ---------------------------------------------------------------------------
if [ "${NEEDS_TOKENS:-0}" = "0" ] && [ "$NO_AUTOSTART" != "1" ]; then
  bold "7) Tokens detected — installing autostart service"
  ./install-autostart.sh
  echo
  info "To run manually instead, re-run with: ./setup.sh --no-autostart"
fi
