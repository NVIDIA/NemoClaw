// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import {
  COMMANDS,
  canonicalUsageList,
  commandsByGroup,
  globalCommands,
  globalCommandTokens,
  sandboxActionTokens,
  sandboxCommands,
  visibleCommands,
} from "./command-registry";
import type { CommandDef } from "./command-registry";

describe("command-registry", () => {
  describe("COMMANDS array", () => {
    it("should contain exactly 46 commands", () => {
      // 24 global (19 visible + 5 hidden help/version aliases)
      // 22 sandbox (18 visible + 4 hidden shields/config)
      expect(COMMANDS).toHaveLength(46);
    });

    it("should have unique usage strings", () => {
      const usageStrings = COMMANDS.map((c) => c.usage);
      const unique = new Set(usageStrings);
      expect(unique.size).toBe(COMMANDS.length);
    });

    it("should have a valid group for every command", () => {
      COMMANDS.forEach((c) => {
        expect(c.group).toBeDefined();
      });
    });

    it("should have a valid scope for every command", () => {
      COMMANDS.forEach((c) => {
        expect(["global", "sandbox"]).toContain(c.scope);
      });
    });
  });

  describe("Helper functions", () => {
    it("globalCommands() should only return global scope", () => {
      const global = globalCommands();
      global.forEach((c) => expect(c.scope).toBe("global"));
      expect(global.length).toBeLessThan(COMMANDS.length);
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
    it("should exclude 9 hidden commands (37 visible)", () => {
      // 5 hidden global (help, --help, -h, --version, -v) +
      // 4 hidden sandbox (shields×3, config get)
      expect(visibleCommands()).toHaveLength(37);
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

    it("commandsByGroup() should group visible commands by their group header", () => {
      const grouped = commandsByGroup();
      const visible = visibleCommands();

      let totalInGroups = 0;
      grouped.forEach((cmds) => {
        totalInGroups += cmds.length;
      });

      expect(totalInGroups).toBe(visible.length);
    });

    it("canonicalUsageList() should return sorted visible usage strings", () => {
      const list = canonicalUsageList();
      const visible = visibleCommands();
      expect(list).toHaveLength(visible.length);
      // Check sorting
      const sorted = [...list].sort();
      expect(list).toEqual(sorted);
    });

    it("globalCommandTokens() should return set of first words after nemoclaw", () => {
      const tokens = globalCommandTokens();
      expect(tokens.has("onboard")).toBe(true);
      expect(tokens.has("list")).toBe(true);
      expect(tokens.has("tunnel")).toBe(true);
      expect(tokens.has("connect")).toBe(false); // sandbox command
    });

    it("sandboxActionTokens() should return list of first words after <name>", () => {
      const tokens = sandboxActionTokens();
      expect(tokens).toContain("connect");
      expect(tokens).toContain("status");
      expect(tokens).toContain("snapshot");
      expect(tokens).toContain(""); // default connect
      expect(tokens).not.toContain("onboard"); // global command
    });
  });

  describe("Structural integrity", () => {
    it("every command should follow CommandDef interface (TypeScript check)", () => {
      // This is mostly covered by COMMANDS being typed as CommandDef[],
      // but we can check for required fields.
      COMMANDS.forEach((c: CommandDef) => {
        expect(typeof c.usage).toBe("string");
        expect(typeof c.description).toBe("string");
        expect(typeof c.group).toBe("string");
        expect(typeof c.scope).toBe("string");
      });
    });
  });
});
