<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# NVIDIA NemoClaw: Reference Stack for Sandboxed AI Agents in OpenShell

[![License](https://img.shields.io/badge/License-Apache_2.0-blue)](https://github.com/NVIDIA/NemoClaw/blob/main/LICENSE)
[![Security Policy](https://img.shields.io/badge/Security-Report%20a%20Vulnerability-red)](https://github.com/NVIDIA/NemoClaw/blob/main/SECURITY.md)
[![Discord](https://img.shields.io/badge/Discord-Join-7289da)](https://discord.gg/XFpfPv9Uvx)

NVIDIA NemoClaw is an open source reference stack for running always-on AI agents more safely inside [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) sandboxes.
It provides guided onboarding, a hardened blueprint, routed inference, network policy, and lifecycle management through a single CLI.

**Supported agents:**

- [OpenClaw](https://openclaw.ai) (default)
- [Hermes](https://get-hermes.ai/)

For capabilities, architecture, security controls, and the full feature list, see the [NemoClaw documentation](https://docs.nvidia.com/nemoclaw/latest/).

## Get Started

Review [Prerequisites](https://docs.nvidia.com/nemoclaw/latest/get-started/prerequisites.html) before installing.
For Hermes, set `NEMOCLAW_AGENT=hermes` before running the installer, or use the `nemohermes` alias after install.

| Agent | Guide |
|-------|-------|
| OpenClaw (default) | [Quickstart with OpenClaw](https://docs.nvidia.com/nemoclaw/latest/get-started/quickstart.html) |
| Hermes | [Quickstart with Hermes](https://docs.nvidia.com/nemoclaw/latest/get-started/quickstart-hermes.html) |

## Documentation

Refer to the following pages on the official documentation website for more information on NemoClaw.

| Page | Description |
|------|-------------|
| [Overview](https://docs.nvidia.com/nemoclaw/latest/about/overview.html) | What NemoClaw does and how it fits together. |
| [Architecture Overview](https://docs.nvidia.com/nemoclaw/latest/about/how-it-works.html) | High-level overview of Plugin, blueprint, sandbox lifecycle, and protection layers. |
| [Ecosystem](https://docs.nvidia.com/nemoclaw/latest/about/ecosystem.html) | How OpenClaw, OpenShell, and NemoClaw form a stack and when to use NemoClaw versus OpenShell alone. |
| [Architecture Details](https://docs.nvidia.com/nemoclaw/latest/reference/architecture.html) | Detailed description of Plugin structure, blueprint lifecycle, sandbox environment, and host-side state. |
| [Prerequisites](https://docs.nvidia.com/nemoclaw/latest/get-started/prerequisites.html) | Hardware, software, and supported platforms, with any platform-specific pre-setup. |
| [Inference Options](https://docs.nvidia.com/nemoclaw/latest/inference/inference-options.html) | Supported providers, validation, and routed inference configuration. |
| [Network Policies](https://docs.nvidia.com/nemoclaw/latest/reference/network-policies.html) | Baseline rules, operator approval flow, and egress control. |
| [Customize Network Policy](https://docs.nvidia.com/nemoclaw/latest/network-policy/customize-network-policy.html) | Static and dynamic policy changes, presets. |
| [Security Best Practices](https://docs.nvidia.com/nemoclaw/latest/security/best-practices.html) | Controls reference, risk framework, and posture profiles for sandbox security. |
| [Sandbox Hardening](https://docs.nvidia.com/nemoclaw/latest/manage-sandboxes/sandbox-hardening.html) | Container security measures, capability drops, process limits. |
| [CLI Commands](https://docs.nvidia.com/nemoclaw/latest/reference/commands.html) | Full NemoClaw CLI command reference. |
| [Troubleshooting](https://docs.nvidia.com/nemoclaw/latest/reference/troubleshooting.html) | Common issues and resolution steps. |

## Community

Join the NemoClaw community to ask questions, share feedback, and report issues.
NemoClaw is an alpha project, so maintainers review issues, discussions, and pull requests on a best effort basis without guaranteed response timelines.

| Need | Channel |
|------|---------|
| Setup or usage questions | [GitHub Discussions](https://github.com/NVIDIA/NemoClaw/discussions) or [Discord](https://discord.gg/XFpfPv9Uvx) |
| Reproducible bugs | [GitHub Issues](https://github.com/NVIDIA/NemoClaw/issues) |
| Feature proposals | Start with [GitHub Discussions](https://github.com/NVIDIA/NemoClaw/discussions), then open an issue when the scope is clear |
| Current priorities | [Current Priorities](#current-priorities) |
| Contribution help | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Security vulnerabilities | Use the private channels in [SECURITY.md](SECURITY.md); do not open public issues |

## Contributing

We welcome contributions. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, coding standards, and the PR process.

## Security

NVIDIA takes security seriously.
If you discover a vulnerability in NemoClaw, **DO NOT open a public issue.**
Use one of the private reporting channels described in [SECURITY.md](SECURITY.md):

- Submit a report through the [NVIDIA Vulnerability Disclosure Program](https://www.nvidia.com/en-us/security/report-vulnerability/).
- Send an email to [psirt@nvidia.com](mailto:psirt@nvidia.com) encrypted with the [NVIDIA PGP key](https://www.nvidia.com/en-us/security/pgp-key).
- Use [GitHub's private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configuring-private-vulnerability-reporting-for-a-repository) to submit a report directly on this repository.

For security bulletins and PSIRT policies, visit the [NVIDIA Product Security](https://www.nvidia.com/en-us/security/) portal.

## Current Priorities

NemoClaw's current priorities are maintained here as a public orientation point for contributors and community members.
This list is not a delivery commitment, support promise, or fixed roadmap; priorities can change as maintainers respond to security, quality, platform readiness, and community feedback.

- Improve install and onboarding reliability across tested platforms.
- Strengthen sandbox hardening, credential handling, and network-policy defaults.
- Validate local and routed inference behavior for supported provider paths.
- Keep documentation, troubleshooting guidance, and agent skills aligned with supported workflows.

For specific scoped work, use [GitHub Issues](https://github.com/NVIDIA/NemoClaw/issues) and start broader proposals in [GitHub Discussions](https://github.com/NVIDIA/NemoClaw/discussions).
Security vulnerabilities must use the private reporting channels in [SECURITY.md](SECURITY.md), not public issues.

## Notice and Disclaimer

This software automatically retrieves, accesses or interacts with external materials. Those retrieved materials are not distributed with this software and are governed solely by separate terms, conditions and licenses. You are solely responsible for finding, reviewing and complying with all applicable terms, conditions, and licenses, and for verifying the security, integrity and suitability of any retrieved materials for your specific use case. This software is provided "AS IS", without warranty of any kind. The author makes no representations or warranties regarding any retrieved materials, and assumes no liability for any losses, damages, liabilities or legal consequences from your use or inability to use this software or any retrieved materials. Use this software and the retrieved materials at your own risk.

## License

Apache 2.0. See [LICENSE](LICENSE).
