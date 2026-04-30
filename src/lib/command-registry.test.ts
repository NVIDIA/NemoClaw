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
    it("should contain exactly 48 commands", () => {
      // 25 global (20 visible + 5 hidden help/version aliases)
      // 23 sandbox (19 visible + 4 hidden shields/config)
      expect(COMMANDS).toHaveLength(48);
    });

    it("every entry has scope global", () => {
      for (const cmd of globalCommands()) {
        expect(cmd.scope).toBe("global");
      }
    });
  });

  describe("sandboxCommands()", () => {
    it("should return exactly 23 entries", () => {
      // 19 visible + 4 hidden (shields×3 + config get)
      expect(sandboxCommands()).toHaveLength(23);
    });

    it("every entry has scope sandbox", () => {
      for (const cmd of sandboxCommands()) {
        expect(cmd.scope).toBe("sandbox");
      }
    });
  });

  describe("visibleCommands()", () => {
    it("should exclude 9 hidden commands (39 visible)", () => {
      // 5 hidden global (help, --help, -h, --version, -v) +
      // 4 hidden sandbox (shields×3, config get)
      expect(visibleCommands()).toHaveLength(39);
    });

    it("none of the returned commands are hidden", () => {
      for (const cmd of visibleCommands()) {
        expect(cmd.hidden).toBeFalsy();
      }
    });
  });

  describe("commandsByGroup()", () => {
    it("returns a Map with all groups that have visible commands", () => {
      const grouped = commandsByGroup();
      expect(grouped).toBeInstanceOf(Map);
      expect(grouped.size).toBeGreaterThan(0);

      // Every group in the Map should be in GROUP_ORDER
      for (const group of grouped.keys()) {
        expect(GROUP_ORDER).toContain(group);
      }
    });

    it("only includes visible commands in the groups", () => {
      const grouped = commandsByGroup();
      for (const cmds of grouped.values()) {
        for (const cmd of cmds) {
          expect(cmd.hidden).toBeFalsy();
        }
      }
    });
  });

  describe("canonicalUsageList()", () => {
    it("returns a sorted list of usage strings", () => {
      const list = canonicalUsageList();
      expect(list).toHaveLength(visibleCommands().length);

      const sorted = [...list].sort();
      expect(list).toEqual(sorted);
    });

    it("contains only strings from visible commands", () => {
      const list = canonicalUsageList();
      const visibleUsages = visibleCommands().map(c => c.usage);
      for (const usage of list) {
        expect(visibleUsages).toContain(usage);
      }
    });
  });

  describe("globalCommandTokens()", () => {
    it("extracts unique first tokens of global commands", () => {
      const tokens = globalCommandTokens();
      expect(tokens).toBeInstanceOf(Set);
      expect(tokens.size).toBeGreaterThan(0);

      // "nemoclaw onboard" -> "onboard"
      expect(tokens.has("onboard")).toBe(true);
      // "nemoclaw --help" -> "--help"
      expect(tokens.has("--help")).toBe(true);
    });

    it("handles multi-word commands by taking only the first token after nemoclaw", () => {
      const tokens = globalCommandTokens();
      // "nemoclaw tunnel start" -> "tunnel"
      expect(tokens.has("tunnel")).toBe(true);
      // "create" is a sandbox subcommand, not a global first token
      expect(tokens.has("create")).toBe(false);
    });
  });

  describe("sandboxActionTokens()", () => {
    it("extracts unique action tokens from sandbox commands", () => {
      const tokens = sandboxActionTokens();
      expect(Array.isArray(tokens)).toBe(true);

      // "nemoclaw <name> connect" -> "connect"
      expect(tokens).toContain("connect");
      // "nemoclaw <name> snapshot create" -> "snapshot"
      expect(tokens).toContain("snapshot");
      // Default connect behavior is an empty string
      expect(tokens).toContain("");
    });

    it("does not contain duplicates", () => {
      const tokens = sandboxActionTokens();
      const unique = new Set(tokens);
      expect(tokens.length).toBe(unique.size);
    });
  });
});
