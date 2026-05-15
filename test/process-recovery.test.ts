// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  classifyForwardHealthWithReachability,
  classifySandboxForwardHealth,
  resolveSandboxDashboardPort,
  type SandboxForwardListEntry,
} from "../dist/lib/actions/sandbox/process-recovery.js";

describe("resolveSandboxDashboardPort", () => {
  it("uses the recorded OpenClaw dashboard port for multi-sandbox recovery", () => {
    expect(
      resolveSandboxDashboardPort("beta", {
        getSessionAgent: () => null,
        getSandbox: () => ({ name: "beta", dashboardPort: 18790 }),
      }),
    ).toBe(18790);
  });

  it("falls back to the default OpenClaw dashboard port when registry metadata is absent", () => {
    expect(
      resolveSandboxDashboardPort("legacy", {
        getSessionAgent: () => null,
        getSandbox: () => null,
      }),
    ).toBe(18789);
  });

  it("keeps non-OpenClaw agents on their declared forward port", () => {
    expect(
      resolveSandboxDashboardPort("hermes-box", {
        getSessionAgent: () => ({ forwardPort: 8642 }),
        getSandbox: () => ({ name: "hermes-box", dashboardPort: 18790 }),
      }),
    ).toBe(8642);
  });

  it("ignores invalid agent forward ports and falls back to registry metadata", () => {
    expect(
      resolveSandboxDashboardPort("beta", {
        getSessionAgent: () => ({ forwardPort: 0 }),
        getSandbox: () => ({ name: "beta", dashboardPort: 18790 }),
      }),
    ).toBe(18790);
  });
});

describe("classifySandboxForwardHealth", () => {
  it("returns true for a running forward owned by the target sandbox", () => {
    expect(
      classifySandboxForwardHealth(
        [{ sandboxName: "beta", port: "18790", status: "running" }],
        "beta",
        "18790",
      ),
    ).toBe(true);
  });

  it("returns occupied when another sandbox owns the expected port", () => {
    expect(
      classifySandboxForwardHealth(
        [{ sandboxName: "alpha", port: "18790", status: "running" }],
        "beta",
        "18790",
      ),
    ).toBe("occupied");
  });

  it("returns false for a missing forward", () => {
    expect(classifySandboxForwardHealth([], "beta", "18790")).toBe(false);
  });

  it("returns false for a non-running forward owned by the target sandbox", () => {
    expect(
      classifySandboxForwardHealth(
        [{ sandboxName: "beta", port: "18790", status: "dead" }],
        "beta",
        "18790",
      ),
    ).toBe(false);
  });
});

describe("classifyForwardHealthWithReachability", () => {
  // Regression coverage for #3334: `openshell forward list` STATUS can lag the
  // real state of the forward. When it shows a non-running entry but the
  // local port still answers, the forward is functionally healthy and the
  // probe must not trigger spurious "missing or dead" + "Failed to
  // re-establish" log pairs.
  it("treats a non-running entry as healthy when the local port answers", () => {
    // Covers both branches that produce `false` from the underlying classifier:
    // a missing entry, and an entry whose status is anything but "running".
    const inputs: SandboxForwardListEntry[][] = [
      [],
      [{ sandboxName: "beta", port: "18790", status: "dead" }],
    ];
    for (const entries of inputs) {
      expect(
        classifyForwardHealthWithReachability(entries, "beta", "18790", () => true),
      ).toBe(true);
    }
  });

  it("returns false when forward list says dead and the port does not answer", () => {
    expect(
      classifyForwardHealthWithReachability(
        [{ sandboxName: "beta", port: "18790", status: "dead" }],
        "beta",
        "18790",
        () => false,
      ),
    ).toBe(false);
  });

  it("returns true without probing when forward list already reports running", () => {
    let probed = false;
    const result = classifyForwardHealthWithReachability(
      [{ sandboxName: "beta", port: "18790", status: "running" }],
      "beta",
      "18790",
      () => {
        probed = true;
        return false;
      },
    );
    expect(result).toBe(true);
    expect(probed).toBe(false);
  });

  it("returns occupied even when the port answers if another sandbox owns it", () => {
    // Reachability says yes, but the entry belongs to a different sandbox —
    // we must not silently take over someone else's forward.
    expect(
      classifyForwardHealthWithReachability(
        [{ sandboxName: "alpha", port: "18790", status: "running" }],
        "beta",
        "18790",
        () => true,
      ),
    ).toBe("occupied");
  });
});
