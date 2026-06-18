---
name: vss-manage-alerts
description: Use for VSS alert workflows — real-time monitoring, Alert-Bridge subscriptions, Slack notifications, incident queries, camera onboarding. Not for non-alert analytics.
license: Apache-2.0
metadata:
  version: "3.2.0"
  author: "NVIDIA Video Search and Summarization Team <vss-team@nvidia.com>"
  github-url: "https://github.com/NVIDIA-AI-Blueprints/video-search-and-summarization"
  tags: "nvidia blueprint operational"
---
## Purpose

Operate the VSS alert pipeline (mode detection, Alert-Bridge subscriptions, Slack notifications, queries, camera onboarding, verifier-prompt customization).

## Prerequisites

- Active VSS deployment reachable on `$HOST_IP` (see `vss-deploy-profile` and `references/`).
- NGC credentials in `$NGC_CLI_API_KEY` and `$NVIDIA_API_KEY` for any image pulls.
- `curl`, `jq`, and Docker available on the caller.

## Instructions

Follow the routing tables and step-by-step workflows below. Each section that ends in *workflow*, *quick start*, or *flow* is intended to be executed top-to-bottom. Detailed reference material lives in `references/` and helper scripts live in `scripts/` — call them via `run_script` when the skill points to a script by name.

## Examples

Runnable end-to-end scenarios live under `evals/` (each `*.json` manifest); inline `curl` blocks appear in each workflow below. Replay with `nv-base validate <this-skill-dir> --agent-eval`.

## Limitations

Requires the matching VSS profile/microservice deployed and reachable. NGC-hosted models/NIMs are subject to rate-limits, GPU-memory needs, and license terms; concurrency and storage limits depend on host hardware and the profile's compose file.

## Troubleshooting

- **Connection refused** → microservice not running: probe `/docs` or `/health`, redeploy via `vss-deploy-profile`.
- **HTTP 401/403 on NGC pulls** → missing/expired `NGC_CLI_API_KEY`: `docker login nvcr.io` and re-export the key.
- **OOM / model load failure** → insufficient GPU memory: use a smaller variant or `docker compose down` to free GPUs.

# VSS Alert Management

The alerts profile runs in one of two modes (chosen at `/vss-deploy-profile -p alerts -m {verification,real-time}`) — see **The Two Modes** table below. This skill routes by **deployed mode + user intent** (monitoring vs subscription CRUD vs Slack webhook).

## When to Use

- Start/stop a real-time alert on a sensor ("Start real-time alert for boxes dropped on warehouse_sample")
- Create/list/stop realtime subscription rules on Alert Bridge
- Set up or manage Slack incident notifications
- List or query detected incidents / alerts; check verdicts (confirmed/rejected/unverified)
- Add a new camera to the alerts pipeline; customize VLM-verifier prompts (CV mode)

---

## Deployment prerequisite

Requires the VSS **alerts** profile on `$HOST_IP` in either `verification` (CV) or `real-time` (VLM) mode.

```bash
# Either vss-rtvi-cv (CV mode) OR vss-rtvi-vlm (VLM mode) must be present.
curl -sf --max-time 5 "http://${HOST_IP}:8000/docs" >/dev/null \
  && docker ps --format '{{.Names}}' \
     | grep -qE '^(vss-rtvi-cv|vss-rtvi-vlm)$'
```

If the probe fails, ask which mode to deploy and hand off to `/vss-deploy-profile -p alerts -m <mode>` (decline → stop; pre-authorized autonomous deploy → run directly with `verification` by default). If it passes, detect the mode per Step 1.

---

## The Two Modes (Deploy-Time Choice)

| Mode | Deploy flag | Env (`.env`) | What runs | What is available |
|---|---|---|---|---|
| **CV (verification)** | `-m verification` | `MODE=2d_cv` | RT-CV (Grounding DINO) + Behavior Analytics + `alert-bridge` VLM verifier + **`rtvi-vlm`** | **Both** static CV pipeline (Workflow A) **and** dynamic VLM real-time alerts (Workflows B/D) |
| **VLM (real-time)** | `-m real-time` | `MODE=2d_vlm` | `alert-bridge` + `rtvi-vlm` | **Only** dynamic VLM real-time alerts (Workflows B/D) and `alert-bridge` backend. No static CV pipeline. |

**Switching modes** uses the `vss-deploy-profile` teardown + deploy flow with the other `-m` flag (VLM → CV adds the CV pipeline; CV → VLM tears it down). `rtvi-vlm` runs in both modes.

---

## Step 1 — Detect the Currently Deployed Mode

Before running any alert workflow, check which mode is live. Use **CV-only** containers as the signal — `vss-rtvi-vlm` is **not** a reliable mode signal because it runs in both modes.

