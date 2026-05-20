<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
# Release Notes

NVIDIA NemoClaw is available in early preview starting March 16, 2026. Use this page to track changes.

## v0.0.46

NemoClaw v0.0.46 improves Windows setup, messaging channels, Hermes sandboxes, inference routing, and command compatibility:

- Windows users can start from the bootstrap PowerShell script, and WSL installs can accept express install to use the Windows-host Ollama path automatically.
- Messaging channels add WhatsApp support. `channels add whatsapp` records the channel, rebuilds the sandbox, and then pairs through the agent-specific QR command inside the sandbox.
- `nemoclaw <name> exec` runs non-interactive commands inside a running sandbox through OpenShell and exits with the remote command's status.
- Hermes sandboxes can use the managed tool gateway broker for supported tool routes, and Hermes startup recovers its readiness marker more reliably.
- Compatible Anthropic endpoint setup auto-detects Amazon Bedrock Runtime endpoints and starts the local adapter needed for OpenShell routing.
- Local Ollama setup on WSL native Docker now routes through NemoClaw's authenticated proxy, and subprocesses inherit the proxy bypass settings used by onboarding.
- Model Router setup probes supported host Python interpreters and falls back to the next usable one when virtual environment creation fails.
- The NemoClaw OpenClaw plugin registers the `/nemoclaw` command again after package metadata changes, and sandbox extension backups restore compatibility with current snapshots.
- Sandbox builds patch OpenClaw's tool catalog to reduce startup latency for Nemotron-focused sandboxes.
- `nemoclaw uninstall` docs now show how to pass flags through the hosted install script form.

## v0.0.45

NemoClaw v0.0.45 improves onboarding recovery, local inference behavior, channel cleanup, sandbox sharing diagnostics, and uninstall cleanup:

- `nemoclaw onboard` handles GPU setup failures more directly. It can replace a stale CPU-only gateway when doing so is safe, skips GPU advice when you explicitly pass `--no-gpu`, points working-driver hosts toward NVIDIA Container Toolkit setup, and enforces the 63-character sandbox name limit before names reach OpenShell.
- Preflight checks catch more host setup issues before the sandbox build starts. Container DNS probing uses a fresh `.invalid` lookup so cached DNS answers do not hide blocked resolver egress, and restrictive checkout file modes no longer make model-specific setup manifests unreadable inside the image.
- Local inference setup is more predictable. Managed vLLM accepts `NEMOCLAW_VLLM_MODEL` for supported registry slugs and checks Hugging Face tokens before pulling gated models. Ollama-backed sandboxes now enable streamed usage accounting so OpenClaw token counters update after each turn.
- Messaging channel removal is a clean inverse of channel add. `nemoclaw <name> channels remove <channel>` detaches live bridge providers before deleting them and un-applies the matching built-in network policy preset when it was active.
- `nemoclaw <name> share mount` fails earlier with clearer guidance when the sandbox path cannot be verified or the host mount target is on a read-only filesystem.
- `nemoclaw uninstall` stops host `openshell-gateway` processes, and subprocesses add IPv6 loopback plus wildcard local bind addresses to `NO_PROXY` so local traffic stays off forwarded proxies.
- Diagnostics and internal command output redact more credential-shaped values and use private temporary directories for generated SSH and config files.

## v0.0.44

NemoClaw v0.0.44 improves onboarding reliability, GPU sandbox networking, local inference verification, messaging recovery, and remote dashboard access:

- `nemoclaw onboard` handles DGX Spark and Jetson hosts more conservatively. Unified-memory GPU detection works for Spark, Jetson defaults to CPU-only sandbox passthrough unless you opt in, and local Ollama validation tolerates slow unified-memory model loads that still fit host memory.
- Linux Docker-driver GPU sandboxes preserve `host.openshell.internal` during recreation and inject a reachable DNS resolver when the host uses a systemd-resolved loopback nameserver, which keeps local inference and external DNS working after GPU patching.
- Onboarding and sandbox builds fail less often on first run. Preflight can guide missing NVIDIA Container Toolkit setup, Docker builds force BuildKit for Dockerfile bind mounts, npm installs retry transient registry resets, and compatible-endpoint onboarding runs a final inference smoke check before reporting success.
- `nemoclaw <name> connect` repairs stale `inference.local` routes before opening the shell, reports local Ollama backend and auth-proxy diagnostics when repair fails, and `--probe-only` keeps dashboard and process recovery from failing just because inference repair needs follow-up.
- `nemoclaw <name> channels add <channel>` applies the matching built-in network policy preset before rebuild, and rebuilds preserve paused channel state so stopped messaging channels stay disabled after destroy and recreate.
- Remote hosts can opt into dashboard forwarding on all interfaces with `NEMOCLAW_DASHBOARD_BIND=0.0.0.0`, and gateway drift checks now stop backup, status, rebuild, recover, and upgrade flows before they trust stale OpenShell state.
- Workspace restore uploads backed-up directories file by file, dashboard forwards retry while stopped ports are still releasing, and the in-sandbox OpenClaw gateway respawns after unexpected exits.

## v0.0.43

NemoClaw v0.0.43 improves GPU onboarding and uninstall cleanup on Linux Docker-driver hosts:

- The standard installer can repair missing NVIDIA CDI device specs before onboarding by enabling the NVIDIA CDI refresh service, then falling back to direct `nvidia-ctk` spec generation when needed.
- Linux Docker-driver GPU onboarding handles the Docker flags and sandbox policy needed for NVIDIA GPU proof writes to `/proc/<pid>/task/<tid>/comm`, which fixes DGX Spark installs that previously failed with a permission error during direct GPU proof.
- `nemoclaw uninstall` removes the Linux gateway state directory under `~/.local/state/nemoclaw`, including gateway PID, SQLite, audit log, and VM-driver state left by Docker-driver gateways.

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
- The onboarding provider menu offers an already-running local vLLM server directly when `localhost:8000` responds. Managed vLLM install and start options now appear by default on DGX Spark and DGX Station, while generic Linux NVIDIA GPU hosts remain behind the experimental opt-in.
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
