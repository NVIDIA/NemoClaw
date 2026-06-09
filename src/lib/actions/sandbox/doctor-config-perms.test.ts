// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MutableConfigPermsInspection,
  MutableConfigRepairResult,
} from "../../shields/mutable-config-perms";
import { buildConfigPermsCheck } from "./doctor-config-perms";

const inspect = vi.fn<(name: string) => MutableConfigPermsInspection>();
const repair = vi.fn<(name: string) => MutableConfigRepairResult>();

function deps() {
  return { inspect, repair, cliName: "nemoclaw" };
}

const intact: MutableConfigPermsInspection = {
  applies: true,
  ok: true,
  dirMode: "2770",
  dirOwner: "sandbox:sandbox",
  fileMode: "660",
  fileOwner: "sandbox:sandbox",
  configDir: "/sandbox/.openclaw",
  configFile: "openclaw.json",
  issues: [],
};

const tightened: MutableConfigPermsInspection = {
  applies: true,
  ok: false,
  dirMode: "700",
  dirOwner: "sandbox:sandbox",
  fileMode: "600",
  fileOwner: "sandbox:sandbox",
  configDir: "/sandbox/.openclaw",
  configFile: "openclaw.json",
  issues: [
    "/sandbox/.openclaw mode 700 (expected 2770 setgid+group-writable)",
    "openclaw.json mode 600 (expected 660 group-writable)",
  ],
};

describe("buildConfigPermsCheck (#4538)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the check does not apply", () => {
    inspect.mockReturnValue({ applies: false, reason: "shields up" });
    expect(buildConfigPermsCheck("alpha", false, deps())).toBeNull();
  });

  it("surfaces a warn check (not null) when the inspection probe throws", () => {
    inspect.mockImplementation(() => {
      throw new Error("boom");
    });
    const check = buildConfigPermsCheck("alpha", false, deps());
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("permission probe failed");
    expect(check?.detail).toContain("boom");
  });

  it("reports ok when the mutable contract is intact", () => {
    inspect.mockReturnValue(intact);
    const check = buildConfigPermsCheck("alpha", false, deps());
    expect(check?.status).toBe("ok");
    expect(check?.detail).toContain("2770");
    expect(check?.detail).toContain("660");
    expect(repair).not.toHaveBeenCalled();
  });

  it("warns (without repairing) when tightened and --fix is not set", () => {
    inspect.mockReturnValue(tightened);
    const check = buildConfigPermsCheck("alpha", false, deps());
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("mode 700");
    expect(check?.hint).toContain("doctor --fix");
    expect(repair).not.toHaveBeenCalled();
  });

  it("repairs and reports ok when --fix succeeds", () => {
    inspect.mockReturnValueOnce(tightened).mockReturnValueOnce(intact);
    repair.mockReturnValue({ applied: true, verified: true, errors: [] });
    const check = buildConfigPermsCheck("alpha", true, deps());
    expect(repair).toHaveBeenCalledWith("alpha");
    expect(check?.status).toBe("ok");
    expect(check?.detail).toContain("restored mutable contract");
    expect(check?.detail).toContain("700");
  });

  it("fails when --fix repair leaves issues behind", () => {
    inspect.mockReturnValueOnce(tightened).mockReturnValueOnce(tightened);
    repair.mockReturnValue({
      applied: true,
      verified: false,
      errors: ["chmod failed"],
    });
    const check = buildConfigPermsCheck("alpha", true, deps());
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("repair incomplete");
    expect(check?.hint).toContain("rebuild");
  });

  it("fails when repair verification fails even if re-inspection only checks the main config", () => {
    inspect.mockReturnValueOnce(tightened).mockReturnValueOnce(intact);
    repair.mockReturnValue({
      applied: true,
      verified: false,
      errors: ["/sandbox/.openclaw/.config-hash owner=root:root"],
    });
    const check = buildConfigPermsCheck("alpha", true, deps());
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("repair incomplete");
    expect(check?.detail).toContain(".config-hash");
  });

  it("warns when --fix is skipped (e.g. shields flipped to locked)", () => {
    inspect.mockReturnValue(tightened);
    repair.mockReturnValue({
      applied: false,
      skipReason: "locked",
      reason: "shields are up (config is locked)",
    });
    const check = buildConfigPermsCheck("alpha", true, deps());
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("repair skipped");
    expect(check?.detail).toContain("locked");
  });

  it("preserves the re-inspection reason when --fix verifies but re-inspect fails", () => {
    inspect.mockReturnValueOnce(tightened).mockImplementationOnce(() => {
      throw new Error("container vanished");
    });
    repair.mockReturnValue({ applied: true, verified: true, errors: [] });
    const check = buildConfigPermsCheck("alpha", true, deps());
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("repair incomplete");
    // The only actionable signal is the re-inspection failure reason, not "unknown".
    expect(check?.detail).toContain("re-inspection failed");
    expect(check?.detail).not.toContain("unknown");
  });

  it("fails gracefully when --fix repair throws", () => {
    inspect.mockReturnValue(tightened);
    repair.mockImplementation(() => {
      throw new Error("container not running");
    });
    const check = buildConfigPermsCheck("alpha", true, deps());
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("repair failed");
    expect(check?.detail).toContain("container not running");
  });
});
