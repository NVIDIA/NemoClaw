# Runtime Controls and Sandbox Mutability

import { AgentOnly } from "../_components/AgentGuide";

This page explains which parts of a running NemoClaw sandbox can change immediately and which changes require a rebuild or re-onboard.

## What You Can Change at Runtime

NemoClaw applies its security posture in three layers: what onboarding bakes into the sandbox image, what the running sandbox can hot-reload, and what requires a rebuild or re-onboard.
The table below maps each commonly changed item to the layer that owns it and the command that changes it.

<AgentOnly variant="openclaw">

| Item | When the change takes effect | How to change it |
|---|---|---|
| Inference provider (cloud, NVIDIA Endpoints, local Ollama / vLLM, compatible-endpoint, …) | Rebuild required (`openclaw.json` is locked at sandbox creation) | `nemoclaw <name> rebuild` after picking a different provider with `nemoclaw inference set` |
| Inference model on the current provider | Rebuild required for OpenClaw; hot-reloadable for managed routers | `nemoclaw <name> rebuild` (OpenClaw) or `nemoclaw inference set` (router-based) |
| Sub-agent (Hermes / OpenClaw / …) | Re-onboard required (the sub-agent and its workspace are baked at onboard) | `nemoclaw onboard --recreate-sandbox` |
| Network policy preset (slack, discord, telegram, brave, …) | Runtime. Applies on the next request; rebuild only required if the preset adds bind-mounted secrets | `nemoclaw <name> policy-add <preset>` / `policy-remove <preset>` |
| Network allow-list (custom hosts) | Runtime. Picks up at next request | `openshell policy set` or interactive approval prompt at the gateway |
| Channel tokens (Slack / Discord / Telegram bot credentials) | Rebuild required (tokens are baked into the sandbox image at onboard so they never leave the host clear-text) | `nemoclaw <name> channels add <channel>` then accept the rebuild prompt |
| Channel enable/disable (turn a configured channel off without removing the token) | Rebuild required (`openclaw.json` is the source of truth at runtime, see #3453) | `nemoclaw <name> channels stop <channel>` then rebuild |
| Dashboard forward port | Runtime. Port is re-resolved on next `connect` | `NEMOCLAW_DASHBOARD_PORT=<port> nemoclaw <name> connect` |
| Dashboard bind address (loopback compared to all interfaces) | Runtime. Applies on next `connect` | `NEMOCLAW_DASHBOARD_BIND=0.0.0.0 nemoclaw <name> connect` (see #3259) |
| Default OpenClaw workspace template seed (`AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`) | Locked at first sandbox boot. Re-onboard required to change the bake-time choice. | Set `NEMOCLAW_MINIMAL_BOOTSTRAP=1` before `nemoclaw onboard` to skip default template seeding for new/pristine workspaces. **Does not delete files already present.** Partial mitigation for #2598 (cuts ~3k tokens of project-context overhead off OpenClaw's per-turn bootstrap injection). |
| Web search backend (Brave, Tavily, and so on) | Runtime through `web.backend` config flag; rebuild only if `web.fetchEnabled` flips | `nemoclaw <name> config set --key web.backend --value tavily` |
| Filesystem layout (Landlock zones, read-only mounts, container caps) | **Locked at creation**. No runtime change | Re-onboard with `nemoclaw onboard --recreate-sandbox` |
| Sandbox name | **Locked at creation** | Re-onboard with a different `--name` |
| GPU passthrough enable / device selector | **Locked at creation** | Re-onboard with `--gpu` / `--sandbox-gpu-device` |
| Agents allow-list (`agents.list` in `openclaw.json`) | Runtime. OpenClaw hot-reloads on config change | Prefer agent or NemoClaw commands that keep host and sandbox state aligned |
| `openclaw.json` keys (general: model, agents.list, web.backend, channel config, and so on) | Mixed. Individual keys still follow the rebuild rules in the rows above, such as provider switch requiring rebuild even after editing the JSON. | Prefer NemoClaw host commands so the host registry and rebuilt image stay aligned |

If a row above conflicts with what you observe, the runtime source of truth inside the sandbox is `/opt/nemoclaw/openclaw.json`; the host registry caches metadata but the image and OpenClaw read from the in-sandbox file.

</AgentOnly>
<AgentOnly variant="hermes">

| Item | When the change takes effect | How to change it |
|---|---|---|
| Inference provider (cloud, NVIDIA Endpoints, local Ollama / vLLM, compatible-endpoint, …) | Runtime route changes apply immediately; rebuild if you need to rebake model metadata into the image | `nemoclaw inference set` for route changes, or `nemoclaw <name> rebuild` after changing build-time settings |
| Inference model on the current provider | Hot-reloadable through the Hermes config sync path | `nemoclaw inference set` |
| Agent runtime (Hermes compared to OpenClaw) | Re-onboard required (the agent and its state layout are baked at onboard) | `nemoclaw onboard --recreate-sandbox` or `nemoclaw onboard --agent openclaw --recreate-sandbox` |
| Network policy preset (slack, discord, telegram, brave, …) | Runtime. Applies on the next request; rebuild only required if the preset adds bind-mounted secrets | `nemoclaw <name> policy-add <preset>` / `policy-remove <preset>` |
| Network allow-list (custom hosts) | Runtime. Picks up at next request | `openshell policy set` or interactive approval prompt at the gateway |
| Channel tokens (Slack / Discord / Telegram bot credentials) | Rebuild required (tokens are baked into the sandbox image at onboard so they never leave the host clear-text) | `nemoclaw <name> channels add <channel>` then accept the rebuild prompt |
| Channel enable/disable (turn a configured channel off without removing the token) | Rebuild required (`/sandbox/.hermes/.env` and Hermes config are baked at image build time) | `nemoclaw <name> channels stop <channel>` then rebuild |
| API/dashboard forward port | Runtime. Port is re-resolved on next `connect` | `nemoclaw <name> connect` or `openshell forward start` |
| Filesystem layout (Landlock zones, read-only mounts, container caps) | **Locked at creation**. No runtime change | Re-onboard with `nemoclaw onboard --recreate-sandbox` |
| Sandbox name | **Locked at creation** | Re-onboard with a different `--name` |
| GPU passthrough enable / device selector | **Locked at creation** | Re-onboard with `--gpu` / `--sandbox-gpu-device` |
| Hermes `config.yaml` keys | Mixed. Inference keys can be patched by `nemoclaw inference set`; image, policy, and channel changes still require rebuild. | Prefer NemoClaw host commands so the host registry and rebuilt image stay aligned |

If a row above conflicts with what you observe, the runtime source of truth for
Hermes is `/sandbox/.hermes/config.yaml` plus `/sandbox/.hermes/.env`; the host
registry caches metadata but the image and Hermes runtime read from the
in-sandbox files.

</AgentOnly>

## See Also

The mutability table above is a consolidated index of information that lives in more detail on per-topic pages:

<AgentOnly variant="openclaw">

- [Manage Sandbox Lifecycle](../SKILL.md) for the full rebuild, re-onboard, and upgrade workflow.
- Switch Inference Providers (use the `nemoclaw-user-configure-inference` skill) for the rebuild path for provider and model changes.
- Customize Network Policy (use the `nemoclaw-user-manage-policy` skill) and Approve Network Requests (use the `nemoclaw-user-manage-policy` skill) for runtime policy editing and operator approval flow.
- Security Best Practices (use the `nemoclaw-user-configure-security` skill) for the per-attack-surface posture table that this page complements.
- OpenClaw Security Controls (use the `nemoclaw-user-configure-security` skill) for application-layer controls that operate independently of NemoClaw.
- CLI Commands Reference (use the `nemoclaw-user-reference` skill) for the full flag surface for every `nemoclaw` command, including the environment variables that affect runtime behavior.

</AgentOnly>
<AgentOnly variant="hermes">

- [Manage Sandbox Lifecycle](../SKILL.md) for the full rebuild, re-onboard, and upgrade workflow.
- Switch Inference Providers (use the `nemoclaw-user-configure-inference` skill) for the runtime route and rebuild paths for provider and model changes.
- Customize Network Policy (use the `nemoclaw-user-manage-policy` skill) and Approve Network Requests (use the `nemoclaw-user-manage-policy` skill) for runtime policy editing and operator approval flow.
- Security Best Practices (use the `nemoclaw-user-configure-security` skill) for the per-attack-surface posture table that this page complements.
- CLI Commands Reference (use the `nemoclaw-user-reference` skill) for the full flag surface for every `nemoclaw` and `nemoclaw` command, including the environment variables that affect runtime behavior.

</AgentOnly>
