// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  dirSatisfiesMutableContract,
  fileSatisfiesMutableContract,
  inspectMutableConfigPerms,
  type MutableConfigTarget,
  parseStatModeOwner,
  repairMutableConfigPerms,
} from "./mutable-config-perms";

const OPENCLAW_TARGET: MutableConfigTarget = {
  agentName: "openclaw",
  configDir: "/sandbox/.openclaw",
  configPath: "/sandbox/.openclaw/openclaw.json",
  configFile: "openclaw.json",
};

const HERMES_TARGET: MutableConfigTarget = {
  agentName: "hermes",
  configDir: "/sandbox/.hermes",
  configPath: "/sandbox/.hermes/hermes.json",
  configFile: "hermes.json",
};

// Map config paths to their stat "%a %U:%G" output for a given scenario.
function statFromMap(map: Record<string, string>): (p: string) => string {
  return (p: string) => {
    if (p in map) return map[p];
    throw new Error(`no such file: ${p}`);
  };
}

describe("mutable-config-perms — contract predicates (#4538)", () => {
  it("accepts the NemoClaw mutable directory contract (setgid + group rwx)", () => {
    expect(dirSatisfiesMutableContract("2770")).toBe(true);
  });

  it("rejects directories that doctor --fix tightened to 700", () => {
    expect(dirSatisfiesMutableContract("700")).toBe(false);
  });

  it("rejects group-writable directories that lost the setgid bit", () => {
    // 770 is group-writable but new files would not inherit the sandbox group.
    expect(dirSatisfiesMutableContract("770")).toBe(false);
  });

  it("rejects directories missing group write even with setgid", () => {
    expect(dirSatisfiesMutableContract("2750")).toBe(false);
  });

  it("rejects a tightened owner class even when group bits look right", () => {
    // 2670 = owner rw- (no execute/traverse) — gateway-group bits alone would
    // wrongly pass a group-only check.
    expect(dirSatisfiesMutableContract("2670")).toBe(false);
  });

  it("rejects world-writable widening of the config directory", () => {
    expect(dirSatisfiesMutableContract("2777")).toBe(false);
  });

  it("rejects a five-digit (malformed) mode string", () => {
    expect(dirSatisfiesMutableContract("02770")).toBe(false);
  });

  it("rejects unparsable directory modes", () => {
    expect(dirSatisfiesMutableContract("rwx")).toBe(false);
    expect(dirSatisfiesMutableContract("")).toBe(false);
  });

  it("accepts the group-writable file contract", () => {
    expect(fileSatisfiesMutableContract("660")).toBe(true);
    expect(fileSatisfiesMutableContract("0660")).toBe(true);
  });

  it("rejects files that doctor --fix tightened to 600", () => {
    expect(fileSatisfiesMutableContract("600")).toBe(false);
  });

  it("rejects read-only group files", () => {
    expect(fileSatisfiesMutableContract("640")).toBe(false);
  });

  it("rejects world-readable/writable widening of the config file", () => {
    expect(fileSatisfiesMutableContract("666")).toBe(false);
    expect(fileSatisfiesMutableContract("664")).toBe(false);
  });

  it("parses stat mode/owner output, tolerating extra whitespace", () => {
    expect(parseStatModeOwner("2770 sandbox:sandbox")).toEqual({
      mode: "2770",
      owner: "sandbox:sandbox",
    });
    expect(parseStatModeOwner("  660   sandbox:sandbox \n")).toEqual({
      mode: "660",
      owner: "sandbox:sandbox",
    });
  });
});

