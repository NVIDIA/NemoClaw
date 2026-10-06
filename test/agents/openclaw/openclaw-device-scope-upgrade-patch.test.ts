// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  runFixture,
  runPatch,
  writeCurrentGatewayCallFixtureDist,
} from "../../helpers/openclaw-device-self-approval-patch-harness";

describe("OpenClaw bounded current-layout scope upgrade patch", () => {
  it("keeps silent CLI admin upgrades pending for explicit approval", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-current-defer-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeCurrentGatewayCallFixtureDist(dist);
    try {
      const apply = runPatch(dist);
      expect(apply.status, `${apply.stdout}${apply.stderr}`).toBe(0);
      const source = fs.readFileSync(path.join(dist, "message-handler-fixture.js"), "utf8");
      const verifyDeviceToken = runFixture<
        (params: Record<string, unknown>) => Promise<Record<string, unknown>>
      >(source, "authDeps.verifyDeviceToken");
      const resolvePairingOutcome = runFixture<
        (input: Record<string, unknown>) => "approved" | "pending"
      >(source, "resolvePairingOutcome");
      const exact = {
        authMethod: "token",
        connectParams: { client: { id: "cli", mode: "cli" } },
        devicePublicKey: "public-key-1",
        existingPairedDevice: {
          publicKey: "public-key-1",
          scopes: ["operator.pairing"],
        },
        pairing: { request: { isRepair: true, silent: true } },
        plan: { allowSilentLocalPairing: true },
        reason: "scope-upgrade",
        role: "operator",
        scopes: ["operator.write"],
        trustedProxyApprovalScopes: null,
      };

      await expect(
        verifyDeviceToken({ role: "operator", scopes: ["operator.admin"] }),
      ).resolves.toMatchObject({ ok: true, reason: "scope-mismatch" });
      await expect(
        verifyDeviceToken({ role: "operator", scopes: ["operator.admin", "operator.unknown"] }),
      ).resolves.toMatchObject({ ok: false, reason: "scope-mismatch" });
      expect(resolvePairingOutcome(exact)).toBe("pending");
      expect(resolvePairingOutcome({ ...exact, authMethod: "password" })).toBe("approved");
      expect(resolvePairingOutcome({ ...exact, reason: "not-paired" })).toBe("approved");
      expect(resolvePairingOutcome({ ...exact, role: "node" })).toBe("approved");
      expect(
        resolvePairingOutcome({
          ...exact,
          pairing: { request: { isRepair: false, silent: true } },
        }),
      ).toBe("approved");
      expect(resolvePairingOutcome({ ...exact, plan: { allowSilentLocalPairing: false } })).toBe(
        "approved",
      );
      expect(
        resolvePairingOutcome({
          ...exact,
          connectParams: { client: { id: "control-ui", mode: "ui" } },
        }),
      ).toBe("approved");
      expect(
        resolvePairingOutcome({
          ...exact,
          existingPairedDevice: { publicKey: "other-key", scopes: ["operator.pairing"] },
        }),
      ).toBe("approved");
      expect(
        resolvePairingOutcome({
          ...exact,
          existingPairedDevice: {
            publicKey: "public-key-1",
            scopes: ["operator.pairing", "operator.write"],
          },
        }),
      ).toBe("approved");
      expect(
        resolvePairingOutcome({
          ...exact,
          existingPairedDevice: {
            publicKey: "public-key-1",
            scopes: ["operator.pairing", "operator.write"],
          },
          scopes: ["operator.admin"],
        }),
      ).toBe("pending");
      expect(
        resolvePairingOutcome({
          ...exact,
          existingPairedDevice: {
            publicKey: "public-key-1",
            scopes: ["operator.pairing", "operator.write"],
          },
          scopes: ["operator.admin", "operator.unknown"],
        }),
      ).toBe("approved");
      expect(
        resolvePairingOutcome({ ...exact, scopes: ["operator.write", "operator.write"] }),
      ).toBe("approved");
      expect(
        resolvePairingOutcome({
          ...exact,
          trustedProxyApprovalScopes: ["operator.write"],
        }),
      ).toBe("approved");
      expect(resolvePairingOutcome({ ...exact, authMethod: "device-token" })).toBe("pending");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects a structurally changed admin scope admission gate", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-admin-auth-drift-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeCurrentGatewayCallFixtureDist(dist);
    try {
      expect(runPatch(dist).status).toBe(0);
      const file = path.join(dist, "message-handler-fixture.js");
      const source = fs.readFileSync(file, "utf8");
      const damaged = source.replace(
        'new Set(["operator.pairing", "operator.read", "operator.write", "operator.admin"])',
        'new Set(["operator.pairing", "operator.read", "operator.write", "operator.superadmin"])',
      );
      expect(damaged).not.toBe(source);
      fs.writeFileSync(file, damaged);

      const audit = runPatch(dist, true);
      expect(audit.status).toBe(3);
      expect(audit.stdout).toContain("structurally changed patch");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
