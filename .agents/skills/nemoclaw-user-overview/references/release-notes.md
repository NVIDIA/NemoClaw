# Release Notes

import { AgentOnly } from "../_components/AgentGuide";

NVIDIA NemoClaw is available in early preview starting March 16, 2026.
Use this page to track the highlights of the latest release.
For more detailed release notes, refer to the [NemoClaw GitHub announcements](https://github.com/NVIDIA/NemoClaw/discussions/categories/announcements?discussions_q=is%3Aopen+category%3AAnnouncements).

## v0.0.63

NemoClaw v0.0.63 improves sandbox recovery, OpenClaw configuration restore safety, local inference onboarding, messaging safeguards, and release validation:

- Sandbox lifecycle commands preserve and recover more state. `rebuild --yes` can recreate a locally registered sandbox that is missing from a healthy gateway, Docker-driver sandboxes can restart from OpenShell container labels after a host reboot, and `upgrade-sandboxes` detects recorded NemoClaw image drift even when the agent version itself matches. For more information, refer to Manage Sandbox Lifecycle (use the `nemoclaw-user-manage-sandboxes` skill).
- Snapshot-backed rebuilds preserve OpenClaw configuration more safely. Rebuilds now carry forward user-owned `openclaw.json` settings, merge restored config with freshly generated runtime state, and fail when restored config cannot be applied safely. For more information, refer to Backup and Restore (use the `nemoclaw-user-manage-sandboxes` skill).
- Onboarding diagnoses host setup and local inference issues earlier. The installer reports unusual Docker daemon access when a Linux user is outside the `docker` group, host DNS blocks are caught before NVIDIA provider validation, Ollama auth-proxy port conflicts recover during startup, and managed vLLM offers an interactive model picker for supported host profiles. For more information, refer to Use a Local Inference Server (use the `nemoclaw-user-configure-inference` skill).
- Messaging and Hermes startup paths enforce clearer runtime boundaries. Slack setup validates Socket Mode credentials and warns or blocks duplicate Slack Socket Mode sandboxes on a shared gateway, while Hermes direct gateway launch keeps environment-secret protections active and handles wrapped gateway arguments. For more information, refer to Messaging Channels (use the `nemoclaw-user-manage-sandboxes` skill).

## v0.0.62

NemoClaw v0.0.62 improves onboarding reliability for GPU sandboxes, local inference, gateway pairing, Hermes configuration, and release validation:

- GPU sandbox creation and local inference checks now match the runtime paths agents use. Docker-driver recreation prefers NVIDIA CDI when the host advertises a CDI spec, Jetson/Tegra sandboxes inherit the device-node group needed for CUDA, and local GPU inference is verified through `inference.local` from inside the sandbox runtime before onboarding reports success. For more information, refer to Use a Local Inference Server (use the `nemoclaw-user-configure-inference` skill).
- Onboarding and recovery fail earlier and stay quieter on common host drift. NemoClaw no longer requires `nc` for port readiness checks, clears pending gateway scope approvals after onboard and recover, preserves install-version fingerprints in package installs without `.git`, and suppresses fresh-sandbox provider cleanup probe noise. For more information, refer to NemoClaw CLI Commands Reference (use the `nemoclaw-user-reference` skill).

<AgentOnly variant="openclaw">

- Sandbox state and OpenClaw operations recover better after direct in-sandbox changes. Startup restores mutable OpenClaw config permissions after a raw in-sandbox `openclaw doctor --fix`, and the host CLI can now run `nemoclaw <name> agents list` alongside the existing agent add and delete passthrough commands. For more information, refer to NemoClaw CLI Commands Reference (use the `nemoclaw-user-reference` skill).
- WhatsApp pairing uses the compact QR renderer used by the real pairing flow. For more information, refer to Messaging Channels (use the `nemoclaw-user-manage-sandboxes` skill).

</AgentOnly>
<AgentOnly variant="hermes">

- Hermes setup exposes clearer operator state. Generated Hermes config records the upstream NemoClaw provider and model while still presenting Hermes as a custom proxy route, the provider menu labels Hermes choices more clearly, and NemoClaw rejects the reserved Hermes API port as a dashboard port before sandbox creation. For more information, refer to Messaging Channels (use the `nemoclaw-user-manage-sandboxes` skill).

</AgentOnly>

## v0.0.61

NemoClaw v0.0.61 improves sandbox network visibility, onboarding recovery, Hermes isolation, local inference restart behavior, and release validation:

- Agents and operators can inspect a redacted policy context that lists active presets, allowed host categories, approval paths, and policy drift states. Strict SSRF fetches now route through the sandbox proxy, stale `sandboxes.json` locks held by recycled PIDs are reclaimed, and dashboard tool-scope approvals can recover through doctor after sandbox startup. For more information, refer to Customize the Network Policy (use the `nemoclaw-user-manage-policy` skill).
- Sandbox hardening now caps open file descriptors at entrypoint, preserves the tunnel service PID directory across restarts, and keeps build-time plugin install state from forcing runtime npm calls offline. NemoClaw also closed coordinated code-scanning findings and consolidated HTTP probe policy handling without changing the operator contract. For more information, refer to Security Best Practices (use the `nemoclaw-user-configure-security` skill).
- Onboarding and rebuild paths recover more reliably across host and provider drift. ARM64 image-tar upload failures receive a clear classification with an image-reference workaround, rebuild detaches sandbox providers before delete, rebuilt resume snapshots keep session state, and messaging selector key sequences work during onboarding. For more information, refer to NemoClaw CLI Commands Reference (use the `nemoclaw-user-reference` skill).
- Local inference and Hermes setup cover more restart and configuration edge cases. Managed inference hostnames bypass host proxies, managed vLLM restarts after host reboot, DGX Station managed vLLM defaults to `Qwen/Qwen3.6-27B-FP8`, Hermes rejects dashboard port collisions during configuration, and Hermes recovery enforces the environment-secret boundary. For more information, refer to Use a Local Inference Server (use the `nemoclaw-user-configure-inference` skill).
- Messaging setup gives clearer feedback and stores more deterministic state. Slack now notifies the sender when a channel `@mention` is denied, operator-supplied placeholder keys can be registered during onboarding, `messagingPlan` persists into resume state, and channel conflict detection now uses the manifest-plan architecture. For more information, refer to Messaging Channels (use the `nemoclaw-user-manage-sandboxes` skill).
- Release validation now runs real shell-boundary assertions through Vitest E2E support, includes an opt-in live scenario project, shards CLI coverage, adds a docs-only PR fast path, and trims slow CLI subprocess coverage.

## v0.0.60

NemoClaw v0.0.60 improves runtime guidance, sandbox lifecycle reliability, local inference setup, messaging enrollment, and maintainer safeguards:

- OpenClaw runtime guidance stays active without appearing in the visible chat transcript, and sandbox network and filesystem context now tells agents to try allowed in-sandbox actions before reporting them unavailable. OpenClaw device-approval policy also uses the same allowlist and scope behavior during startup and connect. For more information, refer to Architecture (use the `nemoclaw-user-reference` skill).
- Onboarding and sandbox lifecycle paths preserve more host state. NemoClaw uses the package-managed OpenShell gateway user service when available, scopes gateway and dashboard cleanup by sandbox instance, detects Docker-driver sandboxes without writing the local gateway marker, rolls back failed Docker GPU patches, honors `.dockerignore` for custom `--from <Dockerfile>` contexts, and can skip default workspace-template seeding with `NEMOCLAW_MINIMAL_BOOTSTRAP=1`. For more information, refer to NemoClaw CLI Commands Reference (use the `nemoclaw-user-reference` skill).
- Local inference setup is more predictable across NVIDIA NIM, Ollama, vLLM, DGX Spark, DGX Station, Anthropic-compatible routes, and Hermes. NemoClaw pulls NIM images by platform digest, uses stable managed-vLLM images and updated DGX model profiles, tightens Ollama fit checks, synchronizes Anthropic route metadata, preserves Hermes proxy API-key placeholders, and serves the prebuilt Hermes dashboard assets from the sandbox image. For more information, refer to NemoClaw Inference Options (use the `nemoclaw-user-configure-inference` skill).
- Messaging and day-two CLI operations share more common plumbing. Messaging enrollment uses manifest hooks across Telegram, Discord, Slack, WeChat, and WhatsApp, `nemoclaw tunnel status` reports Cloudflare tunnel state directly, global `status` and `list` honor sandbox environment overrides consistently, and installed OpenClaw skills are mirrored into the agent home directory for session startup. For more information, refer to Messaging Channels (use the `nemoclaw-user-manage-sandboxes` skill).
- Policy and secret-handling safeguards cover more edge cases. Non-interactive `NEMOCLAW_POLICY_TIER` validation fails before side effects, interactive onboarding ignores invalid environment values and prompts normally, safe common egress presets are available where supported, persistent-memory scanning catches additional OpenAI and Slack token shapes, and Hermes remote secrets stay out of sandbox-visible surfaces. For more information, refer to Security Best Practices (use the `nemoclaw-user-configure-security` skill).

## v0.0.59

NemoClaw v0.0.59 improves OpenClaw runtime compatibility, inference setup, credential reuse, messaging safeguards, and sandbox startup diagnostics:

- OpenClaw sandboxes stay aligned with the live gateway and current runtime layout. Sandbox startup reconciles the agent model from the live gateway, refreshes the OpenClaw plugin registry after gateway startup, pins OpenClaw home, state, and workspace paths inside the sandbox, and handles OpenClaw 2026.5.27 approval compatibility. For more information, refer to NemoClaw CLI Commands Reference (use the `nemoclaw-user-reference` skill).
- Inference setup has newer model choices and longer first-start budgets for local runtimes. NVIDIA Endpoints includes the Nemotron 3 Ultra 550B option, Local Ollama uses `qwen3.5:9b` as the starter fallback, managed vLLM on DGX Spark uses a 128K context window for `nvidia/Qwen3.6-35B-A3B-NVFP4`, and Local NVIDIA NIM waits longer for first container startup while still failing fast when the container exits. For more information, refer to NemoClaw Inference Options (use the `nemoclaw-user-configure-inference` skill).
- Hermes sandboxes can route Anthropic Messages API traffic through managed inference, and runtime model switches keep the Hermes config synchronized with the OpenShell route. For more information, refer to Switch Inference Models at Runtime (use the `nemoclaw-user-configure-inference` skill).
- Credential and messaging boundaries are clearer during day-two operations. Rebuild and remote-provider update paths can reuse credentials already stored in the OpenShell gateway when the host environment is empty, `channels add` warns or aborts before multiple sandboxes compete for the same token-based messaging credential, and `status` reports cross-sandbox channel overlaps. For more information, refer to Messaging Channels (use the `nemoclaw-user-manage-sandboxes` skill).
- Sandbox startup and host preflight failures provide more actionable recovery guidance. NemoClaw heals `~/.nemoclaw` directory and config-file permissions on read paths, detects missing or stale NVIDIA CDI specs before GPU containers fail, probes legacy gateway containers before host-alias operations, and preserves argument validation before runtime probing. For more information, refer to Troubleshooting (use the `nemoclaw-user-reference` skill).

## v0.0.58

NemoClaw v0.0.58 improves GPU proof reporting, local-inference metadata, policy failure handling, Hermes messaging reliability, OpenClaw diagnostics, and release-prep documentation:

- GPU and local-inference setup report more accurate state. WSL Docker Desktop on ARM64 can accept a reported NVIDIA GPU only after a bounded Docker CUDA proof succeeds, `nemoclaw <name> status` shows whether sandbox CUDA usability is verified, unverified, or failed, managed vLLM uses runtime `max_model_len` metadata for the baked context window when available, and DeepSeek managed-vLLM startup receives the runtime keyword arguments it expects. For more information, refer to Use a Local Inference Server (use the `nemoclaw-user-configure-inference` skill).
- Onboarding and installer failures stop earlier with clearer recovery guidance. The installer checks for `strings` from `binutils` before clone, build, or OpenShell download work; Docker-driver gateway startup fails fast when Docker is unreachable; WSL Docker Desktop diagnostics explain unsupported native Docker-in-WSL routes; Windows-host Ollama detection also checks the installed Windows process when the daemon is stopped; and custom proxy host and port settings are forwarded into the runtime container. For more information, refer to Prerequisites (use the `nemoclaw-user-get-started` skill).
- Policy and sandbox hardening paths avoid misleading success. `policy-add` refuses to merge a preset when the live policy read returns unparseable output, custom preset application reports when the gateway accepted a preset but the sandbox registry could not record it, and `NEMOCLAW_REQUIRE_CAP_DROP=1` lets operators make entrypoint capability dropping fail closed. For more information, refer to NemoClaw CLI Commands Reference (use the `nemoclaw-user-reference` skill).
- OpenClaw runtime diagnostics can export conversation traces through the `diagnostics-otel` plugin. Set `NEMOCLAW_OPENCLAW_OTEL=1` before onboarding or rebuilding an OpenClaw sandbox to bake the plugin config and apply the local OTLP policy preset. For more information, refer to NemoClaw CLI Commands Reference (use the `nemoclaw-user-reference` skill).
- Hermes sandboxes are more reliable across messaging, inference, and startup repair paths. Slack channel rebuilds enable the Hermes Slack platform block, `inference.local` routes include the placeholder API key LiteLLM expects, Telegram pseudo-tool text is normalized only for the active chat platform, the messaging response patch preserves Hermes method binding, retry markers are cleared before explicit command dispatch, and Hermes state repair preserves writable history and background dispatcher behavior in locked runtime state. For more information, refer to Messaging Channels (use the `nemoclaw-user-manage-sandboxes` skill).

## v0.0.57

NemoClaw v0.0.57 improves multi-agent command workflows, local inference setup, messaging channel reliability, sandbox diagnostics, policy persistence, and installer pinning:

- OpenClaw sandboxes can manage conversation sessions and secondary agents from the host CLI. Use `nemoclaw <name> sessions` to list sessions, reset a session key through the OpenClaw gateway, or delete a non-main session, and use `nemoclaw <name> agents add` or `nemoclaw <name> agents delete` to invoke the in-sandbox OpenClaw agent commands. Build-time config also accepts `NEMOCLAW_EXTRA_AGENTS_JSON` so operators can bake validated secondary-agent entries into `agents.list` without replacing the primary `main` agent. For more information, refer to NemoClaw CLI Commands Reference (use the `nemoclaw-user-reference` skill).
- Local inference setup is more observable and more resilient. Managed vLLM on DGX Spark defaults to `nvidia/Qwen3.6-35B-A3B-NVFP4`, streams Hugging Face model-download progress, polls `/v1/models` for readiness, and uses a progress-aware Docker pull watchdog. Local Ollama routes request streaming usage metadata so OpenClaw token counters can update, and `connect` warns when the recorded inference route diverges from the live gateway route instead of reverting silently. For more information, refer to Use a Local Inference Server (use the `nemoclaw-user-configure-inference` skill).
- Onboarding and re-onboarding preserve more operator intent. Linux Docker-driver onboarding can auto-apply a narrow UFW rule for the sandbox-to-gateway bridge when `NEMOCLAW_AUTO_FIX_FIREWALL=1`, verifies host-network local-inference reachability before reporting success, reuses healthy containerized gateways, binds gateway state by port, rolls back a freshly-created sandbox when setup is cancelled at the policy preset step, and carries finalized policy preset selections across later re-onboard runs. For more information, refer to NemoClaw CLI Commands Reference (use the `nemoclaw-user-reference` skill).
- Messaging channel setup fails earlier and leaves fewer partial changes. Slack setup validates both Socket Mode tokens before saving credentials, `channels add` checks the matching built-in policy preset before prompting or persisting channel state, failed preset application rolls back staged bridge changes when possible, WhatsApp pairing renders a compact QR code with clearer gateway diagnostics, and Slack runtime placeholders are normalized before OpenClaw starts. For more information, refer to Messaging Channels (use the `nemoclaw-user-manage-sandboxes` skill).
- Sandbox status and repair output are more actionable. `nemoclaw <name> status` reports Docker daemon, stopped-container, dashboard-port-conflict, and paused-container layers without running misleading inference probes, `doctor` skips stale Kubernetes-only gateway container checks on Docker-driver installs, and stale local registry entries are preserved so the suggested `rebuild --yes` recovery path still has the metadata it needs. For more information, refer to NemoClaw CLI Commands Reference (use the `nemoclaw-user-reference` skill).
- Installer and policy guidance tightened. Piped installs show the correct `NEMOCLAW_INSTALL_TAG` placement and fail clearly when a requested ref is unavailable, the `pypi` preset allows the `uv` package manager binary, and Jira validation now uses a body-visible Atlassian API probe so operators can distinguish blocked and approved curl traffic. For more information, refer to Common NemoClaw Integration Policy Examples (use the `nemoclaw-user-manage-policy` skill).

## v0.0.56

NemoClaw v0.0.56 improves install safety, local-inference validation, messaging diagnostics, sandbox lifecycle reporting, and day-two command behavior:

- Public installer and `nemoclaw update` flows now follow the admin-promoted `lkg` release tag by default, so curl-piped installs and update checks target the maintained build while validation catches up to newer semver tags. Non-interactive Linux installs can also reactivate Docker group membership through `sg docker` and continue in the same installer run when that path is available. For more information, refer to Manage Sandbox Lifecycle (use the `nemoclaw-user-manage-sandboxes` skill).
- `nemoclaw <name> status`, `nemoclaw <name> connect`, and `nemoclaw upgrade-sandboxes` now probe the live sandbox agent version before deciding whether a rebuild is needed, instead of trusting stale host metadata. Status output reports when the version cannot be verified and points at rebuild when the running agent may predate the current install. For more information, refer to NemoClaw CLI Commands Reference (use the `nemoclaw-user-reference` skill).
- GPU Docker-driver local-inference onboarding now verifies that host-network sandboxes can reach the selected Ollama or vLLM health endpoint before onboarding reports success. Failures now include the provider endpoint, container network mode, and recovery guidance, which avoids discovering the broken route only after the first agent prompt. For more information, refer to Use a Local Inference Server (use the `nemoclaw-user-configure-inference` skill).
- Messaging setup is more diagnosable. Slack setup validates both required Slack credentials before enabling the channel, WhatsApp pairing renders a compact scan-friendly QR for OpenClaw sandboxes and separates gateway close errors from QR rendering, and Telegram DM allowlist aliases continue to work for existing automation. For more information, refer to Messaging Channels (use the `nemoclaw-user-manage-sandboxes` skill).
- Command ergonomics are clearer for common day-two paths. `nemoclaw inference set` without both `--provider` and `--model` now points users to the underlying `openshell inference set` command, `nemoclaw <name> skill remove <skill>` removes uploaded skills by `SKILL.md` name, `nemoclaw <name> status --json` supports per-sandbox automation, and `nemoclaw debug --sandbox` validates explicit sandbox names before writing diagnostics. For more information, refer to NemoClaw CLI Commands Reference (use the `nemoclaw-user-reference` skill).
- Policy and sandbox base-image compatibility improved. The `pypi` preset allows the `uv` package manager binary, the sandbox base image includes `tmux` for OpenClaw's bundled tmux-session flow, and Jira preset validation docs now use observable status probes. For more information, refer to Common NemoClaw Integration Policy Examples (use the `nemoclaw-user-manage-policy` skill).
- Uninstall, rebuild, and snapshot flows protect user state more consistently. `nemoclaw uninstall` preserves host-side backups and the sandbox registry by default, rebuilds preserve explicit CPU-only sandbox intent, and snapshot restore blocks ambiguous existing-destination rollbacks unless you opt in with `--force`. For more information, refer to Manage Sandbox Lifecycle (use the `nemoclaw-user-manage-sandboxes` skill).

## v0.0.55

NemoClaw v0.0.55 improves local Ollama onboarding reliability, plugin secret-scanner resilience, and messaging-channel prompt clarity:

- Local Ollama validation retries host-side curl process timeouts with a larger timeout before failing, and Docker runtime detection retries `docker info` before choosing the local inference route. For more information, refer to Use a Local Inference Server (use the `nemoclaw-user-configure-inference` skill).
- The NemoClaw OpenClaw plugin keeps the memory secret scanner active when OpenClaw runs in embedded fallback mode without a usable path resolver. The scanner falls back to literal memory and workspace-relative paths instead of crashing before the first write-tool call. For more information, refer to Security Best Practices (use the `nemoclaw-user-configure-security` skill).
- The onboarding messaging-channel picker now states that pressing Enter with no channels selected skips messaging setup. For more information, refer to Messaging Channels (use the `nemoclaw-user-manage-sandboxes` skill).

## v0.0.54

NemoClaw v0.0.54 updates messaging activation, Windows WSL onboarding, NemoHermes dashboard access, and sandbox repair paths:

- Generated OpenClaw config now marks Telegram, Discord, Slack, and WhatsApp as enabled at the channel level. Selected messaging plugins are pinned during the image build, and `channels add` verifies Telegram, Discord, and Slack bridge startup after the rebuild instead of leaving silent channel failures for later debugging. For more information, refer to Messaging Channels (use the `nemoclaw-user-manage-sandboxes` skill).
- The Windows bootstrap flow waits for Ubuntu account creation before touching Docker settings, enables Docker Desktop WSL integration for the target distro, avoids changing the global WSL default distro, and adds WSL-specific Docker reachability hints during onboarding. For more information, refer to Prepare Windows for NemoClaw.
- Windows-host Ollama setup inside WSL now requires the Docker Desktop WSL integration path. NemoClaw still shows Windows-host Ollama options when it detects them, but labels the Docker Desktop requirement and blocks unsupported native Docker-in-WSL selections before it tries to start or install Ollama. For more information, refer to Use a Local Inference Server (use the `nemoclaw-user-configure-inference` skill).
- NemoHermes can expose the optional native Hermes web dashboard separately from the OpenAI-compatible API. Set `NEMOCLAW_HERMES_DASHBOARD=1` before onboarding to start and forward the dashboard on port `9119`, with `NEMOCLAW_HERMES_DASHBOARD_PORT` and `NEMOCLAW_HERMES_DASHBOARD_TUI` available for port and TUI tab control. For more information, refer to NemoClaw Quickstart with Hermes.
- Onboarding diagnostics include more copy-paste-ready recovery hints. Invalid sandbox names now include a `Try: <suggested-slug>` line when NemoClaw can derive a valid name, and non-interactive NVIDIA Endpoints setup prints the exact `export NVIDIA_API_KEY=nvapi-...` shape when the key is missing. For more information, refer to NemoClaw CLI Commands Reference (use the `nemoclaw-user-reference` skill).
- Homebrew stays on the Linuxbrew prefix while exposing installed formula commands in sandbox shell sessions, the `/nemoclaw` slash command activates at OpenClaw startup again, Hermes rebuilds tolerate older release tarballs that lack optional UI package lockfiles, and device scope-upgrade approvals recover without being pinned to the old gateway-scoped request. For more information, refer to Common NemoClaw Integration Policy Examples (use the `nemoclaw-user-manage-policy` skill).
- The host-gateway allowance for OpenClaw `web_fetch` is confined to the trusted proxy path, while strict and direct paths continue to block host-gateway names. Hermes Provider onboarding skips the host-side smoke probe only for OAuth-backed setup and keeps direct validation for Nous API key setup. For more information, refer to NemoClaw Inference Options (use the `nemoclaw-user-configure-inference` skill).

## v0.0.53

NemoClaw v0.0.53 focuses on safer sandbox recreation, stricter onboarding preflight defaults, local inference reliability, policy coverage, and day-two repair workflows:

- `nemoclaw onboard` backs up workspace state before deleting an existing sandbox during recreation, including sandboxes that are registered but not ready. If the backup is partial or fails, onboarding aborts before delete so workspace, skills, extensions, identity, memory, messaging state, and credentials are not silently dropped. Set `NEMOCLAW_RECREATE_WITHOUT_BACKUP=1` only when you intentionally want a fresh workspace.
- Under-provisioned container-runtime warnings now default to abort in interactive onboarding. Pressing Enter at the warning stops the run so you can resize Docker Desktop or Colima before the sandbox build stalls. Non-interactive runs continue with a warning, and `NEMOCLAW_IGNORE_RUNTIME_RESOURCES=1` still suppresses the check when you have already accepted the resource trade-off.
- OpenClaw sandboxes can use the new `openclaw-pricing` policy preset for model-pricing reference fetches from LiteLLM and OpenRouter. NemoClaw suggests this preset during OpenClaw onboarding so session JSONL records can populate `usage.cost` without widening egress beyond the two read-only pricing endpoints.
- Local Ollama onboarding is more accurate. NemoClaw validates the `/api/tags` response body through the authenticated proxy, honors accepted no-tools overrides through validation and proxy setup, and uses Ollama's reported runtime context length for `contextWindow` unless you set `NEMOCLAW_CONTEXT_WINDOW`.
- Onboarding and gateway reuse recover from more host-runtime drift. NemoClaw recovers stopped gateways before preserving PVC-backed state, verifies gateway containers before reusing port-conflict state, defers Docker-driver gateway teardown until step `[2/8]`, records Docker-driver sandboxes on macOS, and uses Docker `--gpus` rather than CDI repair on WSL Docker Desktop.
- The sandbox and integration paths handle more common failures cleanly, including Brave Search credential rewrite through OpenShell providers, Telegram placeholder repair, host-gateway `web_fetch` routing, read-only host targets for `share mount`, live gateway drift in `list`, host-alias Kubernetes invocations, Jetson bridge DNS preflight failures, and non-ready sandboxes during maintenance backups.
- Hermes startup no longer treats a fresh root-entrypoint layout as locked state, which avoids false locked-layout detection during sandbox boot.
- Maintainer tooling can export a signed skills catalog, detect untracked files during skills refresh diffs, and run the stale-issue verification workflow added for maintainers.

## v0.0.52

NemoClaw v0.0.52 upgrades the bundled OpenClaw runtime, repairs Hermes sandbox startup, restores onboarding ready output, and hardens Slack onboarding, Windows bootstrap, and private-network handling:

- Bundles OpenClaw 2026.5.22 as the NemoClaw runtime target through `OPENCLAW_VERSION` in the NemoClaw Dockerfiles. The runtime upgrade addresses Telegram, Discord, and Slack channel registration issues seen on the 2026.5.18 runtime. `nemoclaw-blueprint/blueprint.yaml` keeps `min_openclaw_version` as a compatibility floor for direct blueprint consumers, so the blueprint floor can be lower than the Dockerfile target. Run `nemoclaw <name> rebuild` to pick up the new OpenClaw runtime in existing sandboxes.
- Hermes sandbox startup is more reliable on the v0.14 root entrypoint. NemoClaw precreates `hooks`, `image_cache`, `audio_cache`, and `logs/curator` under `HERMES_HOME`, makes `/sandbox/.hermes` sticky group-writable so the `gateway` user can create runtime state without removing sandbox-owned config files, stops precreating `/sandbox/.hermes/gateway.pid` as a symlink that Hermes v0.14 treats as a PID race, and clears legacy PID and lock state before launch.
- `nemoclaw onboard` ready output points users at `nemoclaw <name> dashboard-url --quiet` again, restoring the dashboard guidance that regressed during an earlier onboarding refactor.
- Slack onboarding validates preconfigured Slack tokens before treating Slack as configured. Invalid `SLACK_BOT_TOKEN` values from the environment or stored credentials no longer cause onboarding to skip the Slack prompt, so the wizard re-prompts for a valid `xoxb-...` token instead of silently advancing with a token Slack cannot use.
- The Windows bootstrap script defers first-run Ubuntu account setup to a separate WSL handoff window again, which keeps PowerShell prompt alignment intact during install. The default distro is `Ubuntu-24.04`, and `bootstrap-windows.ps1 -DistroName Ubuntu` reuses an existing `Ubuntu` distribution.
- The blueprint private-network blocklist reloads when `private-networks.yaml` changes on disk, so long-running NemoClaw processes validate SSRF and private-network rules against the current file instead of stale cached data.

## v0.0.51

NemoClaw v0.0.51 improves messaging controls, local inference setup, sandbox diagnostics, policy validation, and onboarding recovery:

- Slack setup now supports channel allowlisting. During onboarding, `channels add slack`, and non-interactive rebuilds, set `SLACK_ALLOWED_CHANNELS` to restrict channel `@mention` handling to selected Slack channel IDs. Combine it with `SLACK_ALLOWED_USERS` when you want both channel and member checks.
- Local Ollama setup now detects host installations that are below the minimum supported version and offers an explicit upgrade path. On macOS, NemoClaw uses Homebrew. On Linux, NemoClaw uses the system installer for upgrades and refuses non-interactive upgrade paths that would require a hidden sudo prompt.
- Non-interactive Linux Ollama setup can use a sudo-free user-local install path when passwordless sudo is unavailable. The docs now describe `NEMOCLAW_OLLAMA_INSTALL_MODE`, the user-local install trade-offs, and the manual `zstd` requirement.
- Managed Ollama model selection now uses a memory-aware registry for starter models. If a known bootstrap model does not fit currently available GPU memory, NemoClaw warns and falls back to the largest known model that does fit instead of starting a model that is likely to fail.
- `nemoclaw onboard` restores the managed vLLM menu entry for DGX Spark and DGX Station hosts, which had been hidden after a previous onboard refactor dropped the `gpu.platform` value the vLLM menu builder relies on.
- `nemoclaw resources` and `NEMOCLAW_RESOURCE_PROFILE` expose sandbox CPU and memory profiles. Profiles can be selected during onboarding, and `NEMOCLAW_CPU` or `NEMOCLAW_RAM` can override the selected profile for scripted runs.
- Cloudflare named tunnels are supported through `CLOUDFLARE_TUNNEL_TOKEN`. `nemoclaw tunnel start` passes the token through the environment and expects the named tunnel route to already point at the dashboard port.
- Jira policy validation guidance now matches the maintained preset. Use a Node HTTPS status probe for Atlassian API access and an explicit status-only curl probe for `auth.atlassian.com` when validating approved requests manually.
- Sandbox logs merge OpenClaw gateway output and OpenShell audit events into one stream, and `--tail` applies once to the merged result so policy denials appear beside gateway logs.
- Onboarding recovers more cleanly across host and runtime edge cases, including root-owned config sync directories, stale dashboard port allocation, unreachable Docker daemons, stale dashboard forwards, default NVIDIA CDI spec directories, and Linux Docker-driver health checks.

## v0.0.50

NemoClaw v0.0.50 focused on onboarding reliability, local inference hardening, messaging diagnostics, and sandbox lifecycle cleanup:

- `nemoclaw onboard` detects DGX Spark hosts where managed Ollama falls back to CPU execution. Local inference setup fails the Ollama validation step with a tailored diagnostic, adds a Spark `OLLAMA_LLM_LIBRARY=cuda_v13` systemd override when that backend is installed, and enables the managed Linux Ollama service so local inference survives reboot.
- Compatible endpoint setup rejects `host.docker.internal` inference URLs because OpenShell sandboxes do not have a portable host-service route through that name. Use Local Ollama's authenticated proxy path or a policy-managed host service instead.
- Telegram setup now surfaces BotFather group privacy guidance. Disable privacy mode, then remove and re-add the bot to each group before testing group delivery.
- Maintenance commands recover the OpenShell gateway before retrying sandbox-list operations, which makes rebuild, recover, upgrade, and backup flows more resilient after gateway drift.
- NemoClaw no longer writes proxy hooks into sandbox shell startup files. Local proxy configuration stays on supported OpenShell and NemoClaw paths rather than mutating user shell rc files.
- Windows bootstrap installs Ubuntu 24.04 when WSL is present but no Ubuntu distribution is registered.

## v0.0.49

NemoClaw v0.0.49 is a hardening release focused on reliability, clearer diagnostics, OpenClaw compatibility, and stronger validation coverage:

- Gateway failures now fail faster and explain more. `nemoclaw status` classifies gateway probe failures by layer, distinguishing a named gateway port that is not accepting connections, a named gateway that is present but not Connected, the active OpenShell gateway pointing at a different name, and a named gateway that is not configured at all. `nemoclaw <name> connect` exits early with recovery guidance when the OpenShell gateway is down.
- Gateway upgrade and fallback paths are more stable. The release hardens older gateway fallback coverage, OpenShell gateway upgrade checks, crash-loop detection tests, and Brev GPU bridge gateway traffic coverage.
- Status and doctor now report a fresh mutable sandbox as not configured instead of `down`, and `nemoclaw <name> logs --tail <lines>` is locked in as a NemoClaw line count rather than OpenShell's follow-flag pun. `nemoclaw debug --quick` reports restricted kernel-log access as a skipped section instead of surfacing raw `dmesg` permission errors.
- OpenClaw compatibility is more resilient across runtime changes. Kimi mixed tool calls are normalized more consistently, compatible OpenClaw JSON envelope changes are tolerated in tests, and OpenClaw patch drift is easier to classify during image builds.
- Messaging channel removal is now a clean teardown. The sandbox registry and onboard session policy preset state stay in sync so removed presets do not return during later `onboard --resume` or rebuild flows; QR-paired channels also have their durable in-sandbox session directory wiped before the rebuild and removal aborts cleanly when that wipe cannot be confirmed; and `~/.nemoclaw/config.json` is re-synced from the host across every rebuild resume path so the OpenClaw plugin no longer crashes on the Dockerfile placeholder.
- Hermes sandboxes apply only the messaging channel policies the operator selects instead of pre-enabling every Hermes messaging provider, and dynamic preset application resolves Hermes-specific policy content so Discord on Hermes no longer falls back to generic Node allowlists.
- `nemoclaw <name> snapshot restore --to <existing-sandbox>` now refuses to overwrite an existing destination unless you pass `--force`, which makes destructive clone restores an explicit opt-in.
- Source-checkout installs bootstrap OpenShell when needed before running preflight, so `git clone` based installs can reach the same managed OpenShell setup path as packaged installs. The Linux installer, onboard preflight, and prerequisites docs also explain why NemoClaw needs Docker group membership and the privilege impact of granting it.
- NVIDIA NIM preflight rejects WDDM placeholder GPU names on hosts without NVIDIA firmware, and Jetson onboarding refuses sandbox GPU passthrough instead of creating a configuration the sandbox cannot use.
- CLI and E2E coverage cover more real user paths. Missing `channels` arguments now print the correct usage, scenario suites use supported sandbox subcommands, scenario tests build against the full repository CLI, and security-sensitive credential paths have broader coverage.
- Release infrastructure now targets Node 24 in GitHub Actions. The E2E advisor also comments with clearer scenario guidance and waits for required PR checks before deciding.

## v0.0.48

NemoClaw v0.0.48 improves onboarding, sandbox builds, local inference, messaging, and day-two sandbox operations:

- Windows WSL onboarding detects Windows-host Ollama through both the HTTP endpoint and a Windows process probe, so the installer can offer start or restart actions even when the daemon is installed but not yet reachable from WSL.
- Onboarding no longer prints a noisy `No active forward found` warning when it performs best-effort dashboard forward cleanup before rebuilding or recovering a sandbox.
- `nemoclaw <name> share mount` verifies the requested remote path against the target sandbox name, so probes for non-default sandboxes no longer accidentally inspect the default sandbox.
- The OpenClaw plugin tolerates an empty or malformed onboard `config.json` by falling back to default onboard status instead of failing during startup.
- Hermes messaging policies are scoped to Hermes-supported channel behavior, keeping unsupported OpenClaw-specific messaging access out of Hermes sandboxes.
- Onboard session snapshots persist machine-readable state for resume flows, which makes provider and policy decisions more durable across retries.
- DGX Spark GPU sandbox recreation restores the startup path for Hermes by patching Docker GPU state and preserving the marker files the Hermes entrypoint needs.
- Discord messaging routes REST and gateway traffic through the sandbox proxy path, including a loopback proxy for gateway traffic, so Discord channels work through the same policy-controlled egress model as other sandbox traffic.
- Sandbox base images now include Homebrew and a `python` to `python3` compatibility symlink, reducing first-run setup for package and script workflows inside the sandbox.
- The NemoClaw sandbox image includes a Docker health check so container runtimes can report whether the in-sandbox gateway is responding.
- Sandbox startup resolves workspace template files from the installed package when source-relative files are not available, which helps package installs seed a fresh workspace consistently.
- Installer checksum verification prefers `sha256sum` and falls back when needed, improving compatibility on Linux hosts where `shasum` is not installed.
- VM-driver snapshot health checks now use gateway metadata instead of stale local assumptions, so snapshot operations fail less often after gateway state changes.

## v0.0.47

NemoClaw v0.0.47 focused on release hardening and validation coverage:

- The Vitest E2E fixture layer gained baseline onboarding coverage for CLI setup, OpenShell gateway creation, sandbox state, inference routing, and smoke tests.
- Messaging provider scenarios now validate provider attachment, placeholder configuration, secret-leak prevention, bridge reachability, Discord gateway routing, Slack provider state, Telegram injection safety, and token-rotation isolation.
- CLI command registration was refactored so public display defaults stay consistent across sandbox channel, host, log, policy, skill, and snapshot commands.
- PR review advisor automation was added for maintainers, with deterministic GitHub context gathering and structured review comments.
- The release refreshed v0.0.46 documentation, generated user skills, navigation, and version metadata.

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

```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 bash
```

Or pass the flag through to the installer:

```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash -s -- --yes-i-accept-third-party-software
```

Or re-run from a terminal with a controlling TTY:

```bash
bash <(curl -fsSL https://www.nvidia.com/nemoclaw.sh)
```

The installer error message in v0.0.35+ surfaces all three invocations directly so users can copy-paste a recovery without leaving the terminal.

## Component Version Policy

NemoClaw pins the OpenClaw version inside the sandbox at build time via `OPENCLAW_VERSION` in the NemoClaw Dockerfiles.
The `min_openclaw_version` field in `nemoclaw-blueprint/blueprint.yaml` is the compatibility floor for direct blueprint consumers and may be lower than the NemoClaw runtime target.
Existing sandboxes do not auto-upgrade.
Run `nemoclaw <name> status` to see the OpenClaw version currently running in a sandbox, and `nemoclaw <name> rebuild` to pick up a newer pin from a NemoClaw upgrade.
See Checking the OpenClaw version (use the `nemoclaw-user-reference` skill) for the full policy.
