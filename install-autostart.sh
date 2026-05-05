#!/usr/bin/env bash
# ============================================================
# Install the bot as a service that auto-starts and always listens.
#  - macOS  -> launchd (LaunchAgent in ~/Library/LaunchAgents)
#  - Linux  -> systemd --user
# ============================================================
set -euo pipefail

cd "$(dirname "$0")"
REPO_DIR="$(pwd)"

# Stable label across reinstalls.  macOS 15+ requires user approval the FIRST
# time a new label is registered (System Settings → Login Items), so we keep
# it constant.  Identification at runtime is provided by process.title in
# index.js, which makes the bot show up as "slack-claude-bot" in ps/pgrep.
LABEL="com.local.slack-claude-bot"

bold()  { printf "\033[1m%s\033[0m\n" "$1"; }
ok()    { printf "  ✅  %s\n" "$1"; }
fail()  { printf "  ❌  %s\n" "$1"; exit 1; }

# Find absolute paths so launchd/systemd (minimal PATH) can run them.
NODE_BIN="$(command -v node || true)"
[ -z "$NODE_BIN" ] && fail "node not found in PATH"
[ -f "$REPO_DIR/.env" ] || fail "Missing .env — run ./setup.sh first"
[ -d "$REPO_DIR/node_modules" ] || fail "Missing node_modules — run ./setup.sh first"

# Wrapper script that exec's node — the LaunchAgent registers this path so
# macOS Login Items, Activity Monitor and `ps` show "slack-claude-bot"
# instead of a generic "node" entry.
WRAPPER="$REPO_DIR/bin/slack-claude-bot"
[ -f "$WRAPPER" ] || fail "Missing $WRAPPER — pull the latest changes"
chmod +x "$WRAPPER"

mkdir -p "$REPO_DIR/logs"
LOG_FILE="$REPO_DIR/logs/bot.log"
ERR_FILE="$REPO_DIR/logs/bot.err"

case "$(uname -s)" in
  Darwin)
    bold "macOS detected → installing LaunchAgent"
    PLIST_DIR="$HOME/Library/LaunchAgents"
    PLIST="$PLIST_DIR/$LABEL.plist"
    mkdir -p "$PLIST_DIR"

    # Clean up older labels from previous versions of this script.
    for legacy_label in com.user.slack-claude-bot "com.$(whoami).slack-claude-bot"; do
      LEGACY_PLIST="$PLIST_DIR/$legacy_label.plist"
      if [ -f "$LEGACY_PLIST" ] && [ "$LEGACY_PLIST" != "$PLIST" ]; then
        launchctl unload "$LEGACY_PLIST" 2>/dev/null || true
        rm -f "$LEGACY_PLIST"
        ok "Removed legacy LaunchAgent: $legacy_label.plist"
      fi
    done

    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$WRAPPER</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_FILE</string>
  <key>StandardErrorPath</key>
  <string>$ERR_FILE</string>
</dict>
</plist>
EOF
    ok "Plist written to $PLIST"

    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load "$PLIST"
    ok "LaunchAgent loaded and running"

    echo
    bold "Useful commands:"
    echo "  📜 Tail logs:      tail -f $LOG_FILE"
    echo "  ⏸️  Stop:           launchctl unload $PLIST"
    echo "  ▶️  Start:          launchctl load $PLIST"
    echo "  🗑️  Uninstall:      launchctl unload $PLIST && rm $PLIST"
    ;;

  Linux)
    bold "Linux detected → installing systemd --user unit"
    UNIT_DIR="$HOME/.config/systemd/user"
    UNIT="$UNIT_DIR/slack-claude-bot.service"
    mkdir -p "$UNIT_DIR"

    cat > "$UNIT" <<EOF
[Unit]
Description=Slack Claude Bot
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO_DIR
ExecStart=$WRAPPER
Restart=always
RestartSec=5
StandardOutput=append:$LOG_FILE
StandardError=append:$ERR_FILE
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF
    ok "Unit written to $UNIT"

    systemctl --user daemon-reload
    systemctl --user enable --now slack-claude-bot.service
    ok "Service enabled and started"

    if command -v loginctl >/dev/null 2>&1; then
      loginctl enable-linger "$USER" >/dev/null 2>&1 || true
    fi

    echo
    bold "Useful commands:"
    echo "  📜 Tail logs:      journalctl --user -u slack-claude-bot -f"
    echo "  ⏸️  Stop:           systemctl --user stop slack-claude-bot"
    echo "  ▶️  Start:          systemctl --user start slack-claude-bot"
    echo "  🗑️  Uninstall:      systemctl --user disable --now slack-claude-bot && rm $UNIT"
    ;;

  *)
    fail "Unsupported OS: $(uname -s).  Start the bot manually with: npm start"
    ;;
esac

echo
ok "Bot installed as a service. It will auto-start when you log in."
