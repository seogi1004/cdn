#!/bin/bash
set -euo pipefail

CMD="${1:-status}"

SANDBOX_DIR="/Users/fern/sandbox"
LOG_DIR="${SANDBOX_DIR}/logs"
TMPDIR="${LOG_DIR}/tmp"
GATEWAY_PORT="18789"
OPENCLAW_BIN="/Users/fern/.nvm/versions/node/v24.13.1/bin/openclaw"

LABEL="ai.openclaw.gateway"
PLIST_PATH="/Users/fern/Library/LaunchAgents/${LABEL}.plist"

#/** @description launchd 환경에서 필요한 PATH를 보강한다. */
REQUIRED_PATH="/Users/fern/.nvm/versions/node/v24.13.1/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

verify_mount() {
  #/** @description 샌드박스 마운트가 준비될 때까지 대기한다. */
  local MOUNT_POINT="/Users/fern/sandbox"
  local EXPECTED_VOLUME="FernSandbox"
  local DISKUTIL="/usr/sbin/diskutil"

  for _ in $(seq 1 15); do
    if INFO="$($DISKUTIL info "$MOUNT_POINT" 2>/dev/null)"; then
      local VOLUME_NAME MOUNT_PATH
      VOLUME_NAME="$(echo "$INFO" | awk -F': *' '/Volume Name/ {print $2}')"
      MOUNT_PATH="$(echo "$INFO" | awk -F': *' '/Mount Point/ {print $2}')"
      if [ "$VOLUME_NAME" = "$EXPECTED_VOLUME" ] && [ "$MOUNT_PATH" = "$MOUNT_POINT" ]; then
        return 0
      fi
    fi
    sleep 2
  done

  echo "[ERROR] Sandbox mount not ready."
  exit 78
}

cleanup() {
  #/** @description 18789를 점유한 fern 프로세스에 TERM만 보낸다. (kill -9 금지) */
  local pids
  pids=$(/usr/sbin/lsof -nP -iTCP:${GATEWAY_PORT} -sTCP:LISTEN -u fern -t 2>/dev/null || true)
  for pid in $pids; do
    [ "$pid" != "$$" ] && kill -TERM "$pid" 2>/dev/null || true
  done
}

gateway() {
  #/** @description launchd가 호출하는 게이트웨이 엔트리포인트. */
  verify_mount
  mkdir -p "${LOG_DIR}" "${TMPDIR}"

  export HOME="/Users/fern"
  export PATH="${REQUIRED_PATH}:${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"

  cd "${SANDBOX_DIR}"

  cleanup
  sleep 1

  if [ ! -x "$OPENCLAW_BIN" ]; then
    echo "[ERROR] openclaw binary not found at $OPENCLAW_BIN"
    exit 127
  fi

  NODE_BIN="/Users/fern/.nvm/versions/node/v24.13.1/bin/node"
  exec "$NODE_BIN" "$OPENCLAW_BIN" gateway --bind loopback --port "${GATEWAY_PORT}"
}

install_plist() {
  #/** @description 정상 XML plist를 생성한다. (깨진 plist 금지) */
  mkdir -p /Users/fern/Library/LaunchAgents

  cat > "$PLIST_PATH" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/Users/fern/run-openclaw.sh</string>
    <string>gateway</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>/Users/fern</string>
    <key>PATH</key>
    <string>${REQUIRED_PATH}</string>
  </dict>

  <key>StandardOutPath</key>
  <string>/Users/fern/sandbox/logs/openclaw-launchd.out</string>

  <key>StandardErrorPath</key>
  <string>/Users/fern/sandbox/logs/openclaw-launchd.err</string>
</dict>
</plist>
PLIST_EOF
}

start() {
  #/** @description LaunchAgent를 갱신 후 로드한다. (fern UID를 명시적으로 사용) */
  local FERN_UID
  FERN_UID="$(id -u fern)"

  install_plist
  launchctl bootout "gui/${FERN_UID}/${LABEL}" 2>/dev/null || true
  sleep 1
  launchctl bootstrap "gui/${FERN_UID}" "$PLIST_PATH"
  echo "LaunchAgent (${LABEL}) started"
}

stop() {
  #/** @description LaunchAgent를 내리고 포트를 정리한다. */
  local FERN_UID
  FERN_UID="$(id -u fern)"

  launchctl bootout "gui/${FERN_UID}/${LABEL}" 2>/dev/null || true
  sleep 1
  cleanup
  echo "Stopped"
}

status() {
  #/** @description LaunchAgent/포트 리슨 상태를 출력한다. */
  local FERN_UID
  FERN_UID="$(id -u fern)"

  echo "=== OpenClaw Status ==="
  if launchctl print "gui/${FERN_UID}/${LABEL}" >/dev/null 2>&1; then
    echo "LaunchAgent: ACTIVE"
  else
    echo "LaunchAgent: INACTIVE"
  fi

  if /usr/sbin/lsof -nP -iTCP:${GATEWAY_PORT} -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Gateway: LISTENING (${GATEWAY_PORT})"
  else
    echo "Gateway: CLOSED"
  fi
}

restart() {
  #/** @description stop→start로 재기동한다. */
  stop
  sleep 2
  start
}

case "$CMD" in
  start) start ;;
  stop) stop ;;
  restart) restart ;;
  status) status ;;
  gateway) gateway ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|gateway}"
    exit 1
    ;;
esac
