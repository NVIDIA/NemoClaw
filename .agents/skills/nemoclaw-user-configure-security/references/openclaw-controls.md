<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
# OpenClaw Security Controls Beyond NemoClaw's Scope

NemoClaw provides infrastructure-layer security through sandbox isolation, network policy, filesystem restrictions, SSRF validation, and credential handling.
It delegates all application-layer security to OpenClaw.
This page documents areas where NemoClaw adds no independent protection beyond what OpenClaw already provides.

The details below reflect the OpenClaw documentation at the time of writing.
Consult the [OpenClaw Security docs](https://docs.openclaw.ai/gateway/security/index) for the current state.

## Prompt Injection Detection and Prevention

OpenClaw detects and neutralizes prompt injection attempts before they reach the agent.

| Control | Detail |
|---|---|
| Regex detection | Pattern matching detects common injection vectors such as "ignore all previous instructions" and `<system>` tag spoofing |
| Boundary wrapping | Untrusted input is wrapped in randomized XML boundary markers |
| Unicode folding | Homoglyph folding normalizes bracket variants to prevent visual spoofing |
| Invisible character stripping | Zero-width invisible characters are removed from input |
| Boundary sanitization | Fake boundary markers are sanitized to prevent marker injection |
| Auto-wrapping | Web fetch and search results are automatically wrapped as untrusted external content |

## Tool Access Control and Policy Pipeline

OpenClaw enforces a multi-layer tool policy pipeline that gates every tool call.

| Control | Detail |
|---|---|
| Deny list | High-risk tools (`exec`, `spawn`, `shell`, `fs_write`, `fs_delete`, and others) are blocked from Gateway HTTP by default |
| Policy pipeline | Multi-layer pipeline evaluates tool calls through profile, provider, agent, sandbox, and per-provider policies |
| Fail-closed semantics | Tool call hooks block execution on any error |
| Loop detection | Optional guard detects and blocks repeated identical tool call patterns (disabled by default, opt-in via `tools.loopDetection.enabled`) |
| Plugin approval | Approval workflow defaults to deny on timeout |

## Authentication Rate Limiting and Flood Protection

OpenClaw rate-limits authentication attempts and guards against connection floods.

| Control | Detail |
|---|---|
| Auth rate limiter | Sliding-window rate limiter tracks failed authentication attempts per IP and per scope |
| Control plane limiter | Per-device write rate limiting for control plane operations |
| WebSocket flood guard | Closes connections after repeated unauthorized attempts |
| Pre-auth budget | Limits connections before authentication completes |

## Environment Variable Security Policy

OpenClaw blocks environment variables that could enable code injection, privilege escalation, or credential theft.

| Category | Detail |
|---|---|
| Always-blocked keys | Keys such as `NODE_OPTIONS`, `LD_PRELOAD`, shell injection vectors, crypto mining variables, and `GIT_*` hijacking paths |
| Override-blocked keys | Additional keys blocked unless explicitly overridden |
| Blocked prefixes | Prefixes such as `GIT_CONFIG_`, `NPM_CONFIG_`, `CARGO_REGISTRIES_`, `TF_VAR_` |
| Universal blocked prefixes | `DYLD_`, `LD_`, `BASH_FUNC_` |

## Security Audit Framework

OpenClaw runs automated security checks (50+ distinct check types) that cover configuration, credential handling, and sandbox posture.
Run `openclaw security audit` to see all findings for your deployment.

These checks include:

- Synced-folder leak detection.
- Plaintext secrets in configuration files.
- Hooks hardening verification.
- Gateway no-auth detection.
- Sandbox misconfiguration scanning.
- Weak-model susceptibility assessment.
- Multi-user exposure matrix.
- Node command policy validation.
- Dangerous config flag scanning (`allowInsecureAuth`, `dangerouslyDisableDeviceAuth`, and similar flags).

## Skill and Extension Supply Chain Scanning

OpenClaw scans skills and extensions with a built-in static analysis scanner before installation.
Critical findings block installation by default.

The scanner checks for patterns including:

- Direct process execution calls.
- Dynamic code execution (`eval`, `new Function`, and similar constructs).
- Cryptocurrency mining patterns.
- Unexpected network activity.
- Potential data exfiltration (file read combined with network calls).
- Obfuscated code.
- Environment variable harvesting combined with network calls.

## DM and Group Messaging Access Policy

OpenClaw controls who can interact with the agent through direct messages and group channels.

| Control | Detail |
|---|---|
| DM policy modes | 4 modes: open, disabled, pairing, allowlist |
| Group policies | Per-group access rules |
| Per-sender authorization | Individual sender gating |
| Command authorization | Command-level access control |
| Multi-user detection | Heuristic that detects multi-user scenarios |

## Context Visibility and Output Controls

OpenClaw restricts what supplemental context the agent can see and how it can modify outputs.

| Control | Detail |
|---|---|
| Mode-based restrictions | Limits visibility of history, threads, quotes, and forwarded messages based on the active mode |
| Sender-based restrictions | Limits visibility based on who sent the message |
| Plugin output hooks | Plugin hooks intercept and modify tool results before they reach the user |

## Safe Regex (ReDoS Prevention)

OpenClaw includes safe regex compilation to prevent Regular Expression Denial of Service (ReDoS) attacks.
The implementation detects unsafe nested quantifiers, bounds input length, and caches results.

## Next Steps

- Security Best Practices (see the `nemoclaw-user-configure-security` skill) for NemoClaw's own security controls and risk framework.
- Credential Storage (see the `nemoclaw-user-configure-security` skill) for how NemoClaw stores and protects provider credentials.
