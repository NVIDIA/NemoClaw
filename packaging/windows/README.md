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
product. It sets `ui.disable=false` so the contained Node process can initialize,
and adds an explicit per-sandbox `host_loopback` opt-in. Only the Control UI
and visible NemoCUA workloads use that opt-in. The ARM64 runner selects MXC's
AppContainer fallback, whose schema 0.8 path rejects private-network ingress
with denied egress. The scoped compatibility path therefore uses schema 0.6
`allowLocalNetwork=true` with `defaultPolicy=block` so the host browser can
reach a listener bound only to `127.0.0.1`. Windows' AppContainer
`privateNetworkClientServer` capability is bidirectional on this fallback, so
this preview does not claim governed network-policy parity. Other
NVIDIA/OpenShell#2721 workloads retain the original network posture.
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

The setup uses a self-contained native ARM64 WPF bootstrapper application built
against the pinned WiX 5.0.2 Bootstrapper Application API. It presents agent
status before installation, narrates each MXC and Windows Installer stage with
an elapsed timer and recovery log path, and launches NemoClaw after a successful
interactive install. The MSI remains standard WiX authoring with no custom
actions. Setup installs a native ARM64 `NemoClaw.exe` GUI launcher; launching it
opens the local graphical onboarder without PowerShell or a visible console.
The onboarder stores secret-free provider/model configuration below the
current user's Local AppData and sends API keys over its loopback-only request
to the native launcher, which writes them to Windows Credential Manager. Agent
processes receive an ephemeral authenticated loopback broker instead of the
provider credential.
The onboarder presents real native candidates for OpenClaw, Hermes Agent,
LangChain Deep Agents Code, Pi, and NemoCUA. Pi and NemoCUA are explicitly
experimental. Each enabled choice passes through graphical selection and then
hands off to its agent-specific native adapter; the machine-readable
`agent-support.json` records pinned versions and current limitations. A card
must be disabled, with its exact blocker shown, if its authentic runtime cannot
complete qualification.

Package qualification launches Microsoft Edge through the installed GUI
launcher and separately walks all four graphical onboarding screens for each
enabled agent. It submits three turns through OpenClaw's real Control UI, the
real Hermes, Deep Agents Code, and Pi terminal entrypoints, and NemoCUA's
experimental computer-use adapter. Every agent runtime runs inside native MXC.
A deterministic loopback model endpoint makes transport assertions repeatable
without exposing a PR credential; it is evidence for UI/runtime/model-transport
wiring, not production inference quality. The workflow always attempts to
upload raw actual-window recordings so failed UI runs retain visual diagnostics.

The package is a preview distribution boundary. Host qualification, managed
local-model lifecycle, gateway service registration, messaging and web-search
integration, production activation, and production signing remain separate
gates.
