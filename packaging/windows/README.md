<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native Windows candidate package

This directory owns the WiX-authored ARM64 MSI and Burn setup executable for
the native Windows candidate. WiX Toolset 5.0.2 and its standard bootstrapper
application extension are pinned in the project files.

The package uses only standard Windows Installer and Burn authoring. It has no
custom actions and does not invoke PowerShell, WSL, Bash, Ubuntu, Docker, or a
Linux virtual machine. The package installs the exact ARM64 OpenShell payload
provided at build time under `%ProgramFiles%\NVIDIA\NemoClaw`, registers normal
Add/Remove Programs metadata, and adds the installed `bin` directory to the
machine PATH.

The package is a preview distribution boundary, not a runtime activation
boundary. `wxc-exec.exe`, real MXC execution, service registration, NemoClaw
CLI/onboarding, and production signing are deliberately absent.
