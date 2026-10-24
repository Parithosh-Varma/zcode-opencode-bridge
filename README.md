# ZCode → OpenCode Bridge

Use ZCode's free GLM token pool from [OpenCode](https://opencode.ai).

This is an unofficial compatibility bridge. It runs inside the ZCode desktop app's agent process, captures the app's own model-request headers and official system prompt, and exposes a local Anthropic-compatible endpoint that OpenCode can use.

> [!WARNING]
> This project is unofficial and is not affiliated with ZCode, Z.ai, or OpenCode.
> It may stop working when the ZCode app or gateway changes, and using it may
> violate ZCode's terms of service. Use your own account and plan. No warranty.

## How it works

```text
OpenCode (provider: zcode)
        │  POST /messages
        ▼
127.0.0.1:8789  front proxy
  • removes OpenCode's system prompt
  • adds a short note to the first user message
        │
        ▼
127.0.0.1:8788  bridge (inside ZCode's agent process)
  • injects the first two blocks of ZCode's official system prompt
  • copies the app's metadata and max_tokens cap
  • forwards with the app's captured request headers
        │
        ▼
https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages
```

The ZCode gateway rejects requests that contain a non-ZCode top-level `system`
prompt:

```json
{"code":3012,"msg":"request has been blocked due to unusual activity."}
```

The front proxy removes OpenCode's system prompt. The bridge then inserts the
official ZCode identity prompt captured from the app, so the gateway accepts the
request. OpenCode's tools and messages are left intact.

## Requirements

- macOS
- ZCode desktop app installed (tested with ZCode 3.16.3)
- Node.js 18+ (Node 24 recommended)
- OpenCode with a custom Anthropic provider

## Install

```sh
git clone https://github.com/Parithosh-Varma/zcode-opencode-bridge.git
cd zcode-opencode-bridge
./install.sh
```

The installer:

- copies the installed ZCode agent into
  `~/.config/opencode/zcode-bridge/agent` and injects `zcode-http-hook.cjs`
- copies the bridge and front proxy
- creates `start-zcode.sh` and `start-front.sh`
- installs and starts a LaunchAgent for the front proxy
  (`com.zcode-bridge.front`)

Use a custom directory:

```sh
ZCODE_BRIDGE_DIR="$HOME/zcode-bridge" ./install.sh
```

Skip the LaunchAgent and run the front proxy manually:

```sh
./install.sh --no-launchd
```

## Start ZCode correctly

The bridge only exists when ZCode is started with the patched agent as its
working directory. Quit any running ZCode instance, then run:

```sh
~/.config/opencode/zcode-bridge/start-zcode.sh
```

Do **not** open ZCode from the Dock while using the bridge: the Dock launch uses
the original agent and will not start the bridge.

After ZCode starts, open a task and send one message (for example, `hi`). This
lets the hook capture the app's request headers and official system prompt.

Check readiness:

```sh
curl -s http://127.0.0.1:8789/health
```

Expected when ready:

```json
{"ok":true,"front":{...},"bridge":{"ok":true,"hasTemplate":true,"hasHeaders":true}}
```

## Configure OpenCode

Merge `opencode.json.example` into `~/.config/opencode/opencode.json`:

```json
{
  "provider": {
    "zcode": {
      "npm": "@ai-sdk/anthropic",
      "name": "ZCode Free Pool",
      "options": {
        "baseURL": "http://127.0.0.1:8789",
        "apiKey": "zcode-bridge"
      },
      "models": {
        "GLM-5.3-Flash": {
          "name": "GLM-5.3-Flash (ZCode free pool)"
        },
        "GLM-5.3": {
          "name": "GLM-5.3 (ZCode free pool)"
        }
      }
    }
  }
}
```

Then select `zcode/GLM-5.3-Flash` in the model picker, or run:

```sh
opencode run --model zcode/GLM-5.3-Flash "Say exactly OK"
```

Tool use works; for example:

```sh
opencode run --model zcode/GLM-5.3-Flash \
  "Use the bash tool to run 'echo BRIDGE_OK' and report the output."
```

## Troubleshooting

### `503 bridge_not_ready`

The bridge has not captured the app's model request yet, or the front proxy
cannot reach the bridge.

1. Confirm ZCode was started with `start-zcode.sh`, not from the Dock.
2. Send a message in a ZCode task and wait for the reply.
3. Check `curl -s http://127.0.0.1:8789/health`.
4. If the front proxy is not running:
   ```sh
   launchctl kickstart -k "gui/$(id -u)/com.zcode-bridge.front"
   ```

### `405` with `"code":3012`

The gateway did not receive the official ZCode system prompt. Usually this means
the bridge was not warmed up, or ZCode was launched with the unpatched agent.
Restart ZCode with `start-zcode.sh` and send one message in a task.

### `EADDRINUSE` / port 8788 or 8789 already in use

Another ZCode instance or front proxy is already running. Quit all ZCode
instances, then restart with `start-zcode.sh`. If you previously ran a manual
bridge, stop that process first.

### OpenCode cannot connect (`ECONNREFUSED`)

Start the front proxy:

```sh
~/.config/opencode/zcode-bridge/start-front.sh
```

or reload the LaunchAgent:

```sh
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.zcode-bridge.front.plist 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.zcode-bridge.front.plist
```

### The model ignores OpenCode-specific instructions

This bridge intentionally drops OpenCode's system prompt and uses ZCode's
official identity prompt. OpenCode's tool schemas and conversation are still
sent, so tool use works, but some OpenCode-specific behaviors may differ.

## Privacy and security

- The hook keeps the app's headers in memory. It does not write credentials to
  disk.
- `ZCODE_DEBUG=1` enables metadata-only logs in
  `$ZCODE_BRIDGE_DIR/logs`. Headers and message bodies are not logged.
- Both servers bind to `127.0.0.1` only. Any local process can use the bridge
  while ZCode is running, so do not expose the ports or run untrusted software
  on the same account.
- This repository contains no credentials and does not redistribute the ZCode
  app bundle. The installer copies the agent from your own ZCode installation.

## Uninstall

```sh
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.zcode-bridge.front.plist 2>/dev/null || true
rm -f ~/Library/LaunchAgents/com.zcode-bridge.front.plist
rm -rf ~/.config/opencode/zcode-bridge
```

Then quit ZCode and remove the `zcode` provider from your OpenCode config.

## Limitations

- ZCode must stay running while the bridge is in use.
- Only the ZCode plan endpoint is forwarded; this is not a general Z.ai API
  proxy.
- Tested on macOS with the Intel build of ZCode 3.16.3 (running under Rosetta on
  Apple Silicon). Other versions may use different agent paths or prompt rules.
- The gateway may change its risk-control rules at any time.

## License

MIT. See [LICENSE](LICENSE).
