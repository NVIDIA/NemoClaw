# Alert Notify

Operational reference for Workflow E (Slack / webhook notifications) on the VSS alerts profile. Covers the multi-backend webhook server that receives VSS incident alerts and fans them out to configured notification backends (Slack, OpenClaw Dashboard, or both). Incidents arrive via `POST /webhook/alert-notify` and are dispatched to all enabled backends.

## When to Use

This skill is invoked as a **sub-workflow** of the parent `alerts` skill (Workflow E). The parent routes here only when the user **explicitly mentions Slack or the webhook relay**. The word "notify" alone is not sufficient — it must co-occur with `slack`, `webhook`, or `bot token`.

**Precondition: VLM real-time mode only.** Parent SKILL verifies the deployed mode before invoking this playbook; assume the VLM (`-m real-time` / `MODE=2d_vlm`) profile is up. The parent's previous "Workflow E skips deployment probe" exception has been removed — E is now mode-gated like D. CV-mode deployments do not invoke this playbook (parent SKILL refuses with a redeploy hint).

- "Set up Slack notifications for incident alerts"
- "Start the alert Slack webhook"
- "Forward camera alerts to our Slack channel"
- "Send a test notification to Slack"
- "Check if the alert Slack webhook is running"
- "Stop the alert Slack webhook"
- "What's the status of the Slack notification service?"

**Not this skill** (handled by parent Workflow D or B instead):
- "Notify me when someone enters the zone" — alert creation, not Slack setup
- "Alert and notify on incidents" — no Slack/webhook keyword, ambiguous destination

---

## Setup

**Code directory:** `{baseDir}` resolves to `<alerts-skill-root>/scripts/alert-notify/`. All commands below use `{baseDir}` as the working directory.

```
scripts/alert-notify/
├── server.py                          # FastAPI multi-backend webhook server
├── notifier_base.py                   # Abstract base class for backends
├── slack_notifier.py                  # Slack notification backend
├── open_claw_dashboard_notifier.py    # OpenClaw Dashboard backend (WebSocket RPC)
├── incident_utils.py                  # Shared helpers (verdict labels, formatting)
├── requirements.txt
├── .env.example
├── .gitignore
└── .pip-packages/                     # auto-created by pip install --target (Step 2)
```

**Required environment variables:**

| Variable | Required | Description |
|---|---|---|
| `NOTIFY_BACKENDS` | No | Comma-separated backend list. Default: `dashboard`. Options: `slack`, `dashboard`, `slack,dashboard`. |
| `SLACK_BOT_TOKEN` | **Yes** (if Slack backend) | Slack Bot OAuth Token (`xoxb-...`). Create a Slack App at https://api.slack.com/apps with `chat:write` scope. |
| `SLACK_CHANNEL_ID` | **Yes** (if Slack backend) | Target Slack channel ID (e.g. `C07XXXXXXXX`). Find it in Slack: right-click channel -> View channel details -> Channel ID. |
| `OPENCLAW_GATEWAY_URL` | **Yes** (if Dashboard backend) | OpenClaw Gateway URL (e.g. `http://${HOST_IP}:18789`). |
| `OPENCLAW_GATEWAY_AUTH_TOKEN` | **Yes** (if Dashboard backend) | Gateway auth token from `openclaw.json`. |
| `WEBHOOK_HOST` | No | Server bind address. Default: `0.0.0.0` |
| `WEBHOOK_PORT` | No | Server port. Default: `9090` |
| `VST_ENDPOINT` | **Yes** | VST `host:port` (e.g. `10.63.144.174:30888`). Resolved by the agent via `vss-manage-video-io-storage` when starting the webhook. Used to generate video clip URLs for incidents without `info.videoSource`. |
| `VST_PUBLIC_URL_BASE` | No | Public base URL substituted for the VST host in playback video URLs (e.g. `https://7777-xbrxpi7ia.brevlab.com`). Set when clients reach VST through a Brev tunnel / reverse-proxy. If unset, URLs pass through unchanged. |

**Environment injection:** These variables can be provided in three ways (in order of precedence):

