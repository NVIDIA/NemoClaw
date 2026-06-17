// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import {
  COMMANDS,
  globalCommands,
  sandboxCommands,
  visibleCommands,
  commandsByGroup,
  canonicalUsageList,
  globalCommandTokens,
  sandboxActionTokens,
  GROUP_ORDER,
} from "./command-registry";
import { getRegisteredOclifCommandsMetadata } from "./oclif-metadata";

describe("command-registry", () => {
  describe("COMMANDS array", () => {
    it("partitions commands into global and sandbox scopes", () => {
      const partitioned = [...globalCommands(), ...sandboxCommands()];
      expect(partitioned).toHaveLength(COMMANDS.length);
      expect(new Set(partitioned).size).toBe(COMMANDS.length);
    });

    it("should have no duplicate usage strings", () => {
      const usages = COMMANDS.map((c) => c.usage);
      expect(new Set(usages).size).toBe(usages.length);
    });

    it("every command has required fields", () => {
      for (const cmd of COMMANDS) {
        expect(cmd.usage).toBeTruthy();
        expect(cmd.description).toBeTruthy();
        expect(cmd.group).toBeTruthy();
        expect(["global", "sandbox"]).toContain(cmd.scope);
      }
    });
  });

  describe("globalCommands()", () => {
    it("includes public global service commands", () => {
      const usages = globalCommands().map((cmd) => cmd.usage);
      expect(usages).toContain("nemoclaw tunnel start");
      expect(usages).toContain("nemoclaw tunnel stop");
      expect(usages).toContain("nemoclaw tunnel status");
      expect(usages).toContain("nemoclaw status");
    });

    it("every entry has scope global", () => {
      for (const cmd of globalCommands()) {
        expect(cmd.scope).toBe("global");
      }
    });
  });

  describe("sandboxCommands()", () => {
    it("should return exactly 48 entries", () => {
      // 42 visible + 6 hidden (shields×3 + config get/set/rotate-token).
      // 42 visible includes the sessions group (root + list + reset + delete +
      // export), the agents trio (add + delete + list), the singular `agent`
      // passthrough that forwards to `openclaw agent`, and the download +
      // upload host-side openshell wrappers.
      expect(sandboxCommands()).toHaveLength(48);
    });

    it("every entry has scope sandbox", () => {
      for (const cmd of sandboxCommands()) {
        expect(cmd.scope).toBe("sandbox");
      }
    });
  });

  describe("visibleCommands()", () => {
    it("returns exactly the non-hidden commands", () => {
      expect(visibleCommands()).toEqual(COMMANDS.filter((cmd) => !cmd.hidden));
    });

    it("no visible command has hidden=true", () => {
      for (const cmd of visibleCommands()) {
        expect(cmd.hidden).not.toBe(true);
      }
    });
  });

  describe("hidden commands", () => {
    it("exactly 12 hidden commands: help/version aliases + shields + config", () => {
      const hidden = COMMANDS.filter((c) => c.hidden);
      expect(hidden).toHaveLength(12);
      const usages = hidden.map((c) => c.usage).sort();
      expect(usages).toEqual([
        "nemoclaw --help",
        "nemoclaw --version",
        "nemoclaw -h",
        "nemoclaw -v",
        "nemoclaw <name> config get",
        "nemoclaw <name> config rotate-token",
        "nemoclaw <name> config set",
        "nemoclaw <name> shields down",
        "nemoclaw <name> shields status",
        "nemoclaw <name> shields up",
        "nemoclaw help",
        "nemoclaw version",
      ]);
    });
  });

  describe("oclif discovery coverage", () => {
    it("requires public leaf commands to have display metadata", () => {
      const metadataById = getRegisteredOclifCommandsMetadata();
      const discoveredIds = Object.keys(metadataById).sort();
      const displayCommandIds = new Set(COMMANDS.map((command) => command.commandId));

      for (const commandId of discoveredIds) {
        if (commandId.startsWith("internal:")) continue;

        const hasSubcommands = discoveredIds.some((id) => id.startsWith(`${commandId}:`));
        if (hasSubcommands) continue;

        expect(displayCommandIds.has(commandId), commandId).toBe(true);
      }
    });

    it("keeps every public display entry attached to a discovered oclif command", () => {
      const discoveredIds = new Set(Object.keys(getRegisteredOclifCommandsMetadata()));
      for (const command of COMMANDS) {
        expect(discoveredIds.has(command.commandId), command.usage).toBe(true);
      }
    });
  });

  describe("deprecated commands", () => {
    it("should include setup, setup-spark, deploy, start, stop", () => {
      const deprecated = COMMANDS.filter((c) => c.deprecated);
      const usages = deprecated.map((c) => c.usage).sort();
      expect(usages).toContain("nemoclaw setup");
      expect(usages).toContain("nemoclaw setup-spark");
      expect(usages).toContain("nemoclaw deploy");
      expect(usages).toContain("nemoclaw start");
      expect(usages).toContain("nemoclaw stop");
    });
  });

  describe("canonicalUsageList()", () => {
    it("returns sorted usage strings", () => {
      const list = canonicalUsageList();
      const sorted = [...list].sort();
      expect(list).toEqual(sorted);
    });

    it("every entry starts with nemoclaw", () => {
      for (const entry of canonicalUsageList()) {
        expect(entry).toMatch(/^nemoclaw /);
      }
    });

    it("no entry contains description text (double spaces)", () => {
      for (const entry of canonicalUsageList()) {
        expect(entry).not.toMatch(/\s{2,}/);
      }
    });

    it("keeps optional flags out of canonical usage strings", () => {
      for (const entry of canonicalUsageList()) {
        expect(entry).not.toContain("[");
      }
    });

    it("excludes hidden commands", () => {
      const list = canonicalUsageList();
      expect(list).not.toContain("nemoclaw <name> shields down");
      expect(list).not.toContain("nemoclaw <name> config get");
      expect(list).not.toContain("nemoclaw <name> config set");
      expect(list).not.toContain("nemoclaw <name> config rotate-token");
    });

    it("uses distinct placeholders for sandbox and skill names", () => {
      const command = COMMANDS.find((entry) => entry.commandId === "sandbox:skill:remove");
      expect(command?.usage).toBe("nemoclaw <name> skill remove");
      expect(command?.flags).toBe("<skill>");
    });
  });

  describe("globalCommandTokens()", () => {
    it("returns the exact set of 24 tokens matching the global dispatch commands", () => {
      const tokens = globalCommandTokens();
      const expected = new Set([
        "onboard",
        "update",
        "list",
        "deploy",
        "setup",
        "setup-spark",
        "start",
        "stop",
        "tunnel",
        "status",
        "debug",
        "uninstall",
        "credentials",
        "backup-all",
        "upgrade-sandboxes",
        "gc",
        "inference",
        "resources",
        "help",
        "version",
        "--help",
        "-h",
        "--version",
        "-v",
      ]);
      expect(tokens).toEqual(expected);
    });
  });

  describe("sandboxActionTokens()", () => {
    it("returns exactly 29 unique action tokens including empty string", () => {
      const tokens = sandboxActionTokens();
      expect(tokens).toHaveLength(29);
      // Must contain every first-level sandbox action plus the empty default action.
      const expected = new Set([
        "agent",
        "agents",
        "connect",
        "dashboard-url",
        "download",
        "exec",
        "status",
        "doctor",
        "logs",
        "policy-add",
        "policy-explain",
        "policy-remove",
        "policy-list",
        "hosts-add",
        "hosts-list",
        "hosts-remove",
        "destroy",
        "sessions",
        "skill",
        "rebuild",
        "recover",
        "snapshot",
        "share",
        "shields",
        "config",
        "channels",
        "gateway-token",
        "upload",
        "",
      ]);
      expect(new Set(tokens)).toEqual(expected);
    });

    it("has no duplicates", () => {
      const tokens = sandboxActionTokens();
      expect(new Set(tokens).size).toBe(tokens.length);
    });
  });

  describe("commandsByGroup()", () => {
    it("groups visible commands by group name", () => {
      const grouped = commandsByGroup();
      // All group keys should appear in GROUP_ORDER
      for (const key of grouped.keys()) {
        expect(GROUP_ORDER).toContain(key);
      }
      // Total visible commands across all groups
      let total = 0;
      for (const cmds of grouped.values()) {
        total += cmds.length;
      }
      expect(total).toBe(visibleCommands().length);
    });

    it("no hidden commands in any group", () => {
      const grouped = commandsByGroup();
      for (const cmds of grouped.values()) {
        for (const cmd of cmds) {
          expect(cmd.hidden).not.toBe(true);
        }
      }
    });
  });

  describe("GROUP_ORDER", () => {
    it("matches the current UX sequence", () => {
      expect(GROUP_ORDER).toEqual([
        "Getting Started",
        "Sandbox Management",
        "Skills",
        "Policy Presets",
        "Messaging Channels",
        "Compatibility Commands",
        "Services",
        "Troubleshooting",
        "Credentials",
        "Backup",
        "Upgrade",
        "Resources",
        "Cleanup",
      ]);
    });
  });
});
