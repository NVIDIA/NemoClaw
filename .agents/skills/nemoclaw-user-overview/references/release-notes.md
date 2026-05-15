<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
# Release Notes

NVIDIA NemoClaw is available in early preview starting March 16, 2026. Use this page to track changes.

## v0.0.42

NemoClaw v0.0.42 improves onboarding, status diagnostics, local inference checks, and messaging setup:

- `nemoclaw onboard` uses the Docker-driver OpenShell gateway path on macOS and no longer requires VM driver helper assets for standard macOS onboarding.
- Dashboard port selection probes occupied ports more thoroughly, including root-owned listeners on macOS, and rolls back a newly-created sandbox if the dashboard forward cannot start after the image build.
- `nemoclaw status` shows `Inference` and `Connected` fields for each listed sandbox, and cloudflared service output now distinguishes stopped, invalid PID file, and stale PID states with a `nemoclaw tunnel start` recovery hint.
- Local Ollama status and doctor checks now probe the authenticated proxy in addition to the backend, so a broken proxy is reported separately from a healthy `127.0.0.1:11434` backend.
- Compatible OpenAI endpoint validation retries reasoning-only smoke responses with a larger output budget before classifying the setup as a model output budget problem instead of a route failure.
- `channels add` and `channels remove` normalize channel names before saving or rebuilding, and `channels add` hints when a matching built-in policy preset exists but is not applied yet.
- GPU recovery and uninstall output now use registry-aware recovery commands and clearer gateway removal wording.
- Onboarding applies selected built-in policy presets in a single policy update when possible, while preserving the final live policy and registry state.
- The installer handles unchanged user-local CLI shims idempotently, avoiding duplicate shim-creation messages during install-plus-verify flows.

## v0.0.41

NemoClaw v0.0.41 improves Docker-driver onboarding and release compatibility:

- `nemoclaw onboard` can pin fresh OpenShell installs to a published release that fits the blueprint's tested version range, while retaining the installer fallback when release metadata is unavailable.
- Docker-driver gateway startup verifies that sandbox containers can reach `host.openshell.internal` before reporting the gateway healthy, and Linux firewall failures include a targeted `ufw` remediation.
- Local Ollama setup probes sandbox-to-proxy reachability before it commits the inference route, so blocked `11435` traffic stops onboarding with a rerun-safe fix instead of leaving a broken route.
- Linux Docker-driver GPU onboarding can recreate the OpenShell-managed sandbox container with NVIDIA GPU access and leaves diagnostics plus cleanup guidance when GPU readiness fails.
- `nemoclaw uninstall` removes all installer-managed OpenShell helper binaries unless you pass `--keep-openshell`.

## v0.0.40

NemoClaw v0.0.40 improves onboarding reliability, local inference setup, and sandbox recovery:

- `nemoclaw onboard` uses the Docker-driver OpenShell gateway path on macOS with OpenShell 0.0.37, repairs incomplete Docker-driver installs before startup, and installs the platform-specific gateway asset it needs.
- The Docker-driver gateway startup check waits for the gateway port to accept TCP connections before it reports the gateway as healthy, and startup failures now include child process exit details.
- Local Ollama setup requires the authenticated reverse proxy token on every native Ollama API route, including `GET /api/tags`.
- The Linux Ollama install path preflights `zstd` before running the official installer and explains why each sudo-backed setup step needs elevated privileges.
- The onboarding provider menu offers an already-running local vLLM server directly when `localhost:8000` responds, while managed vLLM install and start options remain behind the experimental opt-in.
- Policy tier defaults are filtered by active agent support, so presets such as Brave Search are not reapplied to agents that do not support that integration.
- `nemoclaw <name> connect` checks dashboard forward reachability with a TCP probe before it reports a forward as stale.
- Sandbox startup captures a known-good OpenClaw config baseline and restores it on restart if `/sandbox/.openclaw/openclaw.json` becomes empty.
- The NemoClaw OpenClaw plugin package declares compatibility metadata for OpenClaw package tooling.

