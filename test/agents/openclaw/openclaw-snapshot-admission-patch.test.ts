// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import vm from "node:vm";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { patchGatewaySnapshotAdmission } from "../../../scripts/lib/patch-openclaw-container-restart.mts";

// Reviewed 2026.10.5 acquisition boundary. Native ownership classification and
// the acquisition loop stay upstream-owned; exercise the generated predicate.
const native = fs.readFileSync(
  new URL("./fixtures/gateway-state-snapshot-admission-10.5.js.txt", import.meta.url),
  "utf8",
);
class GatewayLockNamespaceError extends Error {}
class StateDatabaseAdmissionPendingError extends Error {
  constructor(readonly databasePath: string) {
    super("pending");
  }
}

function retryPolicy(sandbox: string | undefined) {
  const patched = patchGatewaySnapshotAdmission(native).replace(/^import[^\n]+\n/u, "");
  return vm.runInNewContext(`${patched}; withOpenClawStateDatabaseReadSnapshot`, {
    process: { env: { OPENSHELL_SANDBOX: sandbox } },
    GatewayLockNamespaceError,
    StateDatabaseAdmissionPendingError,
    pathname: "/state/openclaw.sqlite",
    captureOpenClawStateDatabaseReadAdmission: () => {
      throw new Error("unused");
    },
    acquireWithWait: (options: unknown) => options,
    performance: { now: () => 100 },
  });
}

describe("OpenClaw snapshot namespace admission", () => {
  it.each(["1", "0", undefined])("keeps admission bounded for sandbox=%s", async (sandbox) => {
    const options = await retryPolicy(sandbox)(() => {}, { admissionTimeoutMs: 300_000 });
    expect(options.deadlineMs).toBe(300_100);
    expect(options.pollIntervalMs).toBe(250);
    expect(options.shouldRetry(new GatewayLockNamespaceError("fresh owner"))).toBe(sandbox === "1");
    expect(
      options.shouldRetry(new StateDatabaseAdmissionPendingError("/state/openclaw.sqlite")),
    ).toBe(true);
    expect(options.shouldRetry(new StateDatabaseAdmissionPendingError("/other.sqlite"))).toBe(
      false,
    );
    expect(options.shouldRetry(new Error("GatewayLockNamespaceError"))).toBe(false);
    expect(options.shouldRetry({ name: "GatewayLockNamespaceError" })).toBe(false);
    expect((await retryPolicy(sandbox)(() => {})).deadlineMs).toBe(100);
  });

  it("audits both patch boundaries", () => {
    const patched = patchGatewaySnapshotAdmission(native);
    expect(patchGatewaySnapshotAdmission(patched)).toBe(patched);
  });

  it.each([
    native + native,
    native.replace("StateDatabaseAdmissionPendingError }", "ChangedError }"),
    native.replace("error.databasePath === pathname", "false"),
    patchGatewaySnapshotAdmission(native).replace('process.env.OPENSHELL_SANDBOX === "1"', "true"),
    patchGatewaySnapshotAdmission(native).replace("b as GatewayLockNamespaceError, ", ""),
  ])("rejects partial patches or native drift %#", (source) => {
    expect(() => patchGatewaySnapshotAdmission(source)).toThrow();
  });
});