1. **OpenClaw config** (`~/.openclaw/openclaw.json`) — preferred for managed deployments:
   ```json
   {
     "skills": {
       "entries": {
         "alert-notify": {
           "enabled": true,
           "apiKey": "xoxb-your-slack-bot-token",
           "env": {
            "SLACK_CHANNEL_ID": "C07XXXXXXXX"
          }
        }
      }
    }
  }
  ```
   `apiKey` injects into `SLACK_BOT_TOKEN` automatically (via `primaryEnv`). Only `SLACK_CHANNEL_ID` needs explicit `env`.
2. **`.env` file** in `{baseDir}/.env`
3. **Shell environment** variables already exported

Before starting, confirm that `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, and `VST_ENDPOINT` are available. If any is missing, resolve it before proceeding:
- `SLACK_BOT_TOKEN` / `SLACK_CHANNEL_ID` — ask the user to provide them.
- `VST_ENDPOINT` — use the `vss-manage-video-io-storage` skill to discover the VST endpoint, or ask the user.

Do not start the server without all three variables set.

**Run all commands yourself** — never instruct the user to run commands manually.

---

## Start Webhook Server

Full end-to-end flow: check prerequisites -> install dependencies -> configure env -> start server -> verify health.

**CRITICAL: You MUST execute ALL steps in order. Do NOT skip Step 1 or Step 2. The server WILL fail if dependencies are missing.**

### Step 1 — Check Prerequisites

Verify Python 3.10+ and pip are available:

```bash
python3 --version && pip --version
```

If missing, report the error and ask the user to install Python.

### Step 2 — Install Dependencies (MANDATORY — always run before starting)

**You MUST run this step every time before starting the server.** Dependencies are not persisted across sandbox restarts and may be missing even if the server ran successfully before.

Install into a sandbox-writable location. The sandbox filesystem restricts writes to system `site-packages`, so use `--target` to install into `{baseDir}/.pip-packages`. The sandbox proxy does not allow CONNECT tunnels to PyPI, so unset the proxy variables for pip:

```bash
cd {baseDir}
env -u https_proxy -u HTTPS_PROXY -u http_proxy -u HTTP_PROXY \
  pip install --target {baseDir}/.pip-packages --no-cache-dir -r requirements.txt
```

Then verify the critical imports work before proceeding:

```bash
PYTHONPATH="{baseDir}/.pip-packages:${PYTHONPATH:-}" python3 -c "import fastapi, uvicorn, slack_sdk, httpx; print('Dependencies OK')"
```

If either command fails, do NOT proceed to Step 4. Report the error to the user.

> **Why `--target`?** The NemoClaw sandbox mounts `/usr` as read-only. System-wide `pip install` and `--break-system-packages` both fail. Installing into a writable directory under `{baseDir}` avoids the restriction without elevated permissions.
>
> **Why `env -u ...proxy`?** The sandbox proxy (`10.200.0.1:3128`) blocks CONNECT tunnels to `pypi.org` regardless of network policy. Unsetting the proxy variables lets pip connect directly — the sandbox network allows outbound HTTPS to PyPI.

### Step 3 — Configure Environment

Check if `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, and `VST_ENDPOINT` are set (via OpenClaw `skills.entries` injection, `.env` file, or shell env).

**For Slack credentials** — if `SLACK_BOT_TOKEN` or `SLACK_CHANNEL_ID` is missing, ask the user:

> "I need two things to connect to Slack:
> 1. **Slack Bot Token** (`SLACK_BOT_TOKEN`) — the `xoxb-...` token from your Slack App
> 2. **Slack Channel ID** (`SLACK_CHANNEL_ID`) — the channel where alerts should be posted
>
> You can set them in `~/.openclaw/openclaw.json` under `skills.entries.alert-notify.env`, or in a `.env` file at `{baseDir}/.env`."

**For VST endpoint** — if `VST_ENDPOINT` is missing, use the `vss-manage-video-io-storage` skill to discover it. Follow the skill's availability check to find the VST `host:port`. If VST is not deployed or unreachable, ask the user:

> "I need the VST endpoint (`host:port`) to resolve video clip URLs. What is the VST address?"

Once all three values are available, write the `.env` file:

```bash
cat > {baseDir}/.env << 'EOF'
SLACK_BOT_TOKEN=<token>
SLACK_CHANNEL_ID=<channel_id>
VST_ENDPOINT=<host>:<port>
EOF
```

