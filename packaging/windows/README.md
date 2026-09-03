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
workload uses that opt-in; it selects MXC schema 0.8 directional networking with
deny-default egress and host-loopback ingress so the host browser can reach the
contained local listener. Other NVIDIA/OpenShell#2721 workloads retain the
original network posture.
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
The onboarder presents the
OpenClaw candidate plus Hermes Agent, LangChain Deep Agents Code, Pi, and
NemoCUA with an honest platform status for each. An agent is selectable only
after its real runtime passes native ARM64 qualification. Blocked cards remain
visible but disabled and explain their exact upstream or packaging gap; the
machine-readable `agent-support.json` records the pinned versions and evidence.

Package qualification launches Microsoft Edge through the installed GUI
launcher, walks all four graphical onboarding screens, and submits three turns
through the real OpenClaw Control UI to the MXC-contained OpenClaw gateway. A
deterministic loopback model endpoint makes the transport assertion repeatable
without exposing a PR credential; it is evidence for UI/gateway/runtime wiring,
not production inference quality. The workflow always attempts to upload the
raw actual-window recording so a failed UI run retains visual diagnostics.

The package is a preview distribution boundary. Host qualification,
credential-backed onboarding parity, managed inference, service registration,
production activation, and production signing remain separate gates.
