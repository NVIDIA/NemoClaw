<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
# NemoClaw Quickstart with Hermes

Use NemoHermes when you want NemoClaw to create an OpenShell sandbox that runs Hermes instead of the default OpenClaw agent.
The `nemohermes` command is an alias for `nemoclaw` with the Hermes agent pre-selected.

> **Warning:** The Hermes agent option is experimental.
> Interfaces, defaults, and supported features may change without notice, and it is not recommended for production use.

Review the Prerequisites (use the `nemoclaw-user-get-started` skill) before starting.
The first Hermes build can take several minutes because NemoClaw builds the Hermes sandbox base image if it is not already cached.

## Install and Onboard

Start the installer with `NEMOCLAW_AGENT=hermes` set in your shell.
The installer installs the CLI, selects the `nemohermes` alias, and runs the guided onboarding flow.

```console
$ export NEMOCLAW_AGENT=hermes
$ curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

If NemoClaw is already installed, start Hermes onboarding directly.

```console
$ nemohermes onboard
```

## Respond to the Wizard

The onboard wizard asks for a sandbox name, inference provider, model, credentials, and network policy preset.
At any prompt, press Enter to accept the default shown in `[brackets]`, type `back` to return to the previous prompt, or type `exit` to quit.

Use a distinct sandbox name, such as `my-hermes`, so you can run Hermes and OpenClaw sandboxes side by side.

```text
Sandbox name [my-assistant]: my-hermes
```

Choose the inference provider that matches where you want Hermes model traffic to go.
The provider options and credential environment variables are the same as the standard NemoClaw quickstart.
For provider-specific prompts, refer to the Respond to the Onboard Wizard (use the `nemoclaw-user-get-started` skill) section and the Inference Options (use the `nemoclaw-user-configure-inference` skill) page.

After provider and policy selection, review the summary and confirm the build.
NemoClaw writes Hermes configuration into `/sandbox/.hermes`, routes model traffic through `inference.local`, and starts the Hermes gateway inside the sandbox.

## Use Non-Interactive Setup

For CI or scripted installs, set the required environment variables before running the installer.
The example below uses NVIDIA Endpoints and creates a sandbox named `my-hermes`.

```console
$ export NEMOCLAW_AGENT=hermes
$ export NEMOCLAW_NON_INTERACTIVE=1
$ export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
$ export NEMOCLAW_SANDBOX_NAME=my-hermes
$ export NVIDIA_API_KEY=<your-key>
$ curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

Use the provider variables from Inference Options (use the `nemoclaw-user-configure-inference` skill) when you choose a different provider.

## Connect to Hermes

When onboarding completes, NemoClaw prints the sandbox name, model, lifecycle commands, and Hermes API endpoint.
Hermes exposes an OpenAI-compatible API on port `8642`, not a browser dashboard.

```text
──────────────────────────────────────────────────
Sandbox      my-hermes (Landlock + seccomp + netns)
Model        nvidia/nemotron-3-super-120b-a12b (NVIDIA Endpoints)
──────────────────────────────────────────────────
Run:         nemohermes my-hermes connect
Status:      nemohermes my-hermes status
Logs:        nemohermes my-hermes logs --follow

Hermes Agent OpenAI-compatible API
Port 8642 must be forwarded before connecting.
http://127.0.0.1:8642/v1
──────────────────────────────────────────────────
```

To chat with the agent from a terminal, follow these steps:

1. Connect to the sandbox and start the Hermes CLI.

   ```console
   $ nemohermes my-hermes connect
   ```

2. Inside the sandbox, run the Hermes CLI.

   ```console
   $ hermes
   ```

## Check the API Endpoint

The onboard flow starts the port forward automatically.
Check the health endpoint from the host to confirm that the Hermes API is reachable.

```console
$ curl -sf http://127.0.0.1:8642/health
```

If the command cannot connect after a reboot or terminal restart, start the forward again.

```console
$ openshell forward start --background 8642 my-hermes
```

Configure an OpenAI-compatible client with the base URL `http://127.0.0.1:8642/v1`.
Hermes uses API header authentication for client requests.
Do not append an OpenClaw `#token=` URL fragment to the Hermes endpoint.

## Manage the Sandbox

Use the same lifecycle commands as a standard NemoClaw sandbox.
The `nemohermes` alias keeps help text and recovery messages aligned with Hermes, while targeting the same registered sandbox.

```console
$ nemohermes my-hermes status
$ nemohermes my-hermes logs --follow
$ nemohermes my-hermes snapshot create --name before-change
$ nemohermes my-hermes rebuild
```

To change the active model or provider without rebuilding the sandbox, use the OpenShell inference route.

```console
$ openshell inference set -g nemoclaw --model <model> --provider <provider>
```

To remove the sandbox when you are done, destroy it explicitly.

```console
$ nemohermes my-hermes destroy
```

## Next Steps

- Inference Options (use the `nemoclaw-user-configure-inference` skill) to choose a provider and model.
- Commands (use the `nemoclaw-user-reference` skill) to see the full `nemohermes` alias behavior.
- Backup and Restore (use the `nemoclaw-user-workspace` skill) to preserve sandbox state before destructive operations.
- Monitor Sandbox Activity (use the `nemoclaw-user-monitor-sandbox` skill) to inspect OpenShell events and sandbox logs.