**Do not start the server** until `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, and `VST_ENDPOINT` are all set.

### Step 4 — Start the Server

Set `PYTHONPATH` so Python finds packages installed in Step 2, then start the server:

```bash
cd {baseDir}
export PYTHONPATH="{baseDir}/.pip-packages:${PYTHONPATH:-}"
nohup python3 server.py > webhook.log 2>&1 &
echo $!
```

Capture the PID for later stop/status operations.

### Step 5 — Verify Health

Wait 3 seconds for the server to start, then check health:

```bash
sleep 3
curl -sf http://localhost:9090/webhook/alert-notify/health | jq .
```

**Expected response:**

```json
{
  "status": "healthy",
  "uptime_seconds": 3.1,
  "slack_connected": true,
  "channel_id": "C07XXXXXXXX",
  "notifications_sent": 0,
  "last_error": null
}
```

If the health check fails, check `webhook.log` for errors:

```bash
tail -20 {baseDir}/webhook.log
```

**On success, report to the user:**

> "Alert notification server is running on `http://localhost:9090`.
> - Webhook endpoint: `POST http://localhost:9090/webhook/alert-notify`
> - Health check: `GET http://localhost:9090/webhook/alert-notify/health`
> - Active backends: `<NOTIFY_BACKENDS>`
>
> Incidents POSTed to the webhook endpoint will be forwarded to all configured backends."

---

## Check Status

```bash
curl -sf http://localhost:9090/webhook/alert-notify/status | jq .
```

**Response fields:**

| Field | Description |
|---|---|
| `status` | `running` if the server is active |
| `uptime_seconds` | How long the server has been running |
| `started_at` | ISO timestamp when the server started |
| `slack.connected` | Whether the Slack client is authenticated |
| `slack.channel_id` | Target Slack channel |
| `stats.notifications_sent` | Total notifications sent since startup |
| `stats.last_error` | Last error message (null if none) |

If the request fails (connection refused), the server is not running. Report:

> "The alert Slack webhook is not running. Would you like me to start it?"

---

## Send Test Notification

Send a test notification to verify end-to-end Slack integration:

```bash
curl -sf -X POST http://localhost:9090/webhook/alert-notify/test | jq .
```

**On success:**

```json
{
  "status": "sent",
  "message": "Test notification delivered to Slack",
  "slack_ts": "<epoch>.000100",
  "channel": "C07XXXXXXXX"
}
```

Report to the user:

> "Test notification sent to Slack channel `<channel_id>`. Please check the channel to confirm it arrived."

If it fails, check the error and report the issue.

---

## Stop Webhook Server

Two methods — API-based (preferred) or process-based (fallback):

### Method 1 — Stop via API

```bash
curl -sf -X POST http://localhost:9090/webhook/alert-notify/stop | jq .
```

### Method 2 — Stop via Process (fallback)

If the API is unresponsive, kill the process:

```bash
pkill -f "python3 server.py"
```

Or if you captured the PID during start:

```bash
kill <PID>
```

After stopping, verify:

```bash
curl -sf http://localhost:9090/webhook/alert-notify/health || echo "Server stopped"
```

Report to the user:

> "Alert Slack webhook has been stopped."

---

## Incident Payload Format

The webhook accepts VSS incident payloads via `POST /webhook/alert-notify`. The following fields are extracted for notification:

