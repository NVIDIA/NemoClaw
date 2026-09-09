<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native Windows candidate package

This directory owns the WiX-authored ARM64 MSI and Burn setup executable for
the native Windows candidate. WiX Toolset 5.0.2 and its standard bootstrapper
application extension are pinned in the project files.

The package uses only standard Windows Installer and Burn authoring. It has no
custom actions and does not invoke PowerShell, WSL, Bash, Ubuntu, Docker, or a
Linux virtual machine. The package installs the exact assembled ARM64 NemoClaw
runtime payload under `%ProgramFiles%\NVIDIA\NemoClaw`. That payload contains
the NemoClaw CLI, pinned Node.js and OpenClaw runtimes, NVIDIA/OpenShell#2721 CLI
and gateway binaries, and only the pinned Microsoft MXC ProcessContainer
executor and host-preparation utility. WSLC, Windows Sandbox, test-proxy,
diagnostic, and learning-mode sidecars from the upstream SDK archive are not
packaged. Windows Installer registers normal Add/Remove Programs metadata and
adds the installed `bin` directory to the machine PATH.

The workflow first builds and qualifies the unmodified NVIDIA/OpenShell#2721
merge commit, then applies the checked-in Node compatibility patch and rebuilds
the packaged derivative. The patch and its exact hash are installed with the
product. Packaged Node workloads explicitly set `windows_ui=true` so the
contained Node process can initialize. Other sandboxes retain MXC's disabled-UI
default. The derivative also adds per-sandbox `host_loopback`, `host_console`, and
`personal_network` options. Configured sessions use the Personal network profile:
MXC's supported outbound-open policy and local-network access. The ordinary
qualification controls retain their original network policy. Personal does not
grant access to the Windows user-profile filesystem.

Configured terminal sessions give the dedicated gateway a real Windows console.
The gateway verifies all three standard handles before opting into MXC console
sharing; the contained workload inherits input, output, resizing, and console
lifetime. Startup errors appear in that same terminal. Deterministic one-shot
qualification remains a separate regression surface.

