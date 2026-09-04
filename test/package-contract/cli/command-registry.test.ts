// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  COMMANDS,
  canonicalUsageList,
  commandsByGroup,
  GROUP_ORDER,
  globalCommands,
  globalCommandTokens,
  sandboxActionTokens,
  sandboxCommands,
  visibleCommands,
} from "../../../dist/lib/cli/command-registry";
import { getRegisteredOclifCommandsMetadata } from "../../../dist/lib/cli/oclif-metadata";

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

    it.each(COMMANDS)("$usage has the required command metadata", (cmd) => {
      expect(cmd.usage).toBeTruthy();
      expect(cmd.description).toBeTruthy();
      expect(cmd.group).toBeTruthy();
      expect(["global", "sandbox"]).toContain(cmd.scope);
    });
  });

  describe("globalCommands()", () => {
    it("includes public global service commands", () => {
      const usages = globalCommands().map((cmd) => cmd.usage);
      expect(usages).toContain("nemoclaw agents list");
      expect(usages).toContain("nemoclaw tunnel start");
      expect(usages).toContain("nemoclaw tunnel stop");
      expect(usages).toContain("nemoclaw tunnel status");
      expect(usages).toContain("nemoclaw status");
      expect(usages).toContain("nemoclaw doctor");
    });

    it.each(globalCommands())("$usage has global scope", (cmd) => {
      expect(cmd.scope).toBe("global");
    });
  });

  describe("sandboxCommands()", () => {
    it("returns exactly 59 entries", () => {
      // 54 visible + 5 hidden (config get/set/rotate-token + inference get/set).
      // 54 visible includes the sessions group (root + list + reset + delete +
      // export), the agents quartet (add + apply + delete + list), the
      // singular `agent` passthrough that forwards to `openclaw agent`, the
      // download + upload host-side openshell wrappers, the stop + start
      // container lifecycle pair (#6026), the policy baseline exclude + restore
      // pair, plus five MCP bridge display entries under the `mcp` parent and
      // the gateway restart command under the `gateway` parent.
      expect(sandboxCommands()).toHaveLength(59);
    });

    it.each(sandboxCommands())("$usage has sandbox scope", (cmd) => {
      expect(cmd.scope).toBe("sandbox");
    });
  });

  describe("visibleCommands()", () => {
    it("returns exactly the non-hidden commands", () => {
      expect(visibleCommands()).toEqual(COMMANDS.filter((cmd) => !cmd.hidden));
    });

    it.each(visibleCommands())("$usage remains visible", (cmd) => {
      expect(cmd.hidden).not.toBe(true);
    });
  });

  describe("hidden commands", () => {
    it("keeps exactly 11 help, version, config, and inference aliases hidden", () => {
      const hidden = COMMANDS.filter((c) => c.hidden);
      expect(hidden).toHaveLength(11);
      const usages = hidden.map((c) => c.usage).sort();
      expect(usages).toEqual([
        "nemoclaw --help",
        "nemoclaw --version",
        "nemoclaw -h",
        "nemoclaw -v",
        "nemoclaw <name> config get",
        "nemoclaw <name> config rotate-token",
        "nemoclaw <name> config set",
        "nemoclaw <name> inference get",
        "nemoclaw <name> inference set",
        "nemoclaw help",
        "nemoclaw version",
      ]);
    });
  });

  describe("oclif discovery coverage", () => {
    const discoveredIds = Object.keys(getRegisteredOclifCommandsMetadata()).sort();
    const publicLeafCommandIds = discoveredIds.filter(
      (commandId) =>
        !commandId.startsWith("internal:") &&
        !discoveredIds.some((id) => id.startsWith(`${commandId}:`)),
    );

    it.each(publicLeafCommandIds)("%s has display metadata", (commandId) => {
      const displayCommandIds = new Set(COMMANDS.map((command) => command.commandId));
      expect(displayCommandIds.has(commandId), commandId).toBe(true);
    });

    it.each(COMMANDS)("$usage remains attached to a discovered oclif command", (command) => {
      const discoveredIds = new Set(Object.keys(getRegisteredOclifCommandsMetadata()));
      expect(discoveredIds.has(command.commandId), command.usage).toBe(true);
    });

    it("does not discover the removed deploy command (#10572)", () => {
      expect(getRegisteredOclifCommandsMetadata()).not.toHaveProperty("deploy");
    });
  });

  describe("deprecated commands", () => {
    it("includes the remaining compatibility commands and excludes deploy (#10572)", () => {
      const deprecated = COMMANDS.filter((c) => c.deprecated);
      const usages = deprecated.map((c) => c.usage).sort();
      expect(usages).toContain("nemoclaw setup");
      expect(usages).toContain("nemoclaw setup-spark");
      expect(usages).toContain("nemoclaw start");
      expect(usages).toContain("nemoclaw stop");
      expect(usages).not.toContain("nemoclaw deploy");
    });
  });

  describe("canonicalUsageList()", () => {
    it("returns sorted usage strings", () => {
      const list = canonicalUsageList();
      const sorted = [...list].sort();
      expect(list).toEqual(sorted);
    });

    it.each(canonicalUsageList())("%s starts with nemoclaw", (entry) => {
      expect(entry).toMatch(/^nemoclaw /);
    });

    it.each(canonicalUsageList())("%s excludes description text", (entry) => {
      expect(entry).not.toMatch(/\s{2,}/);
    });

    it.each(canonicalUsageList())("%s excludes optional flags", (entry) => {
      expect(entry).not.toContain("[");
    });

    it("excludes hidden commands", () => {
      const list = canonicalUsageList();
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
    it("returns the exact set of 30 tokens matching the global dispatch commands", () => {
      const tokens = globalCommandTokens();
      const expected = new Set([
        "agents",
        "completion",
        "config",
        "host",
        "onboard",
        "profiles",
        "update",
        "list",
        "use",
        "launch",
        "setup",
        "setup-spark",
        "start",
        "stop",
        "tunnel",
        "status",
        "doctor",
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
    it("returns exactly 30 unique action tokens including empty string", () => {
      const tokens = sandboxActionTokens();
      expect(tokens).toHaveLength(30);
      // Must contain every first-level sandbox action plus the empty default action.
      const expected = new Set([
        "agent",
        "agents",
        "connect",
        "dashboard-url",
        "download",
        "exec",
        "status",
        "stop",
        "start",
        "doctor",
        "inference",
        "logs",
        "policy",
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
        "config",
        "channels",
        "mcp",
        "gateway",
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
    it.each([...commandsByGroup().keys()])(
      "includes the %s group in the display order",
      (group) => {
        expect(GROUP_ORDER).toContain(group);
      },
    );

    it("groups every visible command", () => {
      const total = [...commandsByGroup().values()].reduce((count, commands) => {
        return count + commands.length;
      }, 0);
      expect(total).toBe(visibleCommands().length);
    });

    it.each([...commandsByGroup().values()].flat())("keeps $usage visible in its group", (cmd) => {
      expect(cmd.hidden).not.toBe(true);
    });

    it("exposes the default-sandbox command in root help", () => {
      expect(canonicalUsageList()).toContain("nemoclaw use <name>");
      expect(commandsByGroup().get("Sandbox Management")).toContainEqual(
        expect.objectContaining({
          commandId: "use",
          flags: "[--json]",
          usage: "nemoclaw use <name>",
        }),
      );
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
        "MCP Servers",
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
