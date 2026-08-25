// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SandboxQuarantineFence } from "./registry/types";
import {
  readSandboxQuarantineReceipt,
  sandboxQuarantineReceiptPath,
  type SandboxQuarantineReceipt,
  writeSandboxQuarantineReceipt,
} from "./registry/quarantine-receipt";

const roots: string[] = [];

function testRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-quarantine-receipt-"));
  roots.push(root);
  return root;
}

function fence(): SandboxQuarantineFence {
  return {
    schemaVersion: 1,
    fenceId: "00000000-0000-4000-8000-000000000001",
    requestIdentity: "a".repeat(64),
    reason: "incident investigation",
    createdAt: "2026-08-25T04:00:00.000Z",
    updatedAt: "2026-08-25T04:00:01.000Z",
    phase: "quarantined",
    target: {
      sandboxName: "alpha",
      providerId: "docker",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      lifecycleGeneration: "registry-generation-1",
      liveIdentityFingerprint: "b".repeat(64),
      providerHandle: "c".repeat(64),
      providerLifecycleGeneration: "provider-generation-1",
      runtime: { kind: "docker-container", handle: "d".repeat(64) },
    },
    attempts: [],
  };
}

function receipt(): SandboxQuarantineReceipt {
  return {
    schemaVersion: 1,
    kind: "sandbox-quarantine-receipt",
    status: "quarantined",
    fence: fence(),
    completedAt: "2026-08-25T04:00:01.000Z",
    releasedAt: null,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("sandbox quarantine receipt persistence", () => {
  it("atomically round-trips a private secret-free receipt (#10140)", () => {
    const filePath = sandboxQuarantineReceiptPath("alpha", 8080, "a".repeat(64), testRoot());

    writeSandboxQuarantineReceipt(filePath, receipt());

    expect(readSandboxQuarantineReceipt(filePath)).toEqual(receipt());
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(filePath, "utf8")).not.toContain("raw-idempotency-key");
  });

  it("rejects a symlink receipt instead of following it (#10140)", () => {
    const root = testRoot();
    const target = path.join(root, "target.json");
    const filePath = path.join(root, "receipt.json");
    fs.writeFileSync(target, JSON.stringify(receipt()), { mode: 0o600 });
    fs.symlinkSync(target, filePath);

    expect(() => readSandboxQuarantineReceipt(filePath)).toThrow(/unsafe/u);
  });

  it("rejects a released receipt without a release timestamp (#10140)", () => {
    const filePath = sandboxQuarantineReceiptPath("alpha", 8080, "a".repeat(64), testRoot());

    expect(() =>
      writeSandboxQuarantineReceipt(filePath, { ...receipt(), status: "released" }),
    ).toThrow(/release timestamp/u);
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
