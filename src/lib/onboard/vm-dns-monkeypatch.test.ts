// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { applyOnboardVmDnsMonkeypatch } from "../../../dist/lib/onboard/vm-dns-monkeypatch";

describe("applyOnboardVmDnsMonkeypatch", () => {
  it("logs applied only when the onboard VM DNS monkeypatch changes files", () => {
    const changedLogs: string[] = [];
    applyOnboardVmDnsMonkeypatch(
      "demo",
      { openshellDriver: "vm" },
      {
        apply: () => ({
          attempted: true,
          changed: true,
          ok: true,
          status: "applied",
        }),
        log: (message) => changedLogs.push(message),
        warn: (message) => changedLogs.push(message),
      },
    );

    const unchangedLogs: string[] = [];
    applyOnboardVmDnsMonkeypatch(
      "demo",
      { openshellDriver: "vm" },
      {
        apply: () => ({
          attempted: true,
          changed: false,
          ok: true,
          status: "already-present",
        }),
        log: (message) => unchangedLogs.push(message),
        warn: (message) => unchangedLogs.push(message),
      },
    );

    expect(changedLogs).toEqual(["  ✓ Applied OpenShell VM DNS monkeypatch"]);
    expect(unchangedLogs).toEqual(["  OpenShell VM DNS monkeypatch already present"]);
    expect(unchangedLogs.join("\n")).not.toContain("Applied");
  });

  it("logs skipped VM DNS monkeypatch state for VM sandboxes", () => {
    const logs: string[] = [];

    applyOnboardVmDnsMonkeypatch(
      "demo",
      { openshellDriver: "vm" },
      {
        apply: () => ({
          attempted: false,
          changed: false,
          ok: false,
          reason: "disabled by NEMOCLAW_DISABLE_VM_DNS_MONKEYPATCH=1",
          status: "skipped",
        }),
        log: (message) => logs.push(message),
        warn: (message) => logs.push(message),
      },
    );

    expect(logs).toEqual([
      "  OpenShell VM DNS monkeypatch skipped: disabled by NEMOCLAW_DISABLE_VM_DNS_MONKEYPATCH=1",
    ]);
  });

  it("warns without aborting when the onboard VM DNS monkeypatch fails", () => {
    const warnings: string[] = [];

    expect(() =>
      applyOnboardVmDnsMonkeypatch(
        "demo",
        { openshellDriver: "vm" },
        {
          apply: () => ({
            attempted: true,
            changed: false,
            ok: false,
            reason: "VM rootfs not found",
            status: "failed",
          }),
          log: (message) => warnings.push(message),
          warn: (message) => warnings.push(message),
        },
      ),
    ).not.toThrow();

    expect(warnings).toEqual([
      "  Warning: OpenShell VM DNS monkeypatch did not apply: VM rootfs not found",
    ]);
  });
});
