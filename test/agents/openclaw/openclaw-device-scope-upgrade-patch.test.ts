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
  it("defers only the bounded silent CLI upgrade to the watcher", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-device-current-defer-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    writeCurrentGatewayCallFixtureDist(dist);
    try {
      const apply = runPatch(dist);
      expect(apply.status, `${apply.stdout}${apply.stderr}`).toBe(0);
      const source = fs.readFileSync(path.join(dist, "message-handler-fixture.js"), "utf8");
      const shouldAttemptInlineApproval = runFixture<(input: Record<string, unknown>) => boolean>(
        source,
        "shouldAttemptInlineApproval",
      );
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

      expect(shouldAttemptInlineApproval(exact)).toBe(false);
      expect(shouldAttemptInlineApproval({ ...exact, authMethod: "password" })).toBe(true);
      expect(shouldAttemptInlineApproval({ ...exact, reason: "not-paired" })).toBe(true);
      expect(shouldAttemptInlineApproval({ ...exact, role: "node" })).toBe(true);
      expect(
        shouldAttemptInlineApproval({
          ...exact,
          pairing: { request: { isRepair: false, silent: true } },
        }),
      ).toBe(true);
      expect(
        shouldAttemptInlineApproval({ ...exact, plan: { allowSilentLocalPairing: false } }),
      ).toBe(true);
      expect(
        shouldAttemptInlineApproval({
          ...exact,
          connectParams: { client: { id: "control-ui", mode: "ui" } },
        }),
      ).toBe(true);
      expect(
        shouldAttemptInlineApproval({
          ...exact,
          existingPairedDevice: { publicKey: "other-key", scopes: ["operator.pairing"] },
        }),
      ).toBe(true);
      expect(
        shouldAttemptInlineApproval({
          ...exact,
          existingPairedDevice: {
            publicKey: "public-key-1",
            scopes: ["operator.pairing", "operator.write"],
          },
        }),
      ).toBe(true);
      expect(shouldAttemptInlineApproval({ ...exact, scopes: ["operator.admin"] })).toBe(true);
      expect(
        shouldAttemptInlineApproval({ ...exact, scopes: ["operator.write", "operator.write"] }),
      ).toBe(true);
      expect(
        shouldAttemptInlineApproval({
          ...exact,
          trustedProxyApprovalScopes: ["operator.write"],
        }),
      ).toBe(true);
      expect(shouldAttemptInlineApproval({ ...exact, authMethod: "device-token" })).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
