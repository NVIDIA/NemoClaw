---
name: "nemoclaw-user-reference"
description: "Describes the NemoClaw integration layer and blueprint architecture and how they orchestrate compatible agent sandboxes. Use when looking up architecture, agent integration, plugin structure, or blueprint design. Trigger keywords - nemoclaw architecture, nemoclaw agent architecture, nemoclaw plugin blueprint structure, nemoclaw vs openshell, which cli, nemoclaw cli, openshell cli, sandbox commands, nemoclaw cli commands, nemoclaw command reference, nemoclaw network policy, sandbox egress control operator approval, nemoclaw troubleshooting, nemoclaw debug sandbox issues."
license: "Apache-2.0"
---

# NemoClaw User Reference

## References

- **Load [references/architecture.md](references/architecture.md)** when looking up architecture, agent integration, plugin structure, or blueprint design. Describes the NemoClaw integration layer and blueprint architecture and how they orchestrate compatible agent sandboxes.
- **Load [references/cli-selection-guide.md](references/cli-selection-guide.md)** when user asks to decide whether to use `$$nemoclaw` or `openshell`. Explains when to use `$$nemoclaw` versus `openshell` for NemoClaw-managed sandboxes, including lifecycle, inference, policy, monitoring, file transfer, and gateway operations.
- **Load [references/commands.md](references/commands.md)** when looking up a specific `$$nemoclaw`, `nemohermes`, or `/nemoclaw` subcommand, flag, argument, or exit code. Includes the full CLI reference for standalone NemoClaw commands and agent-specific in-sandbox commands.
- **Load [references/network-policies.md](references/network-policies.md)** when looking up a specific default endpoint, filesystem path, or the runtime approval sequence NemoClaw applies on blocked requests. Covers the baseline network policy, filesystem rules, and operator approval flow.
- **Load [references/troubleshooting.md](references/troubleshooting.md)** when diagnosing a reported NemoClaw error, a failed onboard, or unexpected sandbox behavior. Lists fixes for common installation, onboarding, and runtime issues.
