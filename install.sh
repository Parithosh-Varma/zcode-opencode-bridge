#!/bin/sh
set -eu

usage() {
  cat <<'EOF'
Usage: ./install.sh [--no-launchd]

Installs the ZCode -> OpenCode bridge into:
  ${ZCODE_BRIDGE_DIR:-$HOME/.config/opencode/zcode-bridge}

Options:
  --no-launchd   Do not install/start the front-proxy LaunchAgent.
  -h, --help     Show this help.
EOF
}

INSTALL_LAUNCHD=1
for arg in "$@"; do
  case "$arg" in
    --no-launchd) INSTALL_LAUNCHD=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 1 ;;
  esac
done

REPO_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BRIDGE_DIR=${ZCODE_BRIDGE_DIR:-"$HOME/.config/opencode/zcode-bridge"}
APP_GLM=${ZCODE_APP_GLM:-"/Applications/ZCode.app/Contents/Resources/glm"}
APP_BIN=${ZCODE_APP_BIN:-"/Applications/ZCode.app/Contents/MacOS/ZCode"}

if [ ! -f "$APP_GLM/zcode.cjs" ]; then
  echo "ZCode agent not found at: $APP_GLM/zcode.cjs" >&2
  echo "Set ZCODE_APP_GLM to the app's Contents/Resources/glm directory." >&2
  exit 1
fi
if [ ! -x "$APP_BIN" ]; then
  echo "ZCode executable not found at: $APP_BIN" >&2
  echo "Set ZCODE_APP_BIN to the ZCode executable." >&2
  exit 1
fi

NODE_BIN=$(command -v node || true)
if [ -z "$NODE_BIN" ]; then
  echo "Node.js was not found in PATH. Install Node 18+ and rerun." >&2
  exit 1
fi
NODE_MAJOR=$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js 18+ is required (found $("$NODE_BIN" -v))." >&2
  exit 1
fi

mkdir -p "$BRIDGE_DIR/logs"
BRIDGE_DIR=$(CDPATH= cd -- "$BRIDGE_DIR" && pwd)
AGENT_DIR="$BRIDGE_DIR/agent"
DIST_DIR="$AGENT_DIR/apps/zcode-cli/packages/cli/dist"
HOOK="$BRIDGE_DIR/zcode-http-hook.cjs"
FRONT="$BRIDGE_DIR/zcode-front-proxy.mjs"

mkdir -p "$DIST_DIR"

install -m 755 "$REPO_DIR/zcode-http-hook.cjs" "$HOOK"
install -m 755 "$REPO_DIR/zcode-front-proxy.mjs" "$FRONT"

# Copy the app's agent bundle locally. The app itself is not modified.
cp "$APP_GLM/zcode.cjs" "$DIST_DIR/zcode.cjs"
chmod 755 "$DIST_DIR/zcode.cjs"

if [ -f "$APP_GLM/.node-bundle-meta.json" ]; then
  cp "$APP_GLM/.node-bundle-meta.json" "$DIST_DIR/.node-bundle-meta.json"
  cp "$APP_GLM/.node-bundle-meta.json" "$AGENT_DIR/.node-bundle-meta.json"
fi

ln -sfn "$APP_GLM/packages" "$AGENT_DIR/packages"
ln -sfn "$APP_GLM/packages" "$DIST_DIR/packages"
ln -sfn "apps/zcode-cli/packages/cli/dist/zcode.cjs" "$AGENT_DIR/zcode.cjs"

# Inject the hook require immediately after the shebang. Remove any previous
# hook injection so re-running the installer stays idempotent.
"$NODE_BIN" - "$DIST_DIR/zcode.cjs" "$HOOK" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const hook = process.argv[3];
let src = fs.readFileSync(file, 'utf8');
src = src
  .split('\n')
  .filter((line) => !line.includes('zcode-http-hook.cjs'))
  .join('\n');
const injection = 'try{require(' + JSON.stringify(hook) + ')}catch(e){}';
const shebang = '#!/usr/bin/env node\n';
if (src.startsWith(shebang)) {
  src = shebang + injection + '\n' + src.slice(shebang.length);
} else {
  src = injection + '\n' + src;
}
fs.writeFileSync(file, src);
NODE

# Start scripts. Use Node to quote paths safely.
"$NODE_BIN" - "$BRIDGE_DIR/start-zcode.sh" "$BRIDGE_DIR" "$AGENT_DIR" "$APP_BIN" <<'NODE'
const fs = require('fs');
const [file, dir, agent, app] = process.argv.slice(2);
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
fs.writeFileSync(file, [
  '#!/bin/sh',
  'set -eu',
  'export ZCODE_BRIDGE_DIR=' + q(dir),
  'cd ' + q(agent),
  'exec ' + q(app) + ' "$@"',
  '',
].join('\n'));
NODE
chmod 755 "$BRIDGE_DIR/start-zcode.sh"

"$NODE_BIN" - "$BRIDGE_DIR/start-front.sh" "$BRIDGE_DIR" "$NODE_BIN" "$FRONT" <<'NODE'
const fs = require('fs');
const [file, dir, node, front] = process.argv.slice(2);
const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
fs.writeFileSync(file, [
  '#!/bin/sh',
  'set -eu',
  'export ZCODE_BRIDGE_DIR=' + q(dir),
  'exec ' + q(node) + ' ' + q(front),
  '',
].join('\n'));
NODE
chmod 755 "$BRIDGE_DIR/start-front.sh"

PLIST="$HOME/Library/LaunchAgents/com.zcode-bridge.front.plist"
if [ "$INSTALL_LAUNCHD" -eq 1 ]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  "$NODE_BIN" - "$PLIST" "$BRIDGE_DIR/start-front.sh" "$BRIDGE_DIR/logs" <<'NODE'
const fs = require('fs');
const [file, start, logs] = process.argv.slice(2);
const esc = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');
fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.zcode-bridge.front</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${esc(start)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${esc(logs)}/front.out</string>
  <key>StandardErrorPath</key><string>${esc(logs)}/front.err</string>
</dict>
</plist>
`);
NODE

  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  launchctl bootout "gui/$(id -u)/com.zcode-bridge.front" 2>/dev/null || true
  if ! launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
    launchctl unload "$PLIST" 2>/dev/null || true
    launchctl load -w "$PLIST"
  fi
fi

if [ "$INSTALL_LAUNCHD" -eq 1 ]; then
  FRONT_STATUS="LaunchAgent: com.zcode-bridge.front (started)"
else
  FRONT_STATUS="LaunchAgent: not installed (run start-front.sh manually)"
fi

cat <<EOF

Installed to: $BRIDGE_DIR

Next steps:
  1. Quit ZCode completely.
  2. Start it with:
       $BRIDGE_DIR/start-zcode.sh
     (Do not open ZCode from the Dock while using the bridge.)
  3. In ZCode, open a task and send one message (for example: hi).
     This captures the app's request headers and official system prompt.
  4. Check readiness:
       curl -s http://127.0.0.1:8789/health
     Expect "ok":true.
  5. Add the provider from opencode.json.example to your OpenCode config,
     then select zcode/GLM-5.3-Flash.

Front proxy:
  $BRIDGE_DIR/start-front.sh
  $FRONT_STATUS
EOF
