# NemoClaw Quickstart with Hermes

Use NemoHermes when you want NemoClaw to create an OpenShell sandbox that runs Hermes instead of the default OpenClaw agent.
The `nemohermes` command is an alias for `nemoclaw` with the Hermes agent pre-selected.

Review the [Prerequisites](prerequisites.md) before starting.
Install Docker, start it, and verify that the current shell can reach it before Hermes onboarding builds the sandbox image.
On Linux, the installer can install Docker, start the service, and add your user to the `docker` group.
If it changes group membership, run the printed `newgrp docker` recovery command before rerunning the installer.
On macOS, start Docker Desktop or Colima before you run the installer.
The first Hermes build can take several minutes because NemoClaw builds the Hermes sandbox base image if it is not already cached.

## Install and Onboard

Start the installer with `NEMOCLAW_AGENT=hermes` set in your shell.
The installer installs the CLI, selects the `nemohermes` alias, and runs the guided onboarding flow.

```bash
export NEMOCLAW_AGENT=hermes
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

If a headless host needs to expose the Hermes dashboard through a remote URL or tunnel, set `CHAT_UI_URL` before onboarding.
Use the externally reachable origin for the dashboard port `18789`.
NemoClaw derives the forwarded dashboard port from this value, binds the forward for remote access when the origin is non-loopback, and prints the final dashboard URL in the ready summary.
The OpenAI-compatible API remains available separately on port `8642`.

```bash
export NEMOCLAW_AGENT=hermes
export CHAT_UI_URL="https://hermes.example.com:18789"
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

For SSH local port forwarding to `127.0.0.1:18789`, leave `CHAT_UI_URL` unset.
Do not append an OpenClaw `#token=` fragment to the Hermes dashboard URL.
Hermes API clients authenticate with the bearer token from the generated Hermes environment instead of an OpenClaw dashboard URL token.

If NemoClaw is already installed, start Hermes onboarding directly.

```bash
nemohermes onboard
```

## Respond to the Wizard

The onboard wizard asks for an inference provider, model, any required credential, and sandbox name before it prints the review summary.
After you confirm, NemoClaw registers inference, prompts for supported messaging channels, builds and starts the sandbox, sets up Hermes, then applies the selected network policy tier and presets.
At any prompt, press Enter to accept the default shown in `[brackets]`, type `back` to return to the previous prompt, or type `exit` to quit.

The default Hermes sandbox name is `hermes`.
Use a distinct sandbox name, such as `my-hermes`, so you can run Hermes and OpenClaw sandboxes side by side.
NemoClaw prevents same-name reuse when an existing sandbox uses a different agent.

```text
Sandbox name [hermes]: my-hermes
```

Choose the inference provider that matches where you want Hermes model traffic to go.
The provider options and credential environment variables are the same as the standard NemoClaw quickstart.
For provider-specific prompts, refer to the Inference Options (use the `nemoclaw-user-configure-inference` skill) page.
The Hermes wizard does not ask for Brave Web Search because Hermes does not use NemoClaw's OpenClaw web-search configuration.
If you authenticate Hermes through Nous Portal OAuth, the wizard can also prompt for managed Nous tool gateways such as web search, image generation, audio, browser automation, or managed code execution.
Those choices add the matching Hermes policy presets to the sandbox.
API-key mode is inference-only and does not enable managed tool gateways.

After provider and model selection, review the summary and confirm the build.
NemoClaw writes Hermes configuration into `/sandbox/.hermes`, routes model traffic through `inference.local`, and starts the Hermes gateway inside the sandbox.
The Hermes image includes runtime dependencies for the supported NemoClaw messaging integrations, API service, and health endpoint.
The base image does not include unsupported Hermes integrations.

**Note:**

Hermes uses an agent-specific baseline policy that allows the Hermes binary and Python runtime to reach the required Nous Research service endpoints, PyPI, NVIDIA inference endpoints, and selected messaging APIs.

## Use Non-Interactive Setup

For CI or scripted installs, set the required environment variables before running the installer.
The example below uses NVIDIA Endpoints and creates a sandbox named `my-hermes`.