describe("inspectMutableConfigPerms (#4538)", () => {
  it("reports ok when the mutable contract is intact", () => {
    const result = inspectMutableConfigPerms(
      OPENCLAW_TARGET,
      "mutable_default",
      statFromMap({
        "/sandbox/.openclaw": "2770 sandbox:sandbox",
        "/sandbox/.openclaw/openclaw.json": "660 sandbox:sandbox",
      }),
    );
    expect(result.applies).toBe(true);
    if (result.applies) {
      expect(result.ok).toBe(true);
      expect(result.issues).toEqual([]);
      expect(result.dirMode).toBe("2770");
      expect(result.fileMode).toBe("660");
    }
  });

  it("flags a tree tightened by openclaw doctor --fix to 700/600", () => {
    const result = inspectMutableConfigPerms(
      OPENCLAW_TARGET,
      "temporarily_unlocked",
      statFromMap({
        "/sandbox/.openclaw": "700 sandbox:sandbox",
        "/sandbox/.openclaw/openclaw.json": "600 sandbox:sandbox",
      }),
    );
    expect(result.applies).toBe(true);
    if (result.applies) {
      expect(result.ok).toBe(false);
      expect(result.issues).toHaveLength(2);
      expect(result.issues[0]).toContain("/sandbox/.openclaw mode 700");
      expect(result.issues[1]).toContain("openclaw.json mode 600");
    }
  });

  it("flags owner or group drift even when modes match the mutable contract", () => {
    const result = inspectMutableConfigPerms(
      OPENCLAW_TARGET,
      "mutable_default",
      statFromMap({
        "/sandbox/.openclaw": "2770 root:root",
        "/sandbox/.openclaw/openclaw.json": "660 sandbox:root",
      }),
    );
    expect(result.applies).toBe(true);
    if (result.applies) {
      expect(result.ok).toBe(false);
      expect(result.issues).toEqual([
        "/sandbox/.openclaw owner root:root (expected sandbox:sandbox)",
        "openclaw.json owner sandbox:root (expected sandbox:sandbox)",
      ]);
    }
  });

  it("does not apply to non-OpenClaw agents", () => {
    const result = inspectMutableConfigPerms(HERMES_TARGET, "mutable_default", () => {
      throw new Error("should not stat for hermes");
    });
    expect(result.applies).toBe(false);
    if (!result.applies) expect(result.reason).toContain("hermes");
  });

  it("does not apply (and never stats) when shields are up", () => {
    const stat = vi.fn(() => "700 root:root");
    const result = inspectMutableConfigPerms(OPENCLAW_TARGET, "locked", stat);
    expect(result.applies).toBe(false);
    if (!result.applies) expect(result.reason).toContain("locked");
    expect(stat).not.toHaveBeenCalled();
  });

  it("does not apply when the config cannot be stat'd (container down)", () => {
    const result = inspectMutableConfigPerms(
      OPENCLAW_TARGET,
      "mutable_default",
      () => {
        throw new Error("container is not running");
      },
    );
    expect(result.applies).toBe(false);
    if (!result.applies) expect(result.reason).toContain("could not stat");
  });

  it("flags sensitive-file drift the user-facing check would otherwise miss", () => {
    const target: MutableConfigTarget = {
      ...OPENCLAW_TARGET,
      sensitiveFiles: ["/sandbox/.openclaw/.config-hash"],
    };
    const result = inspectMutableConfigPerms(
      target,
      "mutable_default",
      statFromMap({
        "/sandbox/.openclaw": "2770 sandbox:sandbox",
        "/sandbox/.openclaw/openclaw.json": "660 sandbox:sandbox",
        "/sandbox/.openclaw/.config-hash": "644 root:root",
      }),
    );
    expect(result.applies).toBe(true);
    if (result.applies) {
      expect(result.ok).toBe(false);
      expect(result.issues).toEqual([
        "/sandbox/.openclaw/.config-hash mode 644 (expected 660 group-writable)",
        "/sandbox/.openclaw/.config-hash owner root:root (expected sandbox:sandbox)",
      ]);
    }
  });

  it("tolerates a missing sensitive file (e.g. .config-hash before first lock cycle)", () => {
    const target: MutableConfigTarget = {
      ...OPENCLAW_TARGET,
      sensitiveFiles: ["/sandbox/.openclaw/.config-hash"],
    };
    const result = inspectMutableConfigPerms(
      target,
      "mutable_default",
      statFromMap({
        "/sandbox/.openclaw": "2770 sandbox:sandbox",
        "/sandbox/.openclaw/openclaw.json": "660 sandbox:sandbox",
        // .config-hash intentionally absent
      }),
    );
    expect(result.applies).toBe(true);
    if (result.applies) {
      expect(result.ok).toBe(true);
      expect(result.issues).toEqual([]);
    }
  });
});

describe("repairMutableConfigPerms (#4538)", () => {
  it("applies the mutable contract for OpenClaw and reports verified", () => {
    const apply = vi.fn();
    const result = repairMutableConfigPerms(
      OPENCLAW_TARGET,
      "temporarily_unlocked",
      apply,
    );
    expect(apply).toHaveBeenCalledOnce();
    expect(result).toEqual({ applied: true, verified: true, errors: [] });
  });

  it("reports unverified (with the error) when the apply step throws", () => {
    const result = repairMutableConfigPerms(
      OPENCLAW_TARGET,
      "mutable_default",
      () => {
        throw new Error("Config not unlocked: openclaw.json mode=600");
      },
    );
    expect(result.applied).toBe(true);
    if (result.applied) {
      expect(result.verified).toBe(false);
      expect(result.errors[0]).toContain("mode=600");
    }
  });

  it("refuses to weaken a shields-up lock (benign skip) and never applies", () => {
    const apply = vi.fn();
    const result = repairMutableConfigPerms(OPENCLAW_TARGET, "locked", apply);
    expect(apply).not.toHaveBeenCalled();
    expect(result.applied).toBe(false);
    if (!result.applied) {
      expect(result.skipReason).toBe("locked");
      expect(result.reason).toContain("locked");
    }
  });

  it("flags corrupt shields state as an unreadable (non-benign) skip", () => {
    const apply = vi.fn();
    const result = repairMutableConfigPerms(OPENCLAW_TARGET, "error", apply);
    expect(apply).not.toHaveBeenCalled();
    expect(result.applied).toBe(false);
    if (!result.applied) {
      expect(result.skipReason).toBe("unreadable");
      expect(result.reason).toContain("unreadable");
    }
  });

  it("does not apply to non-OpenClaw agents", () => {
    const apply = vi.fn();
    const result = repairMutableConfigPerms(
      HERMES_TARGET,
      "mutable_default",
      apply,
    );
    expect(apply).not.toHaveBeenCalled();
    expect(result.applied).toBe(false);
    if (!result.applied) expect(result.skipReason).toBe("agent");
  });
});
