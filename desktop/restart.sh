#!/bin/bash
# Restart the HermesOffice bridge.
#
# Two modes, auto-detected:
#   * LaunchAgent installed  -> `launchctl kickstart -k` (launchd owns the process
#     and would race a plain kill: it respawns within seconds).
#   * no agent               -> kill whoever holds the port, then `nohup` a fresh
#     server with a log file.
#
# Usage: ./restart.sh [--debug] [--status] [--uninstall-agent]

set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="${HOBRIDGE_PORT:-3791}"
LABEL="com.hermes.hermesoffice-bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="${HOBRIDGE_LOG:-/tmp/hobridge.log}"

agent_loaded() { launchctl list 2>/dev/null | grep -q "	$LABEL$"; }

wait_ready() {
  local i
  for i in $(seq 1 30); do
    sleep 0.5
    if curl -sf "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
      return 0
    fi
  done
  return 1
}

case "${1:-}" in
  --status)
    echo "agent installed : $([ -f "$PLIST" ] && echo yes || echo no)"
    echo "agent loaded    : $(agent_loaded && echo yes || echo no)"
    echo "listening pid   : $(lsof -ti tcp:$PORT -sTCP:LISTEN 2>/dev/null | tr '\n' ' ' || echo none)"
    curl -s --max-time 4 "http://127.0.0.1:$PORT/health" && echo || echo "health: NO RESPONSE"
    exit 0
    ;;
  --install-agent)
    launchctl unload "$PLIST" 2>/dev/null
    lsof -ti tcp:$PORT -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null
    sleep 1
    launchctl load "$PLIST"
    wait_ready && echo "agent installed and serving on :$PORT" || { echo "FAILED"; tail -20 "$HOME/.hermes/logs/hermesoffice-bridge.error.log" 2>/dev/null; exit 1; }
    exit 0
    ;;
  --uninstall-agent)
    launchctl unload "$PLIST" 2>/dev/null
    rm -f "$PLIST"
    echo "agent removed — run ./restart.sh to start it manually"
    exit 0
    ;;
esac

# ── restart ───────────────────────────────────────────────────────────────
if agent_loaded; then
  echo "restarting via launchd ($LABEL)"
  launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl start "$LABEL"
else
  PIDS=$(lsof -ti tcp:$PORT -sTCP:LISTEN 2>/dev/null)
  if [ -n "$PIDS" ]; then
    echo "stopping pid(s): $PIDS"
    kill $PIDS 2>/dev/null
    sleep 1
    PIDS=$(lsof -ti tcp:$PORT -sTCP:LISTEN 2>/dev/null)
    [ -n "$PIDS" ] && kill -9 $PIDS 2>/dev/null
  fi
  sleep 1
  cd "$DIR" || exit 1
  nohup node server.mjs "$@" > "$LOG" 2>&1 &
  echo "started pid $! → $LOG"
fi

if wait_ready; then
  echo "ready: http://127.0.0.1:$PORT"
  curl -s "http://127.0.0.1:$PORT/health"
  echo
else
  echo "FAILED to become ready. Log:"
  tail -20 "$HOME/.hermes/logs/hermesoffice-bridge.error.log" 2>/dev/null || tail -20 "$LOG"
  exit 1
fi
