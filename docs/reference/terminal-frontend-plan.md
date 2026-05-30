<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Terminal Frontend Plan

This plan defines a terminal-first frontend for operating NemoClaw sandboxes and services.

## Goals

- Run the full operator workflow from terminal without opening external dashboards.
- Reduce setup friction by surfacing key checks and recovery actions in one place.
- Keep architecture incremental and compatible with existing `nemoclaw` commands.

## Core UX flows

- **Launch flow:** create/select sandbox, start services, attach logs, open chat entrypoint.
- **Status flow:** one screen for sandbox health, provider, model, policy presets, and service status.
- **Credential flow:** integrated key keeper actions for required service authorizations.
- **Recovery flow:** detect gateway/sandbox drift and suggest deterministic repair commands.

## Information architecture

- **Home panel:** default sandbox summary and quick actions.
- **Sandboxes panel:** list, connect, destroy, policy actions.
- **Services panel:** Telegram/tunnel status and start/stop controls.
- **Keys panel:** `nemoclaw keys` wrapper (list/set/remove/path).
- **Logs panel:** streaming logs with filter shortcuts.

## Technical approach

- Keep `bin/nemoclaw.js` as source of truth for actions.
- Add a TUI layer in a separate module (for example `bin/lib/tui.js`) that calls existing command handlers.
- Use a Node.js terminal UI framework that supports keyboard navigation, split panes, and async updates.
- Keep non-interactive behavior intact for automation and CI users.

## Milestones

1. **MVP shell launcher**
   - command: `nemoclaw ui`
   - panels: Home + Status + Logs
2. **Operator actions**
   - add connect/start/stop/policy actions from within UI
3. **Credential integration**
   - embed key keeper workflows and required-key checks
4. **Recovery assistant**
   - render health diagnostics and one-key remediation commands
5. **Polish and docs**
   - keyboard shortcuts, accessibility pass, troubleshooting guide

## Validation checklist

- Works with empty registry and first-run onboarding.
- Works after gateway restart and stale registry recovery paths.
- Supports both local inference and remote provider setups.
- Does not log or display full secret values in UI.
