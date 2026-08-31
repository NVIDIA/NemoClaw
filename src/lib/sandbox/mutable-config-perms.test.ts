// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { AgentConfigTarget } from "./agent-config";
import {
  dirSatisfiesMutableContract,
  fileSatisfiesMutableContract,
  inspectMutableConfigPermsForTarget,
  parseStatModeOwner,
  repairMutableConfigPermsForTarget,
} from "./mutable-config-perms";

const target: AgentConfigTarget = {
  agentName: "openclaw",
  configDir: "/sandbox/.openclaw",
  configFile: "openclaw.json",
  configPath: "/sandbox/.openclaw/openclaw.json",
  format: "json",
  sensitiveFiles: ["/sandbox/.openclaw/.config-hash"],
};

describe("mutable OpenClaw config permissions", () => {
  it("accepts only the exact directory and file modes", () => {
    expect(dirSatisfiesMutableContract("2770")).toBe(true);
    expect(dirSatisfiesMutableContract("770")).toBe(false);
    expect(dirSatisfiesMutableContract("2777")).toBe(false);
    expect(fileSatisfiesMutableContract("660")).toBe(true);
    expect(fileSatisfiesMutableContract("600")).toBe(false);
    expect(fileSatisfiesMutableContract("666")).toBe(false);
  });

  it("parses stat mode and owner with extra whitespace", () => {
    expect(parseStatModeOwner("  2770   sandbox:sandbox\n")).toEqual({
      mode: "2770",
      owner: "sandbox:sandbox",
    });
  });

  it("reports an intact mutable config tree", () => {
    const stat = vi.fn((configPath: string) =>
      configPath === target.configDir ? "2770 sandbox:sandbox" : "660 sandbox:sandbox",
    );

    expect(inspectMutableConfigPermsForTarget(target, stat)).toMatchObject({
      applies: true,
      ok: true,
      issues: [],
    });
  });

  it("reports mode, owner, and sensitive-file drift", () => {
    const stat = vi.fn((configPath: string) => {
      switch (configPath) {
        case target.configDir:
          return "700 root:root";
        case target.configPath:
          return "600 sandbox:sandbox";
        default:
          return "640 root:root";
      }
    });

    const inspection = inspectMutableConfigPermsForTarget(target, stat);
    expect(inspection).toMatchObject({ applies: true, ok: false });
    expect(inspection.applies && inspection.issues.join("\n")).toContain("mode 700");
    expect(inspection.applies && inspection.issues.join("\n")).toContain("owner root:root");
    expect(inspection.applies && inspection.issues.join("\n")).toContain(".config-hash mode 640");
  });

  it("does not apply to another agent", () => {
    const stat = vi.fn();

    expect(inspectMutableConfigPermsForTarget({ ...target, agentName: "hermes" }, stat)).toEqual({
      applies: false,
      skipReason: "agent",
      reason: "agent hermes does not use the mutable OpenClaw config contract",
    });
    expect(stat).not.toHaveBeenCalled();
  });

  it("reports an unavailable config tree without weakening the result", () => {
    const inspection = inspectMutableConfigPermsForTarget(target, () => {
      throw new Error("container stopped");
    });

    expect(inspection).toEqual({
      applies: false,
      skipReason: "unavailable",
      reason: "could not stat config (container stopped)",
    });
  });

  it("tolerates an absent sensitive file after the main contract is verified", () => {
    const stat = vi.fn((configPath: string) => {
      switch (configPath) {
        case target.configDir:
          return "2770 sandbox:sandbox";
        case target.configPath:
          return "660 sandbox:sandbox";
        default:
          throw new Error("missing");
      }
    });

    expect(inspectMutableConfigPermsForTarget(target, stat)).toMatchObject({
      applies: true,
      ok: true,
    });
  });

  it("applies the mutable contract and reports a normalizer failure", () => {
    const apply = vi.fn();
    expect(repairMutableConfigPermsForTarget(target, apply)).toEqual({
      applied: true,
      verified: true,
      errors: [],
    });

    const failed = repairMutableConfigPermsForTarget(target, () => {
      throw new Error("chmod failed");
    });
    expect(failed).toEqual({ applied: true, verified: false, errors: ["chmod failed"] });
  });

  it("does not normalize another agent's config", () => {
    const apply = vi.fn();

    expect(repairMutableConfigPermsForTarget({ ...target, agentName: "hermes" }, apply)).toEqual({
      applied: false,
      skipReason: "agent",
      reason: "agent hermes does not use the mutable OpenClaw config contract",
    });
    expect(apply).not.toHaveBeenCalled();
  });
});
