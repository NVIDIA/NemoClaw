// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  buildToolScopeChecks,
  buildToolScopeProbeScript,
  interpretToolScopeProbe,
  parseToolScopeProbe,
  type ToolScopeProbe,
} from "./doctor-tool-scope";

const MARKER = "__NEMOCLAW_TOOL_SCOPE_PROBE__";

type ProbeOverrides = Partial<Omit<ToolScopeProbe, "signals">> & {
  signals?: Partial<ToolScopeProbe["signals"]>;
};

function probe(overrides: ProbeOverrides = {}): ToolScopeProbe {
  const { signals: signalOverrides, ...rest } = overrides;
  return {
    ok: true,
    devicesListOk: true,
    pendingTotal: 0,
    pendingAllowlisted: 0,
    pendingUnknown: 0,
    watcherActive: true,
    dashboardPort: 18789,
    ...rest,
    signals: {
      gateway1006: false,
      scopePending: false,
      loopbackDenied: false,
      watcherDeadline: false,
      rejectedClients: 0,
      ...(signalOverrides ?? {}),
    },
  };
}

describe("buildToolScopeProbeScript (#4616)", () => {
  it("embeds the read-only probe with the policy and log scans", () => {
    const script = buildToolScopeProbeScript("UE9MSUNZ");
    // read-only: lists, never approves
    expect(script).toContain("devices");
    expect(script).toContain("list");
    expect(script).not.toContain("'approve'");
    expect(script).toContain("/tmp/nemoclaw-proxy-env.sh");
    expect(script).toContain("PYPROBE");
    expect(script).toContain(MARKER);
    // signal scans
    expect(script).toContain("1006");
    expect(script).toContain("scope upgrade pending approval");
    expect(script).toContain("[auto-pair] rejected");
    expect(script).toContain("[auto-pair] watcher deadline reached");
    expect(script).toContain("127");
    // watcher liveness via /proc fd
    expect(script).toContain("/tmp/auto-pair.log");
    // policy embedded
    expect(script).toContain("'UE9MSUNZ'");
  });

  it("falls back to an empty policy when none is available", () => {
    const script = buildToolScopeProbeScript("");
    expect(script).toContain("NEMOCLAW_APPROVAL_POLICY_B64=''");
  });
});

describe("parseToolScopeProbe (#4616)", () => {
  it("parses the marker JSON payload", () => {
    const raw = `noise\n${MARKER}${JSON.stringify({
      ok: true,
      devicesListOk: true,
      pendingTotal: 2,
      pendingAllowlisted: 1,
      pendingUnknown: 1,
      watcherActive: false,
      dashboardPort: 18789,
      signals: {
        gateway1006: true,
        scopePending: true,
        loopbackDenied: true,
        watcherDeadline: true,
        rejectedClients: 3,
      },
    })}\ntrailing`;
    const parsed = parseToolScopeProbe(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.pendingAllowlisted).toBe(1);
    expect(parsed?.pendingUnknown).toBe(1);
    expect(parsed?.watcherActive).toBe(false);
    expect(parsed?.dashboardPort).toBe(18789);
    expect(parsed?.signals.gateway1006).toBe(true);
    expect(parsed?.signals.rejectedClients).toBe(3);
  });

  it("normalizes a failed probe", () => {
    const parsed = parseToolScopeProbe(`${MARKER}{"ok": false}`);
    expect(parsed).not.toBeNull();
    expect(parsed?.ok).toBe(false);
  });

  it("returns null without a marker or with garbage", () => {
    expect(parseToolScopeProbe("no marker here")).toBeNull();
    expect(parseToolScopeProbe(`${MARKER}not-json`)).toBeNull();
    expect(parseToolScopeProbe("")).toBeNull();
  });
});

