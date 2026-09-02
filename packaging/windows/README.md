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
and gateway binaries, and pinned Microsoft MXC tools. Windows Installer
registers normal Add/Remove Programs metadata and adds the installed `bin`
directory to the machine PATH.

The workflow first builds and qualifies the unmodified NVIDIA/OpenShell#2721
merge commit, then applies the checked-in Node process-tree compatibility patch
and rebuilds the packaged derivative. The patch and its exact hash are installed
with the product; it opts the one-shot ProcessContainer out of the default MXC
UI/job restrictions that prevent the packaged Node/OpenClaw child processes from
initializing. MXC filesystem containment remains active. The package does not
bypass OpenShell or call MXC directly from NemoClaw.

The Burn setup runs the pinned Microsoft `wxc-host-prep.exe` system-drive and
null-device prerequisites through its per-machine elevated engine before
installing the MSI. These are native executable prerequisites rather than MSI
custom actions. System-drive preparation supplies shallow-root traversal; the
null-device setting is required for AppContainer process initialization and
resets when Windows reboots.

The package is a preview distribution boundary. Host qualification, supported
onboarding, managed inference, service registration, production activation, and
production signing remain separate gates.