The tested ARM64 runner selects MXC's AppContainer fallback. The gateway template
retains `pc_least_privilege=false` and `privateNetworkClientServer`. Personal sessions
also add `internetClient` for public outbound connections; the qualification
default does not add that capability. These are
preview compatibility settings across the agent set; they do not establish LPAC
qualification or governed egress-policy parity. The legacy `allowLocalNetwork`
field has version-dependent ingress semantics. Retiring these exceptions needs
agent, broker, negative filesystem, and network evidence on the selected Windows
and MXC builds. Runtime qualification remains tracked in
[#8178](https://github.com/NVIDIA/NemoClaw/issues/8178).

Each run writes a gateway configuration outside the installed payload. It
preserves the installed template's settings and resolves `wxc_exec_path` from
the actual installation directory, including an overridden `INSTALLFOLDER`.
The qualification turn executes OpenClaw in a worker inside that same contained
Node process, avoiding an unsupported nested-process assumption while retaining
MXC filesystem containment. The package does not bypass OpenShell or call MXC
directly from NemoClaw. The pinned OpenShell CLI watch does not return after the
one-shot MXC workload completes, so the qualification command stops that
client-side watcher after receiving the exact workload result and then deletes
the sandbox through OpenShell.

The Burn setup runs the pinned Microsoft `wxc-host-prep.exe` system-drive and
null-device prerequisites through its per-machine elevated engine before
installing the MSI. These are native executable prerequisites rather than MSI
custom actions. System-drive preparation supplies shallow-root traversal; the
null-device setting is required for AppContainer process initialization and
resets when Windows reboots.

The self-contained ARM64 WPF setup presents one custom-framed window for agent
selection, inference, optional services, installation progress, and completion.
Setup and onboarding do not use HTML, WebView, Edge, or a browser. An explicit
API-key help action can open the service's official page in the user's browser.
Progress names the current phase and refreshes elapsed time regularly; download
and installer percentages come from actual work, while unknown-duration phases
remain indeterminate.

Setup creates current-user desktop shortcuts for NemoClaw Setup and each configured
agent, using their own icons. The setup shortcut uses the registered cached
installer for maintenance. Uninstall appears only for an installed product and
preserves data by default; explicit per-agent removal checks ownership and active
sessions before deleting state, settings, and scoped keys. Web agents use the
Windows default browser and a native session-control window with explicit Stop.
Closing that control waits for sandbox, gateway, broker, and state cleanup.

The selected agent carries through configuration and launch, and the installed
launcher remembers the last configured agent. The same native window edits
settings later. Agent launch is an explicit completion action. Pi and NemoCUA
remain experimental. `agent-support.json` records the authentic packaged
implementations and their preview limitations.

Hermes uses the corrected pywinpty ARM64 wheel, including its matched `conpty.dll`
and `OpenConsole.exe` beside the native Python extension. The Microsoft ConPTY
notice is installed as `hermes/CONPTY-LICENSE.txt`. An early Windows check loads
that exact library and proves input, output, child-observed resize, and cleanup
before the long runtime build; full packaged qualification repeats the check.
This addresses the omitted binaries documented in the
[pywinpty 3.0.5 release](https://github.com/andfoy/pywinpty/releases/tag/v3.0.5).

Provider endpoint, model, Personal profile, and optional-service selections are
nonsecret host configuration under Local App Data. WPF sends key bytes through
stdin to the native launcher, which stores them in Windows Credential Manager.
Inference credentials bind to the agent, provider, and canonical endpoint;
optional service credentials bind separately to the agent and service. Inference
provider keys remain in the host broker. Opted-in search and messaging keys are
delivered once through an authenticated local bootstrap into the selected agent's
process environment, without credential values in configuration JSON or process
arguments. These service integrations do not claim OpenShell-managed credential
injection or governed provider parity.

OpenClaw offers Brave and Tavily search; Hermes offers its native Tavily backend.
Telegram, Discord, and Slack choices are restricted to the two agents whose
packaged runtimes implement them. Messaging requires its selected bot/app keys;
empty sender lists keep pairing behavior, and Personal network access does not
authorize arbitrary senders. Hermes starts its actual messaging gateway with the
interactive session, checks selected-channel connectivity, and uses the upstream
planned-stop mechanism when that session closes.

Configured OpenClaw and console agents keep their data in a stable system-drive-root
directory named `NemoClawState-<Windows account SID>-<agent>`. The native launcher
creates it with a protected current-user and SYSTEM DACL and holds exclusive
per-account, per-agent session ownership through sandbox cleanup. Reopening
retains data and checks the directory's owner, permissions, and ordinary-directory
type. Changed permissions or a reparse point stop the launch without resetting
or deleting state. Host configuration remains private in Local App Data; the
agent receives no access to the user-profile directory. Existing preview state
is not migrated automatically.

Web UI file transport uses a native, bounded file owner. It pins the root and
stream directory handles, performs handle-relative I/O, and refuses reparse
points, hard links, path traversal, and oversized frames. Its guarded root has
an explicit MXC filesystem grant and stays pinned through sandbox teardown.

Package qualification drives the actual WPF controls for all five agents and
rejects browser/WebView descendants during setup. It separately submits three
turns through OpenClaw's Control UI, Hermes, Deep Agents Code, Pi, and NemoCUA's
experimental browser adapter inside native MXC. The installed configured Hermes
acceptance additionally requires its visible interactive prompt, typed input,
a distinct deterministic provider response, a real console resize, exit, and
sandbox cleanup. The Hermes dashboard also requires three typed turns through
its shipped SPA and native ConPTY, then native Stop and complete cleanup.
One-shot results cannot satisfy either acceptance. Tester reset exercises the
actual maintenance data-removal option and a fresh native reinstall. Actual-window
screenshots and recordings accompany the receipts, including failed-run evidence.
The local deterministic provider proves runtime/transport wiring without a PR
credential; it does not qualify a commercial provider or live messaging account.

Native on-device Express is a separate host-owned llama.cpp/CUDA implementation
for detected RTX Spark N1X Windows ARM64 machines. Its fixed Qwen 3.6 35B-A3B GGUF
recipe is shared across agents and checks driver compatibility, available memory
and storage, pinned downloads, full GPU offload, authentication, and an actual
model response before reporting Ready. It does not invoke the existing WSL or
Linux recipes. Model and runtime downloads occur only when selected. Generic
ARM64 package CI does not qualify N1X GPU operation; the physical device check
remains required.

This remains a preview distribution boundary. Exact candidate package evidence,
physical-host/N1X validation, commercial-provider and messaging validation,
production gateway service ownership, and Authenticode signing are separate gates.