describe("interpretToolScopeProbe (#4616)", () => {
  const base = { sandboxName: "sb", cliName: "nemoclaw", wantsFix: false };

  it("reports info when the probe is unavailable", () => {
    for (const p of [null, probe({ ok: false })]) {
      const checks = interpretToolScopeProbe(p, base);
      expect(checks).toHaveLength(1);
      expect(checks[0].status).toBe("info");
      expect(checks[0].detail).toContain("unavailable");
    }
  });

  it("fails with a fix hint when allowlisted upgrades are pending", () => {
    const checks = interpretToolScopeProbe(
      probe({
        pendingTotal: 1,
        pendingAllowlisted: 1,
        watcherActive: false,
        signals: { gateway1006: true, scopePending: true, loopbackDenied: true },
      }),
      base,
    );
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe("fail");
    expect(checks[0].detail).toContain("1 pending allowlisted tool-scope upgrade");
    expect(checks[0].detail).toContain("gateway closed 1006");
    expect(checks[0].detail).toContain("scope upgrade pending approval");
    expect(checks[0].detail).toContain("127.0.0.1:18789");
    expect(checks[0].detail).toContain("auto-pair watcher is not running");
    expect(checks[0].hint).toContain("doctor --fix");
  });

  it("warns on a recent log signature only when the device list is unreadable", () => {
    const checks = interpretToolScopeProbe(
      probe({ devicesListOk: false, signals: { gateway1006: true } }),
      base,
    );
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe("warn");
    expect(checks[0].detail).toContain("recent OpenClaw tool-scope failure");
    expect(checks[0].detail).toContain("could not read the device list");
    // Steer to gateway recovery first, since --fix alone would dead-end while
    // the device list is unreadable.
    expect(checks[0].hint).toContain("recover");
    expect(checks[0].hint).toContain("doctor --fix");
  });

  it("reports ok (not a stale-log warning) when the device list shows nothing pending", () => {
    // Logs still carry 1006/scope-pending lines from a just-completed fix, but
    // the readable device list shows no backlog — current state wins.
    const checks = interpretToolScopeProbe(
      probe({ signals: { gateway1006: true, scopePending: true, loopbackDenied: true } }),
      base,
    );
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe("ok");
    expect(checks[0].detail).toContain("no pending tool-scope approvals");
  });

  it("warns but does not offer auto-approval for non-allowlisted pending clients", () => {
    const checks = interpretToolScopeProbe(probe({ pendingTotal: 2, pendingUnknown: 2 }), base);
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe("warn");
    expect(checks[0].detail).toContain("non-allowlisted");
    expect(checks[0].detail).toContain("not auto-approved");
    expect(checks[0].hint).not.toContain("--fix");
  });

  it("reports ok when there is nothing pending", () => {
    const checks = interpretToolScopeProbe(probe(), base);
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe("ok");
    expect(checks[0].detail).toContain("no pending tool-scope approvals");
  });

  it("reports a repair line after --fix approves upgrades", () => {
    const checks = interpretToolScopeProbe(probe(), {
      ...base,
      wantsFix: true,
      fix: { reported: true, approved: 2 },
    });
    expect(checks).toHaveLength(2);
    expect(checks[0].label).toContain("repair");
    expect(checks[0].status).toBe("ok");
    expect(checks[0].detail).toContain("approved 2 pending tool-scope upgrade");
    expect(checks[1].status).toBe("ok");
  });

  it("reports info when the device list could not be read", () => {
    const checks = interpretToolScopeProbe(probe({ devicesListOk: false }), base);
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe("info");
    expect(checks[0].detail).toContain("could not read");
  });
});

describe("buildToolScopeChecks (#4616)", () => {
  function execReturning(probes: (ToolScopeProbe | null)[]) {
    let call = 0;
    return vi.fn((_name: string, _script: string) => {
      const p = probes[Math.min(call, probes.length - 1)];
      call += 1;
      return p ? { status: 0, stdout: `${MARKER}${JSON.stringify(p)}`, stderr: "" } : null;
    });
  }

  it("runs the repair pass and re-probes when --fix sees a backlog", () => {
    const exec = execReturning([
      probe({ pendingTotal: 1, pendingAllowlisted: 1, watcherActive: false }),
      probe(), // clean after repair
    ]);
    const runApprovalPass = vi.fn(() => ({ reported: true, approved: 1 }));
    const checks = buildToolScopeChecks("sb", "nemoclaw", true, {
      exec,
      runApprovalPass,
      readPolicyModule: () => "policy",
    });
    expect(runApprovalPass).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(checks[0].label).toContain("repair");
    expect(checks.some((c) => c.status === "ok" && c.detail.includes("no pending"))).toBe(true);
  });

  it("does not repair when --fix is not requested", () => {
    const exec = execReturning([probe({ pendingTotal: 1, pendingAllowlisted: 1 })]);
    const runApprovalPass = vi.fn(() => ({ reported: true, approved: 1 }));
    const checks = buildToolScopeChecks("sb", "nemoclaw", false, {
      exec,
      runApprovalPass,
      readPolicyModule: () => "policy",
    });
    expect(runApprovalPass).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(checks[0].status).toBe("fail");
  });

  it("does not repair when --fix is set but no allowlisted backlog exists", () => {
    const exec = execReturning([probe({ pendingTotal: 1, pendingUnknown: 1 })]);
    const runApprovalPass = vi.fn(() => ({ reported: true, approved: 0 }));
    const checks = buildToolScopeChecks("sb", "nemoclaw", true, {
      exec,
      runApprovalPass,
      readPolicyModule: () => "policy",
    });
    expect(runApprovalPass).not.toHaveBeenCalled();
    expect(checks[0].status).toBe("warn");
  });

  it("surfaces unavailable when the sandbox exec fails", () => {
    const exec = vi.fn(() => null);
    const checks = buildToolScopeChecks("sb", "nemoclaw", false, {
      exec,
      readPolicyModule: () => null,
    });
    expect(checks[0].status).toBe("info");
    expect(checks[0].detail).toContain("unavailable");
  });
});
