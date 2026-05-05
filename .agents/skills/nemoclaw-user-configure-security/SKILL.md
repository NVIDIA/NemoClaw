---
name: "nemoclaw-user-configure-security"
description: "Presents a risk framework for every configurable security control in NemoClaw. Use when evaluating security posture, reviewing sandbox security defaults, or assessing control trade-offs. Trigger keywords - nemoclaw security best practices, sandbox security controls risk framework, nemoclaw credential storage, openshell provider, api key security, openclaw security controls, nemoclaw security boundary, prompt injection, tool access control."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Security Best Practices: Controls, Risks, and Posture Profiles

## References

- **Load [references/best-practices.md](references/best-practices.md)** when evaluating security posture, reviewing sandbox security defaults, or assessing control trade-offs. Presents a risk framework for every configurable security control in NemoClaw.
- **Load [references/openclaw-controls.md](references/openclaw-controls.md)** when reviewing the security boundary between NemoClaw and OpenClaw or assessing what NemoClaw does not cover. Lists OpenClaw security controls that operate independently of NemoClaw, including prompt injection detection, tool access control, rate limiting, environment variable policy, audit framework, supply chain scanning, messaging access policy, context visibility, and safe regex.
- **Load [references/credential-storage.md](references/credential-storage.md)** when reviewing how credentials are handled, locating a stored credential, or assessing the storage threat model. Covers where NemoClaw stores provider credentials, why nothing is persisted to host disk, and how the OpenShell gateway acts as the single system of record.
