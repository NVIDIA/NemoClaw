// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

import { describe, it } from "vitest";

import {
  findAvailableDashboardPort,
  findDashboardForwardOwner,
} from "../../../dist/lib/onboard/dashboard-port";

describe("findDashboardForwardOwner", () => {
  it("parses openshell forward list column format (#2169)", () => {
    const forwardList = [
      "SANDBOX     BIND             PORT   PID     STATUS",
      "test21      127.0.0.1        18789  42101   active",
      "other       127.0.0.1        18790  42102   active",
      "stopped     127.0.0.1        18792  42103   stopped",
      "ansi        127.0.0.1        18793  42104   \u001b[32mrunning\u001b[0m",
    ].join("\n");

    assert.equal(findDashboardForwardOwner(forwardList, "18789"), "test21");
    assert.equal(findDashboardForwardOwner(forwardList, "18790"), "other");
    assert.equal(findDashboardForwardOwner(forwardList, "18791"), null);
    assert.equal(findDashboardForwardOwner(forwardList, "18792"), null);
    assert.equal(findDashboardForwardOwner(forwardList, "18793"), "ansi");
    assert.equal(findDashboardForwardOwner("", "18789"), null);
    assert.equal(findDashboardForwardOwner(null, "18789"), null);
    assert.equal(findDashboardForwardOwner(undefined, "18789"), null);
    const falsePositive = "sandbox18789 127.0.0.1 42001 9999 active";
    assert.equal(findDashboardForwardOwner(falsePositive, "18789"), null);
  });
});

describe("findAvailableDashboardPort port-conflict detection (#3260)", () => {
  const stubBound = (...bound: number[]) => {
    const set = new Set(bound);
    return (port: number) => set.has(port);
  };

  it("returns the preferred port when no forward owns it and the host says it is free", () => {
    assert.equal(findAvailableDashboardPort("cursor", 18789, "", stubBound()), 18789);
  });

  it("skips the preferred port when host reports it bound and falls through to the range scan", () => {
    assert.equal(findAvailableDashboardPort("cursor", 18789, "", stubBound(18789)), 18790);
  });

  it("skips ports owned by other sandboxes and host-bound ports together", () => {
    const forwardList = [
      "SANDBOX  BIND  PORT  PID  STATUS",
      "alpha    127.0.0.1  18789  111  running",
    ].join("\n");
    assert.equal(findAvailableDashboardPort("cursor", 18789, forwardList, stubBound(18790)), 18791);
  });

  it("returns the preferred port when this sandbox already owns it", () => {
    const forwardList = [
      "SANDBOX  BIND  PORT  PID  STATUS",
      "cursor   127.0.0.1  18789  111  running",
    ].join("\n");
    assert.equal(findAvailableDashboardPort("cursor", 18789, forwardList, stubBound(18789)), 18789);
  });

  it("throws when every port in the range is occupied by other sandboxes", () => {
    const lines = ["SANDBOX  BIND  PORT  PID  STATUS"];
    for (let p = 18789; p <= 18799; p++) {
      lines.push(`other${p}    127.0.0.1  ${p}  ${p}  running`);
    }
    assert.throws(
      () => findAvailableDashboardPort("cursor", 18789, lines.join("\n"), stubBound()),
      /All dashboard ports in range 18789-18799 are occupied/,
    );
  });

  it("includes host-bound ports in the exhaustion error so users know what's blocking them", () => {
    const allBound = new Set<number>();
    for (let p = 18789; p <= 18799; p++) allBound.add(p);
    assert.throws(
      () => findAvailableDashboardPort("cursor", 18789, "", (p) => allBound.has(p)),
      /18789 → non-OpenShell host listener/,
    );
  });

  it("probes each port at most once even when the preferred port is in the range", () => {
    const seen: number[] = [];
    const stub = (port: number) => {
      seen.push(port);
      return port === 18789;
    };
    findAvailableDashboardPort("cursor", 18789, "", stub);
    assert.deepEqual(seen, [18789, 18790]);
  });
});
