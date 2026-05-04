#!/usr/bin/env bash
# ============================================================
# Install the bot as a service that auto-starts and always listens.
#  - macOS  -> launchd (LaunchAgent in ~/Library/LaunchAgents)
#  - Linux  -> systemd --user
# ============================================================
set -euo pipefail

cd "$(dirname "$0")"
REPO_DIR="$(pwd)"
LABEL="com.user.slack-claude-bot"

bold()  { printf "\033[1m%s\033[0m\n" "$1"; }
ok()    { printf "  ✅  %s\n" "$1"; }
fail()  { printf "  ❌  %s\n" "$1"; exit 1; }

# Find absolute paths so launchd/systemd (minimal PATH) can run them.
NODE_BIN="$(command -v node || true)"
[ -z "$NODE_BIN" ] && fail "node not found in PATH"
[ -f "$REPO_DIR/.env" ] || fail "Missing .env — run ./setup.sh first"
[ -d "$REPO_DIR/node_modules" ] || fail "Missing node_modules — run ./setup.sh first"

mkdir -p "$REPO_DIR/logs"
LOG_FILE="$REPO_DIR/logs/bot.log"
ERR_FILE="$REPO_DIR/logs/bot.err"

case "$(uname -s)" in
  Darwin)
    bold "macOS detected → installing LaunchAgent"
    PLIST_DIR="$HOME/Library/LaunchAgents"
    PLIST="$PLIST_DIR/$LABEL.plist"
    mkdir -p "$PLIST_DIR"

    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$REPO_DIR/index.js</string>
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
ExecStart=$NODE_BIN $REPO_DIR/index.js
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