```bash
# CV verification mode (vss-behavior-analytics + vss-rtvi-cv are CV-only)
docker ps --format '{{.Names}}' | grep -qx vss-behavior-analytics && echo "mode=CV"

# VLM real-time mode (no CV pipeline; vss-rtvi-vlm still runs)
docker ps --format '{{.Names}}' | grep -qx vss-behavior-analytics || \
  docker ps --format '{{.Names}}' | grep -qx vss-rtvi-vlm && echo "mode=VLM"
```

If `vss-behavior-analytics` is present → **CV mode** (which also has `vss-rtvi-vlm`).
If only `vss-rtvi-vlm` is present (and no CV pipeline) → **VLM mode**.
If neither matches, the alerts profile is not deployed — direct the user to the `vss-deploy-profile` skill.

Alternative signal (preferred when `docker ps` isn't accessible): check the profile's `generated.env`:

```bash
grep -E '^MODE=' deploy/docker/developer-profiles/dev-profile-alerts/generated.env
# MODE=2d_cv   → CV mode (full superset)
# MODE=2d_vlm  → VLM real-time mode (vss-rtvi-vlm only; no vss-rtvi-cv)
```

---

## Step 2 — Route by Deployed Mode

| Deployed mode | User asks about… | Action |
|---|---|---|
| **VLM real-time** | Slack webhook setup/status/test/stop | **Workflow E** — `references/alert-notify.md` |
| **VLM real-time** | rule CRUD, or a realtime alert on a sensor with a detection condition, or stop/delete a named alert (by `alert_type`/condition or rule ID) | **Workflow D** — `references/alert-subscriptions.md` (incl. two-step stop/confirm) |
| **CV verification** | subscription/rule CRUD or Slack/notification setup | Refuse — see canonical refusal text below |
| **CV or VLM** | generic start/stop monitoring **without** a detection condition | **Workflow B (VLM)** — call the VSS Agent; `rtvi-vlm` runs in both modes |
| **CV or VLM** | incident lookup / *what happened* (recent alerts, time-range, casual "any alerts today?") | **Workflow C (Query)** — works on both; **always run the query, never answer from memory** |
| **CV** | static CV alert onboarding / verdict-prompt customization | **Workflow A (CV)** — onboard RTSP via `vss-manage-video-io-storage`; pipeline auto-picks it up |
| **VLM** | a CV / behavior-analytics / PPE-rule alert needing the static CV pipeline | **Redeployment required** — confirm first, then `vss-deploy-profile -m verification` |

**Always confirm before triggering a redeploy.** A mode switch stops all currently-running monitoring and restarts services.

### Intent precedence (first match wins)

1. **Workflow E (Slack)** — Slack-specific keywords (`slack`, `webhook` + `slack`, `bot token`, `slack channel`). `notify` alone is **not** sufficient.
2. **Workflow D (Subscriptions)** — sensor **plus** a detection condition, rule CRUD keywords (`rule`, `subscription`, rule ID), **or stopping/deleting a named alert by type/condition** ("stop the PPE alert", "delete the collision rule"). A named `alert_type`/condition = an existing **rule** → D's two-step stop protocol (`GET /api/v1/realtime` → yes/no confirm → delete), never Workflow B.
3. **Workflow B (VLM monitoring)** — generic start/stop on a sensor with **no** detection condition and **no** alert-type qualifier ("start/stop real-time alert for sensor X"). A stop that names a type ("stop the **PPE** alert") is a rule stop → Workflow D.
4. **Workflow C (Query)** — incident lookup / *what happened* (`show/list incidents`, `recent alerts`, time-range queries, **and casual "any alerts…?" / "any alerts so far today?" / "what's been triggered?" phrasings**). Bare `alerts` (without `rule`/`subscription`/`active rules`) means **incidents** → Workflow C, never Workflow D.
5. **Workflow A (CV)** — CV deployment handling for anything not matched above.

> **`alerts` vs `alert rules` (C vs D) — pick exactly one, never both:**
> *what happened / has been triggered* (incidents) → **Workflow C**
> (`POST /generate`). *What
> rules/subscriptions are configured or active* → **Workflow D** (the
> **bare** `GET /api/v1/realtime`, no `/incidents`). Bare `alerts` =
> incidents (C); `alert rules` / `subscriptions` / `active rules` =
> inventory (D). Never answer from memory; run the one correct call —
> full endpoint detail in Workflow C below.

**Disambiguation (B vs D):** if a sensor is named with start/monitor language but the detection condition is unclear, ask:
> *"Do you want me to (a) create a persistent alert rule on Alert Bridge that keeps running until you delete it, or (b) start a one-time monitoring session via the VSS Agent?"*

**Stop routing (B vs D):** "Stop the **&lt;type&gt;** alert" (names an `alert_type`/condition like PPE, collision, fire) = stop a **subscription rule** → **Workflow D** (find via `GET /api/v1/realtime`, then the two-step stop/confirm protocol in `references/alert-subscriptions.md`; do **not** call `POST /generate`). A bare "stop real-time alert / stop monitoring on &lt;sensor&gt;" with **no** type qualifier = Workflow B.

If a prompt mixes workflows ("start monitoring and send to Slack"), ask one clarifying question to split execution order.

### CV-mode refusal text for D and E intents

When the deployed mode is CV verification and the user asks for an alert-subscription or Slack/notification intent, refuse with this message verbatim:

> "Alert subscriptions and Slack notifications are only supported in VLM real-time mode. Your current deployment is `<CV verification | not deployed>`. To use these features, redeploy with `/vss-deploy-profile -p alerts -m real-time` (note: switching tears down current CV monitoring)."

No auto-redeploy. The user decides whether to switch modes.

---

## Prereq for Either Mode: Sensor Must Be in VIOS

Both modes require the camera registered in VIOS first (via the `vss-manage-video-io-storage` skill):

- RTSP URL / IP camera → add it with `POST /sensor/add` (that skill's Section 6); record the `sensorId` / name.
- Named existing sensor → confirm it appears in `GET /sensor/list` before proceeding.

On **CV**, adding the RTSP is the *entire* onboarding step (pipeline auto-picks it up). On **VLM**, it is a prerequisite to Workflow B.

---

## The Agent `/generate` Endpoint

All VLM-flow actions and all query actions go through the VSS Agent's natural-language endpoint:

```bash
AGENT="http://<AGENT_ENDPOINT>"   # default http://localhost:8000 on the alerts profile

curl -s -X POST "$AGENT/generate" \
  -H "Content-Type: application/json" \
  -d '{"input_message": "<natural-language request>"}' | jq .
```

**Endpoint resolution:** use the agent endpoint from the active VSS deployment context. If unavailable, ask the user. Do not discover via filesystem.

**Availability check:** `curl -sf --connect-timeout 5 "$AGENT/docs"`.

Do not call the `rtvi-vlm` microservice endpoints directly — always go through the agent. The agent internally dispatches to `rtvi_vlm_alert`, `rtvi_prompt_gen`, and `video_analytics_mcp.get_incidents`.

---

## Workflow A — CV Mode (`-m verification` / `MODE=2d_cv`)

CV alerts are **deployment-driven, not request-driven** — there is no agent
call to "create" one.

1. Check if the sensor is in VIOS via `vss-manage-video-io-storage`'s `GET /sensor/list` (idempotent — don't blindly `POST /sensor/add`).
2. If missing, onboard via that skill's `POST /sensor/add`. The CV pipeline auto-picks up the stream once registered and online.
3. Confirm online: `curl -s "http://<VST_ENDPOINT>/vst/api/v1/sensor/<sensorId>/status" | jq .`
4. Alerts land in Elasticsearch (Behavior Analytics → `alert-bridge` verification per `alert_type_config.json`). Query with **Workflow C**.

A static-CV-pipeline alert on a VLM-only deployment is a mode mismatch — see the routing table above.

---

## Workflow B — VLM Real-time Monitoring (CV or VLM mode)

Generic start / stop intents through the VSS Agent for a named sensor
without a detection condition (if a condition is present, route to
Workflow D). `rtvi-vlm` runs in both modes.

```bash
# start: input_message = "Start real-time alert for sensor <id>"
# stop:  input_message = "Stop real-time alert for sensor <id>"
curl -s -X POST "$AGENT/generate" -H "Content-Type: application/json" \
  -d '{"input_message": "<start|stop> real-time alert for sensor <id>"}' | jq .
```

Under the hood: `rtvi_prompt_gen` → `rtvi_vlm_alert action="start"`.
Every chunk is captioned; a chunk whose VLM response contains `yes`/`true`
(case-insensitive) publishes an incident to `mdx-vlm-incidents`. Prompts
must force a Yes/No answer. A static-CV-pipeline request on a VLM-only
deployment is a mode mismatch — see the routing table.

---

## Workflow D — Alert Subscriptions (VLM real-time mode only)

Create / list / delete persistent realtime alert rules on Alert Bridge.
Route here when the prompt has rule keywords (`rule`, `subscription`, a rule
ID) **or** when it pairs a specific sensor with a specific detection
condition (e.g. "Set up a realtime alert on warehouse-dock-1 for PPE
violations", "Watch sensor entrance-1 for tailgating", "Stop rule
496aebd1-…").

**Not here:** generic start/stop without a condition (→ Workflow B) or Slack
operations (→ Workflow E).

Load and follow `references/alert-subscriptions.md` as the authoritative
playbook for subscription CRUD. VLM real-time mode only; refuse with the
canonical refusal text on CV.

---

## Workflow E — Slack Notifications (VLM real-time mode only)

Use when the user **explicitly mentions Slack or the webhook relay** (start/stop webhook server, check status/health, send a test message, set Slack channel/token). The word `notify` alone is **not** enough.

> **`alert-notify` (port 9090) ≠ `vss-alert-bridge` (`/api/v1/realtime`).**
> Do NOT touch `vss-alert-bridge` for Slack ops.

Routes here: "Set up Slack notifications", "Check if alert-notify is running", "Send a test alert to Slack". Does **not** route here: "Notify me when someone enters the zone" (→ D/B), "Alert and notify on my phone" (ambiguous — ask).

Load and follow `references/alert-notify.md`. Code lives in `scripts/alert-notify/`. VLM real-time mode only.

---

## Workflow C — Query / List Alerts (works on either mode)

Both CV- and VLM-generated alerts land in Elasticsearch and are
queryable via the agent's `video_analytics_mcp.get_incidents` tool. POST
natural-language requests to `$AGENT/generate` — "Show me recent alerts
for sensor X", "List confirmed alerts from the last hour", "Show
collision incidents from Camera_02 between `<ISO>` and `<ISO>`".

**Casual phrasings route here too.** Questions like "Any alerts so far
today?", "Any alerts today?", "What's been triggered?", or "Anything
detected lately?" are incident queries — issue a `POST /generate` (e.g.
`{"input_message": "List alerts from today"}`) and summarize the result.
**Never answer these from memory and never reply "no alerts" without
running the query.** A bare "alerts" question is *always* an incident
lookup (Workflow C), not a subscription-rule listing (Workflow D).

> **Do NOT list subscription rules for an incident query.** The **bare**
> `GET /api/v1/realtime` (no `/incidents`) lists *rules* (Workflow D) and
> is wrong for "what happened" — never call/probe it or load the Workflow
> D playbook for an incident query.
>
> **Empty result is a valid answer.** If no incidents match (e.g. a
> freshly deployed system with no activity yet), report that **none were
> found / the count is 0** for the requested period and STOP — do not fall
> back to listing rules or hunting other endpoints.

For
richer / non-natural-language filtering (sensor-level, time-series,
counts) use the **`vss-query-analytics` skill** (VA-MCP on port 9901).

### Verdict interpretation & CV verifier prompts (CV mode only)

CV alerts carry a VLM verification verdict (`confirmed` / `rejected` /
`unverified`); VLM real-time incidents have no separate verdict (the
trigger is itself a Yes/No VLM answer). CV-path verifier prompts are
customizable via `alert_type_config.json` (restart `alert-bridge` to
apply). See `references/cv-verifier-prompts.md` for the verdict table,
field meanings, and the prompt-customization rules.

---

## Cross-Skill Links

| Task | Skill |
|---|---|
| Deploy, redeploy, or switch alert mode | **`vss-deploy-profile`** — `-p alerts -m {verification,real-time}` |
| Add an RTSP/IP camera, list sensors, snapshots, clips | **`vss-manage-video-io-storage`** (Section 6 for Add Sensor) |
| Time-range incident / occupancy / PPE metrics from Elasticsearch | **`vss-query-analytics`** (VA-MCP :9901) |
| Detailed incident report from an alert | **`vss-generate-video-report`** |
| Subscriptions / Slack sub-workflows | `references/alert-subscriptions.md`, `references/alert-notify.md` (code in `scripts/alert-notify/`) |

---

## Gotchas

- **`alert-notify` (port 9090) ≠ `vss-alert-bridge`.** Slack ops → Workflow E (`alert-notify`); never route Slack to `vss-alert-bridge`'s `/api/v1/realtime`.
- **Workflow scope by mode:** A is CV-only; B and C work on either mode; D and E are VLM real-time only (refuse on CV with the canonical text).
- **Don't use `vss-rtvi-vlm` as a mode signal** — it runs in both modes. Use `vss-behavior-analytics` (CV-only) or the `MODE` env var.
- **A mode switch tears down the current deployment** — running VLM streams and un-persisted CV alert state are lost.
- **Always go through `$AGENT/generate`** — never call `rtvi-vlm` directly. The VLM trigger is a `"yes"`/`"true"` token match (case-insensitive); `rtvi_prompt_gen` enforces the Yes/No pattern, so don't hand-craft prompts that break it.
- **Sensor must already be in VIOS** for either mode (use `vss-manage-video-io-storage` for RTSP-only inputs).

bump:1
