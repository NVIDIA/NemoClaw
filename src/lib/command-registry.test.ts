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
import type { CommandDef } from "./command-registry";

describe("command-registry", () => {
  describe("COMMANDS array", () => {
    it("should contain exactly 45 commands", () => {
      // 23 global (18 visible + 5 hidden help/version aliases)
      // 22 sandbox (18 visible + 4 hidden shields/config)
      expect(COMMANDS).toHaveLength(45);
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
    it("should return exactly 23 entries", () => {
      // 18 visible + 5 hidden (help, --help, -h, --version, -v)
      expect(globalCommands()).toHaveLength(23);
    });

    it("every entry has scope global", () => {
      for (const cmd of globalCommands()) {
        expect(cmd.scope).toBe("global");
      }
    });
  });

  describe("sandboxCommands()", () => {
    it("should return exactly 22 entries", () => {
      // 18 visible + 4 hidden (shields×3 + config get)
      expect(sandboxCommands()).toHaveLength(22);
    });

    it("every entry has scope sandbox", () => {
      for (const cmd of sandboxCommands()) {
        expect(cmd.scope).toBe("sandbox");
      }
    });
  });

  describe("visibleCommands()", () => {
    it("should exclude 9 hidden commands (36 visible)", () => {
      // 5 hidden global (help, --help, -h, --version, -v) +
      // 4 hidden sandbox (shields×3, config get)
      expect(visibleCommands()).toHaveLength(36);
    });

    it("no visible command has hidden=true", () => {
      for (const cmd of visibleCommands()) {
        expect(cmd.hidden).not.toBe(true);
      }
    });
  });

  describe("hidden commands", () => {
    it("exactly 9 hidden commands: help/version aliases + shields + config", () => {
      const hidden = COMMANDS.filter((c) => c.hidden);
      expect(hidden).toHaveLength(9);
      const usages = hidden.map((c) => c.usage).sort();
      expect(usages).toEqual([
        "nemoclaw --help",
        "nemoclaw --version",
        "nemoclaw -h",
        "nemoclaw -v",
        "nemoclaw <name> config get",
        "nemoclaw <name> shields down",
        "nemoclaw <name> shields status",
        "nemoclaw <name> shields up",
        "nemoclaw help",
      ]);
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

    it("excludes hidden commands", () => {
      const list = canonicalUsageList();
      expect(list).not.toContain("nemoclaw <name> shields down");
      expect(list).not.toContain("nemoclaw <name> config get");
    });
  });

  describe("globalCommandTokens()", () => {
    it("returns the exact set of 20 tokens matching the old GLOBAL_COMMANDS", () => {
      const tokens = globalCommandTokens();
      const expected = new Set([
        "onboard",
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
        "help",
        "--help",
        "-h",
        "--version",
        "-v",
      ]);
      expect(tokens).toEqual(expected);
    });
  });

  describe("sandboxActionTokens()", () => {
    it("returns exactly 15 unique action tokens including empty string", () => {
      const tokens = sandboxActionTokens();
      expect(tokens).toHaveLength(15);
      // Must contain the same set as the old sandboxActions array
      const expected = new Set([
        "connect",
        "status",
        "logs",
        "policy-add",
        "policy-remove",
        "policy-list",
        "destroy",
        "skill",
        "rebuild",
        "snapshot",
        "shields",
        "config",
        "channels",
        "gateway-token",
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
        "Cleanup",
      ]);
    });
  });
});
