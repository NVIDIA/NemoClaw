// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PublicCommandDisplayEntry } from "./command-display";
import { getRegisteredOclifCommandMetadata } from "./oclif-metadata";
import { SANDBOX_AGENTS_DISPLAY_LAYOUT } from "./public-display-agents";
import type { PublicDisplayLayout } from "./public-display-layout";
import { SANDBOX_SESSIONS_DISPLAY_LAYOUT } from "./public-display-sessions";
import { globalRouteTokenVariants, sandboxRouteTokens } from "./public-route-metadata";

const PUBLIC_DISPLAY_LAYOUT: Record<string, readonly PublicDisplayLayout[]> = {
  ...SANDBOX_AGENTS_DISPLAY_LAYOUT,
  ...SANDBOX_SESSIONS_DISPLAY_LAYOUT,
  "backup-all": [
    {
      "group": "Backup",
      "order": 40
    }
  ],
  "credentials:list": [
    {
      "group": "Credentials",
      "order": 38,
      "description": "List stored credential keys"
    }
  ],
  "credentials:reset": [
    {
      "group": "Credentials",
      "order": 39,
      "description": "Remove a stored credential so onboard re-prompts",
      "flags": "<PROVIDER> [--yes|-y]"
    }
  ],
  "debug": [
    {
      "group": "Troubleshooting",
      "order": 37,
      "flags": "[--quick] [--output FILE|-o FILE] [--sandbox NAME]"
    }
  ],
  "deploy": [
    {
      "group": "Compatibility Commands",
      "order": 31,
      "deprecated": true
    }
  ],
  "gc": [
    {
      "group": "Cleanup",
      "order": 42,
      "flags": "(--yes|-y|--force, --dry-run)"
    }
  ],
  "inference:get": [
    {
      "group": "Services",
      "order": 36,
      "description": "Show the active inference provider and model",
      "flags": "[--json]"
    }
  ],
  "inference:set": [
    {
      "group": "Services",
      "order": 37,
      "description": "Switch inference and sync the running agent config",
      "flags": "--provider <provider> --model <model> [--sandbox <name>] [--no-verify]"
    }
  ],
  "list": [
    {
      "group": "Sandbox Management",
      "order": 2,
      "flags": "[--json]"
    }
  ],
  "onboard": [
    {
      "group": "Getting Started",
      "order": 0
    },
    {
      "group": "Getting Started",
      "order": 1,
      "usage": "nemoclaw onboard --from",
      "description": "Use a custom Dockerfile for the sandbox image"
    }
  ],
  "root:help": [
    {
      "group": "Getting Started",
      "order": 44,
      "hidden": true
    },
    {
      "group": "Getting Started",
      "order": 45,
      "hidden": true
    },
    {
      "group": "Getting Started",
      "order": 46,
      "hidden": true
    }
  ],
  "resources": [
    {
      "group": "Resources",
      "order": 900,
      "description": "Show hardware inventory (CPU cores, RAM, GPU VRAM)",
      "flags": "[--json]"
    }
  ],
  "root:version": [
    {
      "group": "Getting Started",
      "order": 46,
      "hidden": true
    },
    {
      "group": "Getting Started",
      "order": 47,
      "hidden": true
    },
    {
      "group": "Getting Started",
      "order": 48,
      "hidden": true
    }
  ],
  "sandbox:channels:add": [
    {
      "group": "Messaging Channels",
      "order": 21,
      "usage": "nemoclaw <name> channels add <channel>",
      "description": "Save credentials and rebuild",
      "flags": "[--dry-run]"
    }
  ],
  "sandbox:channels:list": [
    {
      "group": "Messaging Channels",
      "order": 20
    }
  ],
  "sandbox:channels:remove": [
    {
      "group": "Messaging Channels",
      "order": 22,
      "usage": "nemoclaw <name> channels remove <channel>",
      "description": "Remove a configured messaging channel",
      "flags": "[--dry-run]"
    }
  ],
  "sandbox:channels:start": [
    {
      "group": "Messaging Channels",
      "order": 24,
      "usage": "nemoclaw <name> channels start <channel>",
      "description": "Re-enable a previously stopped channel",
      "flags": "[--dry-run]"
    }
  ],
  "sandbox:channels:stop": [
    {
      "group": "Messaging Channels",
      "order": 23,
      "usage": "nemoclaw <name> channels stop <channel>",
      "description": "Disable channel (keeps credentials)",
      "flags": "[--dry-run]"
    }
  ],
  "sandbox:channels:status": [
    {
      "group": "Messaging Channels",
      "order": 25,
      "usage": "nemoclaw <name> channels status",
      "description": "Channel-specific runtime diagnostics",
      "flags": "[--channel <channel>] [--json]"
    }
  ],
  "sandbox:config:get": [
    {
      "group": "Sandbox Management",
      "order": 28,
      "flags": "[--key <dotpath>] [--format json|yaml]",
      "hidden": true
    }
  ],
  "sandbox:config:rotate-token": [
    {
      "group": "Sandbox Management",
      "order": 30,
      "hidden": true
    }
  ],
  "sandbox:config:set": [
    {
      "group": "Sandbox Management",
      "order": 29,
      "description": "Set sandbox configuration with SSRF validation",
      "flags": "--key <dotpath> --value <value> [--restart] [--config-accept-new-path]",
      "hidden": true
    }
  ],
  "sandbox:connect": [
    {
      "group": "Sandbox Management",
      "order": 3,
      "flags": "[--probe-only]"
    }
  ],
  "sandbox:dashboard-url": [
    {
      "group": "Sandbox Management",
      "order": 3.2,
      "flags": "[--quiet|-q]"
    }
  ],
  "sandbox:destroy": [
    {
      "group": "Sandbox Management",
      "order": 15,
      "description": "Stop NIM + delete sandbox",
      "flags": "[--yes|-y|--force] [--cleanup-gateway|--no-cleanup-gateway]"
    }
  ],
  "sandbox:doctor": [
    {
      "group": "Sandbox Management",
      "order": 5,
      "description": "Run host, gateway, sandbox, and inference health checks",
      "flags": "[--json] [--fix]"
    }
  ],
  "sandbox:exec": [
    {
      "group": "Sandbox Management",
      "order": 4.5,
      "flags": "[--workdir <dir>] [--tty|--no-tty] [--timeout <s>] -- <cmd> [args...]"
    }
  ],
  "sandbox:gateway:token": [
    {
      "group": "Sandbox Management",
      "order": 14,
      "flags": "[--quiet|-q]"
    }
  ],
  "sandbox:hosts:add": [
    {
      "group": "Policy Presets",
      "order": 19.1,
      "flags": "<hostname> <ip> [--dry-run]"
    }
  ],
  "sandbox:hosts:list": [
    {
      "group": "Policy Presets",
      "order": 19.2
    }
  ],
  "sandbox:hosts:remove": [
    {
      "group": "Policy Presets",
      "order": 19.3,
      "flags": "(--dry-run)"
    }
  ],
  "sandbox:logs": [
    {
      "group": "Sandbox Management",
      "order": 6,
      "flags": "[--follow] [--tail <lines>|-n <lines>] [--since <duration>]"
    }
  ],
  "sandbox:policy:add": [
    {
      "group": "Policy Presets",
      "order": 17,
      "flags": "(--yes, -y, --dry-run, --from-file <path>, --from-dir <path>)"
    }
  ],
  "sandbox:policy:list": [
    {
      "group": "Policy Presets",
      "order": 19,
      "description": "List presets (● = applied)"
    }
  ],
  "sandbox:policy:remove": [
    {
      "group": "Policy Presets",
      "order": 18,
      "description": "Remove an applied policy preset (built-in or custom)",
      "flags": "(--yes, -y, --dry-run)"
    }
  ],
  "sandbox:rebuild": [
    {
      "group": "Sandbox Management",
      "order": 13,
      "flags": "[--yes|-y|--force] [--verbose|-v]"
    }
  ],
  "sandbox:recover": [
    {
      "group": "Sandbox Management",
      "order": 3.5
    }
  ],
  "sandbox:share:mount": [
    {
      "group": "Sandbox Management",
      "order": 10,
      "description": "Mount sandbox filesystem on the host via SSHFS",
      "flags": "[sandbox-path] [local-mount-point]"
    }
  ],
  "sandbox:share:status": [
    {
      "group": "Sandbox Management",
      "order": 12,
      "description": "Check whether the sandbox filesystem is currently mounted",
      "flags": "[local-mount-point]"
    }
  ],
  "sandbox:share:unmount": [
    {
      "group": "Sandbox Management",
      "order": 11,
      "description": "Unmount a previously mounted sandbox filesystem",
      "flags": "[local-mount-point]"
    }
  ],
  "sandbox:shields:down": [
    {
      "group": "Sandbox Management",
      "order": 25,
      "flags": "[--timeout 5m] [--reason <text>] [--policy permissive]",
      "hidden": true
    }
  ],
  "sandbox:shields:status": [
    {
      "group": "Sandbox Management",
      "order": 27,
      "hidden": true
    }
  ],
  "sandbox:shields:up": [
    {
      "group": "Sandbox Management",
      "order": 26,
      "hidden": true
    }
  ],
  "sandbox:skill:install": [
    {
      "group": "Skills",
      "order": 16,
      "flags": "<path>"
    }
  ],
  "sandbox:skill:remove": [
    {
      "group": "Skills",
      "order": 16.1,
      "flags": "<skill>"
    }
  ],
  "sandbox:snapshot:create": [
    {
      "group": "Sandbox Management",
      "order": 7,
      "flags": "[--name <name>]"
    }
  ],
  "sandbox:snapshot:list": [
    {
      "group": "Sandbox Management",
      "order": 8
    }
  ],
  "sandbox:snapshot:restore": [
    {
      "group": "Sandbox Management",
      "order": 9,
      "flags": "[selector] [--to <dst>] [--force] [--yes|-y]"
    }
  ],
  "sandbox:status": [
    {
      "group": "Sandbox Management",
      "order": 4,
      "description": "Sandbox health + NIM status"
    }
  ],
  "setup": [
    {
      "group": "Compatibility Commands",
      "order": 29,
      "deprecated": true
    }
  ],
  "setup-spark": [
    {
      "group": "Compatibility Commands",
      "order": 30,
      "deprecated": true
    }
  ],
  "start": [
    {
      "group": "Services",
      "order": 34,
      "deprecated": true
    }
  ],
  "status": [
    {
      "group": "Services",
      "order": 36,
      "flags": "[--json]"
    }
  ],
  "stop": [
    {
      "group": "Services",
      "order": 35,
      "deprecated": true
    }
  ],
  "tunnel:start": [
    {
      "group": "Services",
      "order": 32
    }
  ],
  "tunnel:stop": [
    {
      "group": "Services",
      "order": 33
    }
  ],
  "tunnel:status": [
    {
      "group": "Services",
      "order": 33.5,
      "description": "Show cloudflared public-URL tunnel status"
    }
  ],
  "uninstall": [
    {
      "group": "Cleanup",
      "order": 43,
      "description": "Run uninstall.sh (local only; no remote fallback)"
    }
  ],
  "update": [
    {
      "group": "Upgrade",
      "order": 40,
      "flags": "(--check, --yes|-y)"
    }
  ],
  "upgrade-sandboxes": [
    {
      "group": "Upgrade",
      "order": 41,
      "flags": "(--check, --auto, --yes|-y)"
    }
  ]
};