```bash
export NEMOCLAW_AGENT=hermes
export NEMOCLAW_NON_INTERACTIVE=1
export NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1
export NEMOCLAW_SANDBOX_NAME=my-hermes
export NVIDIA_API_KEY=<your-key>
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

Use the provider variables from Inference Options (use the `nemoclaw-user-configure-inference` skill) when you choose a different provider.

## Connect to Hermes

When onboarding completes, NemoClaw prints the sandbox name, model, lifecycle commands, and Hermes dashboard URL.
Hermes exposes its built-in browser dashboard on port `18789`.
NemoClaw also forwards the OpenAI-compatible API on port `8642` for local clients.
NemoClaw builds the Hermes dashboard assets into the sandbox image, so the dashboard starts without running `npm` as the sandbox user under `/opt/hermes`.
Dashboard chat uses the prebuilt `/opt/hermes/ui-tui` bundle.
If you need to recover the Hermes dashboard manually, use `hermes dashboard --tui --skip-build` so recovery does not try to rebuild assets under root-owned install paths.
Set `NEMOCLAW_HERMES_DASHBOARD_TUI=1` before onboarding only if you want Hermes' optional in-browser TUI tab.

```text
──────────────────────────────────────────────────
NemoHermes is ready

Sandbox:  my-hermes
Model:    nvidia/nemotron-3-super-120b-a12b (NVIDIA Endpoints)

Access

  Hermes Agent Dashboard
  Port 18789 must be forwarded before opening this URL.
  http://127.0.0.1:18789/

Terminal:
  nemohermes my-hermes connect

Manage later

  Status:      nemohermes my-hermes status
  Logs:        nemohermes my-hermes logs --follow
  Model:       nemohermes inference set --model <model> --provider <provider> --sandbox my-hermes
  Policies:    nemohermes my-hermes policy-add
  Credentials: nemohermes credentials reset <KEY> && nemohermes onboard
──────────────────────────────────────────────────
```

To chat with the agent from a terminal, follow these steps:

1. Connect to the sandbox and start the Hermes CLI.

   ```bash
   nemohermes my-hermes connect
   ```

2. Inside the sandbox, run the Hermes CLI.

   ```bash
   hermes
   ```

## Open the Dashboard

The onboard flow starts the dashboard port forward automatically.
Open the dashboard from the host:

```console
$ nemohermes my-hermes dashboard-url --quiet
http://127.0.0.1:18789/
```

Hermes handles dashboard sessions itself, so this URL does not include an OpenClaw `#token=` fragment.

## Check the API Endpoint

The onboard flow also starts the API port forward automatically.
Check the health endpoint from the host to confirm that the Hermes API is reachable.

```bash
curl -sf http://127.0.0.1:8642/health
```

If the command cannot connect after a reboot or terminal restart, start the forward again.

```bash
openshell forward start --background 8642 my-hermes
```

Configure an OpenAI-compatible client with the base URL `http://127.0.0.1:8642/v1`.
Hermes uses API header authentication for client requests.
Do not append an OpenClaw `#token=` URL fragment to the Hermes endpoint.

Treat the dashboard as a local management UI.
Avoid exposing it on shared or public networks unless you put it behind your own access controls.

## Manage the Sandbox

Use the same lifecycle commands as a standard NemoClaw sandbox.
The `nemohermes` alias keeps help text and recovery messages aligned with Hermes, while targeting the same registered sandbox.
`nemoclaw list` shows the agent type for each sandbox so you can distinguish Hermes and OpenClaw entries.

```bash
nemohermes my-hermes status
nemohermes my-hermes logs --follow
nemohermes my-hermes snapshot create --name before-change
nemohermes my-hermes rebuild
```

To change the active model or provider without rebuilding the sandbox, use `nemohermes inference set`.
It updates the OpenShell inference route and patches `/sandbox/.hermes/config.yaml` without restarting Hermes.

```bash
nemohermes inference set --model <model> --provider <provider>
```

To remove the sandbox when you are done, destroy it explicitly.

```bash
nemohermes my-hermes destroy
```

## Next Steps

- Inference Options (use the `nemoclaw-user-configure-inference` skill) to choose a provider and model.
- Commands (use the `nemoclaw-user-reference` skill) to see the full `nemohermes` alias behavior.
- Backup and Restore (use the `nemoclaw-user-manage-sandboxes` skill) to preserve sandbox state before destructive operations.
- Monitor Sandbox Activity (use the `nemoclaw-user-monitor-sandbox` skill) to inspect OpenShell events and sandbox logs.
