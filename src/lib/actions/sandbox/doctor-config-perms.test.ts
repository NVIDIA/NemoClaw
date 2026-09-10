// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MutableConfigPermsInspection,
  MutableConfigRepairResult,
} from "../../sandbox/mutable-config-perms";
import { buildConfigPermsCheck } from "./doctor-config-perms";

const inspect = vi.fn<(name: string) => MutableConfigPermsInspection>();
const repair = vi.fn<(name: string) => MutableConfigRepairResult>();

function deps() {
  return { inspect, repair, cliName: "nemoclaw" };
}

const intact: MutableConfigPermsInspection = {
  applies: true,
  ok: true,
  issues: [],
};

const tightened: MutableConfigPermsInspection = {
  applies: true,
  ok: false,
  issues: ["config mode differs from runtime contract"],
};

describe("buildConfigPermsCheck (#4538)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the check does not apply", () => {
    inspect.mockReturnValue({
      applies: false,
      skipReason: "agent",
      reason: "not OpenClaw",
    });
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
    expect(check?.detail).toContain("verified");
    expect(repair).not.toHaveBeenCalled();
  });

  it("warns (without repairing) when tightened and --fix is not set", () => {
    inspect.mockReturnValue(tightened);
    const check = buildConfigPermsCheck("alpha", false, deps());
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("config mode differs");
    expect(check?.hint).toContain("doctor --fix");
    expect(repair).not.toHaveBeenCalled();
  });

  it("repairs and reports ok when --fix succeeds", () => {
    inspect.mockReturnValue(tightened);
    repair.mockReturnValue({ applied: true, verified: true, errors: [] });
    const check = buildConfigPermsCheck("alpha", true, deps());
    expect(repair).toHaveBeenCalledWith("alpha");
    expect(check?.status).toBe("ok");
    expect(check?.detail).toContain("verified after repair");
    expect(inspect).toHaveBeenCalledOnce();
  });

  it("fails when --fix repair leaves issues behind", () => {
    inspect.mockReturnValue(tightened);
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

  it("preserves the guard's repair verification failure", () => {
    inspect.mockReturnValue(tightened);
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

  it("warns when --fix is skipped for another agent", () => {
    inspect.mockReturnValue(tightened);
    repair.mockReturnValue({
      applied: false,
      skipReason: "agent",
      reason: "agent does not use the OpenClaw config contract",
    });
    const check = buildConfigPermsCheck("alpha", true, deps());
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("repair skipped");
    expect(check?.detail).toContain("does not use");
  });

  it("does not attempt repair when inspection is inconclusive", () => {
    inspect.mockReturnValue({
      applies: false,
      skipReason: "unavailable",
      reason: "startup-not-ready",
    });
    const check = buildConfigPermsCheck("alpha", true, deps());
    expect(check?.status).toBe("warn");
    expect(check?.detail).toContain("startup-not-ready");
    expect(repair).not.toHaveBeenCalled();
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