## v0.0.39

NemoClaw v0.0.39 improves several day-two workflows:

- The installer checks Docker earlier on Linux, can install and start Docker when needed, and stops with `newgrp docker` guidance when the current shell has not picked up the `docker` group yet.
- DGX Spark and DGX Station users can accept an express install prompt that preselects the local inference path and suggested policy defaults.
- NemoClaw now creates GPU-capable OpenShell Docker sandboxes by default when an NVIDIA GPU is available, with explicit `--sandbox-gpu`, `--no-sandbox-gpu`, and `--sandbox-gpu-device` controls.
- `nemohermes` supports Hermes Provider onboarding and runtime model switches through `nemohermes inference set`.
- `nemoclaw <name> hosts-add`, `hosts-list`, and `hosts-remove` manage sandbox host aliases for LAN-only services.
- `nemoclaw update` checks and runs the maintained installer flow, while `nemoclaw upgrade-sandboxes` remains responsible for rebuilding existing sandboxes.
- `nemoclaw <name> destroy` preserves the shared gateway by default unless `--cleanup-gateway` is selected.
- `nemoclaw <name> connect` repairs stale `inference.local` DNS proxy routes before opening the session.
- Windows-host Ollama onboarding relaunches the daemon with the reachable binding after install or restart.
- Local NVIDIA NIM onboarding passes `NGC_API_KEY` or `NVIDIA_API_KEY` into the managed container without putting the secret in process arguments, detects early container exits during health checks, and prints a per-GPU preflight breakdown on mixed-model hosts.
- The sandbox startup path strips additional Linux capabilities before and during privilege step-down.
- OpenClaw workspace template files are seeded when bootstrap is skipped and the workspace is still empty.
- Kimi K2.6 and related NVIDIA-hosted chat-completions paths include model-specific compatibility handling for reasoning output.

## v0.0.38

NemoClaw v0.0.38 improves several day-two workflows:

- `nemoclaw <name> status` shows the gateway's active policy version in the displayed policy YAML when OpenShell reports one.
- `nemoclaw uninstall` stops matching Local Ollama auth proxy processes before it removes `~/.nemoclaw`, which prevents stale listeners from blocking a later reinstall.
- Local Ollama onboarding validates structured chat-completions tool calls and rejects models that leak tool-call payloads as plain text.
- Blueprint policy additions under `components.policy.additions` are validated, merged into the live policy, applied through OpenShell, and recorded in run metadata.
- Rebuild backups tolerate partial archive output when usable data was produced, then report only the manifest-defined paths that could not be archived.
- NemoHermes uninstall output uses NemoHermes-specific help, progress, and completion text.

## v0.0.34

Starting with NemoClaw v0.0.34, the `curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash` installer pipeline no longer auto-accepts the third-party software notice when stdin is piped and `/dev/tty` is unavailable (for example, deeply detached SSH sessions or some container shells).
In environments without a TTY, accept upfront in the pipe:

```console
$ curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 bash
```

Or pass the flag through to the installer:

```console
$ curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash -s -- --yes-i-accept-third-party-software
```

Or re-run from a terminal with a controlling TTY:

```console
$ bash <(curl -fsSL https://www.nvidia.com/nemoclaw.sh)
```

The installer error message in v0.0.35+ surfaces all three invocations directly so users can copy-paste a recovery without leaving the terminal.

## Component Version Policy

NemoClaw pins the OpenClaw version inside the sandbox at build time via `min_openclaw_version` in `nemoclaw-blueprint/blueprint.yaml`; existing sandboxes do not auto-upgrade.
Run `nemoclaw <name> status` to see the OpenClaw version currently running in a sandbox, and `nemoclaw <name> rebuild` to pick up a newer pin from a NemoClaw upgrade.
See Checking the OpenClaw version (use the `nemoclaw-user-reference` skill) for the full policy.
