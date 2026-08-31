// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  readMcpLockHostIdentity,
  readMcpLockPidNamespaceIdentity,
} from "../../state/mcp-lifecycle-lock-identity";
import { createForwardServiceController } from "./forward-service-controller";
import { buildForwardServiceArgs, type ForwardServicePendingReceipt } from "./forward-service";
import {
  readForwardServicePendingReceipt,
  writeForwardServicePendingReceipt,
} from "./forward-service-state";

const uid = process.getuid?.() ?? 0;
const target = {
  executable: "/usr/local/bin/openshell",
  gatewayName: "nemoclaw",
  workspace: "default" as const,
  sandboxName: "alpha",
  sandboxIdentityFingerprint: "a".repeat(64),
  localHost: "127.0.0.1" as const,
  localPort: 18_789,
  targetHost: "127.0.0.1" as const,
  targetPort: 18_789,
};

function pending(pid: number, receiptTarget: typeof target = target): ForwardServicePendingReceipt {
  return {
    pendingSchemaVersion: 1,
    ...receiptTarget,
    pid,
    launcherUid: uid,
    hostIdentity: readMcpLockHostIdentity(),
    pidNamespaceIdentity: readMcpLockPidNamespaceIdentity(),
    expectedArgv: [receiptTarget.executable, ...buildForwardServiceArgs(receiptTarget)],
    startedAt: "2026-08-31T16:00:00.000Z",
  };
}

describe("OpenShell ForwardTcp controller pending cleanup", () => {
  let stateDirectory = "";

  beforeEach(() => {
    stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-forward-controller-"));
  });

  afterEach(() => {
    fs.rmSync(stateDirectory, { force: true, recursive: true });
  });

  const controller = () =>
    createForwardServiceController({
      executable: () => {
        throw new Error("cleanup must not resolve an executable");
      },
      stateDirectory,
      runExclusive: (_sandboxName, operation) => operation(),
    });
  const authority = {
    gatewayName: target.gatewayName,
    sandboxIdentityFingerprint: target.sandboxIdentityFingerprint,
    sandboxName: target.sandboxName,
  };

  it("removes stale pending authority during lifecycle-wide cleanup", () => {
    writeForwardServicePendingReceipt(pending(2_147_483_647), { stateDirectory, uid });

    expect(controller().stopAll(authority)).toBe(1);
    expect(readForwardServicePendingReceipt(target, { stateDirectory, uid })).toBeNull();
  });

  it("retains a live unidentified pending child without signaling it", () => {
    const receipt = pending(process.pid);
    writeForwardServicePendingReceipt(receipt, { stateDirectory, uid });

    expect(() => controller().stopAll(authority)).toThrow(/pending process is unknown/u);
    expect(readForwardServicePendingReceipt(target, { stateDirectory, uid })).toEqual(receipt);
  });

  it("cleans same-name authorities independently across gateways", () => {
    const siblingTarget = {
      ...target,
      gatewayName: "nemoclaw-18080",
      sandboxIdentityFingerprint: "b".repeat(64),
    };
    const siblingAuthority = {
      gatewayName: siblingTarget.gatewayName,
      sandboxIdentityFingerprint: siblingTarget.sandboxIdentityFingerprint,
      sandboxName: siblingTarget.sandboxName,
    };
    writeForwardServicePendingReceipt(pending(2_147_483_647), { stateDirectory, uid });
    writeForwardServicePendingReceipt(pending(2_147_483_646, siblingTarget), {
      stateDirectory,
      uid,
    });

    expect(controller().stopAll(authority)).toBe(1);
    expect(readForwardServicePendingReceipt(target, { stateDirectory, uid })).toBeNull();
    expect(readForwardServicePendingReceipt(siblingTarget, { stateDirectory, uid })).not.toBeNull();
    expect(controller().stopAll(siblingAuthority)).toBe(1);
    expect(readForwardServicePendingReceipt(siblingTarget, { stateDirectory, uid })).toBeNull();
  });

  it("refuses mutable-name cleanup across same-gateway sandbox generations", () => {
    const priorTarget = {
      ...target,
      sandboxIdentityFingerprint: "c".repeat(64),
    };
    const receipt = pending(2_147_483_647, priorTarget);
    writeForwardServicePendingReceipt(receipt, { stateDirectory, uid });

    expect(() => controller().stopAll(authority)).toThrow(/disagrees with sandbox authority/u);
    expect(readForwardServicePendingReceipt(priorTarget, { stateDirectory, uid })).toEqual(receipt);
  });
});