function derivedUsage(commandId: string, index: number): string {
  const sandboxTokens = sandboxRouteTokens(commandId);
  if (sandboxTokens) return `nemoclaw <name> ${sandboxTokens.join(" ")}`.trim();

  const globalVariants = globalRouteTokenVariants(commandId);
  const tokens = globalVariants[index] ?? globalVariants[0];
  if (tokens) return `nemoclaw ${tokens.join(" ")}`;

  return `nemoclaw ${commandId.replace(/:/g, " ")}`;
}

function derivedDescription(commandId: string): string {
  return getRegisteredOclifCommandMetadata(commandId)?.summary ?? commandId;
}

function derivedScope(commandId: string): "global" | "sandbox" {
  return commandId.startsWith("sandbox:") ? "sandbox" : "global";
}

export const PUBLIC_DISPLAY_ENTRIES: Record<string, readonly PublicCommandDisplayEntry[]> = Object.fromEntries(
  Object.entries(PUBLIC_DISPLAY_LAYOUT).map(([commandId, layouts]) => [
    commandId,
    layouts.map((layout, index) => ({
      usage: layout.usage ?? derivedUsage(commandId, index),
      description: layout.description ?? derivedDescription(commandId),
      flags: layout.flags,
      group: layout.group,
      deprecated: layout.deprecated,
      hidden: layout.hidden,
      scope: derivedScope(commandId),
      order: layout.order,
    })),
  ]),
);