| Slack Field | Source Path | Description |
|---|---|---|
| **Verdict** | `info.verdict` | Alert verdict: confirmed, rejected, verification-failed, not-confirmed |
| **Category** | `category` | Alert category (e.g. `protective_hat_violation`) |
| **Sensor ID** | `sensorId` | UUID of the sensor that generated the alert |
| **Place** | `place.name` | Human-readable location name |
| **Timestamp** | `timestamp` | ISO 8601 timestamp of the incident |
| **VLM Reasoning** | `info.reasoning` | Vision Language Model reasoning explanation |
| **Video URL** | `info.videoSource` | Link to the video evidence clip. If missing, use the `vss-manage-video-io-storage` skill to resolve a clip URL before posting (see [Video URL Resolution via vss-manage-video-io-storage](#video-url-resolution-via-vss-manage-video-io-storage)). |

Missing or null fields are displayed as "N/A" in the Slack message.

### Slack Message Layout

The rich Slack notification includes:

1. **Verdict & Category** — Verdict with status emoji (Confirmed / Rejected / Verification Failed / Not Confirmed) and category tag
2. **Sensor, Place & Timestamp** — Sensor ID, location name, and formatted time
3. **VLM Reasoning** — Blockquote with the model's reasoning
4. **Detection Prompt** — The original detection prompt
5. **Video Evidence** — Clickable link to the video clip

The message attachment color reflects the verdict: red for Confirmed, green for Rejected, yellow for Verification Failed, grey for Not Confirmed. The fallback title (shown in Slack notifications/previews) is `⚠ <Category> — <Verdict> at <Place>`.

---

## Webhook API Reference

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/webhook/alert-notify` | Receive incident and fan out to all backends |
| `POST` | `/webhook/alert-notify-slack` | Legacy alias (backwards-compatible) |
| `GET` | `/webhook/alert-notify/health` | Health check |
| `GET` | `/webhook/alert-notify/status` | Detailed service status with per-backend breakdown |
| `POST` | `/webhook/alert-notify/test` | Send test notification through all backends |
| `POST` | `/webhook/alert-notify/stop` | Gracefully stop the server |

---

## Error Handling

All errors must be translated into plain language. Never show raw HTTP responses or stack traces to the user.

| Scenario | User-facing message |
|---|---|
| `SLACK_BOT_TOKEN` not set | "The Slack bot token is not configured. Please provide your `SLACK_BOT_TOKEN` (starts with `xoxb-`)." |
| `SLACK_CHANNEL_ID` not set | "The Slack channel ID is not configured. Please provide the `SLACK_CHANNEL_ID` where alerts should be sent." |
| Slack auth fails | "Could not authenticate with Slack. Please verify the bot token is valid and the app has `chat:write` permission." |
| Slack channel not found | "The Slack channel `<id>` was not found. Please verify the channel ID and ensure the bot is invited to the channel." |
| Webhook server not reachable | "The alert Slack webhook is not running. Would you like me to start it?" |
| Invalid incident payload | "The incident payload was not valid JSON. Please check the data being sent." |
| Slack API rate limit | "Slack rate limit reached. The notification will be retried. Please wait a moment." |

---

## Tips

- **Bot must be in channel:** The Slack bot must be invited to the target channel. In Slack, type `/invite @YourBotName` in the channel.
- **Port conflicts:** If port 9090 is in use, set `WEBHOOK_PORT` to a different value in `.env`.
- **Logs:** Server logs are written to `webhook.log` in `{baseDir}` when started via `nohup`.
- **Multiple channels:** To send to multiple channels, run separate instances with different `SLACK_CHANNEL_ID` values and ports.
- **Integration with Alert Bridge:** Configure Alert Bridge to send incident webhooks to `http://<webhook-host>:9090/webhook/alert-notify` (legacy `/webhook/alert-notify-slack` also works).

---

## Video URL Resolution via vss-manage-video-io-storage

The webhook server **automatically** resolves video clip URLs for incidents that lack `info.videoSource`. The `VST_ENDPOINT` is required and resolved by the agent via `vss-manage-video-io-storage` at startup (Step 3).

### How it Works

```
Agent starts webhook
  └─ Uses vss-manage-video-io-storage to discover VST endpoint (host:port)
  └─ Sets VST_ENDPOINT in .env (required — server won't start without it)
  └─ Starts server.py (reads VST_ENDPOINT on boot)

Alert Bridge sends incident -> webhook server
  ├─ info.videoSource exists? -> use it directly
  └─ info.videoSource missing?
       └─ server queries VST for a temporary clip URL (sensorId + time range)
```

The agent uses `vss-manage-video-io-storage` only at **startup** to discover the VST endpoint. After that, the server resolves video URLs autonomously per-incident — no agent involvement needed.

### When Video Resolution is Skipped

- Incident has no `sensorId` or no time range (`timestamp` / `end`)
- VST returns an error for the given sensor/time range

The notification is always sent regardless — the video link is best-effort. Check `webhook.log` for resolution warnings.

---

## Cross-Reference

- **vss-manage-video-io-storage** — Sensor lookup and video clip URL resolution via VST (used for video evidence fallback)
- **alert-subscriptions** — Create and manage realtime alert rules that generate the incidents forwarded by this skill
