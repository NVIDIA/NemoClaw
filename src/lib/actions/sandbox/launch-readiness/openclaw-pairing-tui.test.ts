// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpenClawPairingFixture } from "../../../../../test/helpers/openclaw-pairing-fixture";
import { readAutoPairApprovalPolicyModule } from "../auto-pair-approval";
import {
  observeOpenClawPairingQualification,
  observeOpenClawPairingRepairSettlement,
  observeOpenClawPairingSettlement,
  observeOrdinaryOpenClawPairingSettlement,
  OpenClawPairingQualificationError,
} from "./openclaw-pairing-qualification";

// Native OpenClaw TUI grants observed on 2026.10.5, including after gateway restart.
const TUI_SCOPES = ["operator.admin", "operator.approvals", "operator.read", "operator.write"];

describe("readiness after a native OpenClaw TUI session", () => {
  let fixture: ReturnType<typeof createOpenClawPairingFixture>;
  let pairedPath: string;
  let authPath: string;
  let paired: Record<
    string,
    {
      clientId: string;
      clientMode: string;
      scopes: string[];
      approvedScopes: string[];
      tokens: { operator: { token: string; scopes: string[]; revokedAtMs?: number } };
    }
  >;
  let auth: { tokens: { operator: { token: string; scopes: string[] } } };

  function writeState() {
    fs.writeFileSync(pairedPath, JSON.stringify(paired));
    fs.writeFileSync(authPath, JSON.stringify(auth));
  }

  function observeWith<T>(
    observer: (...args: Parameters<typeof observeOpenClawPairingQualification>) => T,
  ): T {
    return observer("alpha", "nemoclaw-8080", "2026.10.5", fixture.stateDirectory, {
      getOpenshellBinary: () => "openshell",
      readApprovalPolicy: readAutoPairApprovalPolicyModule,
      spawnSync: ((_binary, _args, options) =>
        spawnSync("sh", ["-s"], options)) as typeof spawnSync,
    });
  }

  function observe() {
    return observeWith(observeOpenClawPairingQualification);
  }

  beforeEach(() => {
    fixture = createOpenClawPairingFixture();
    pairedPath = path.join(fixture.stateDirectory, "devices", "paired.json");
    authPath = path.join(fixture.stateDirectory, "identity", "device-auth.json");
    paired = JSON.parse(fs.readFileSync(pairedPath, "utf8"));
    auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const device = paired[fixture.deviceId]!;
    device.clientId = "openclaw-tui";
    device.clientMode = "ui";
    device.scopes = [...TUI_SCOPES];
    device.approvedScopes = [...TUI_SCOPES];
    device.tokens.operator.scopes = [...TUI_SCOPES];
    auth.tokens.operator.scopes = [...TUI_SCOPES];
    writeState();
  });

  afterEach(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  it("qualifies the settled TUI identity without changing its credentials or grants", () => {
    const before = [fs.readFileSync(pairedPath), fs.readFileSync(authPath)];
    const receipt = observe();
    expect(receipt).toMatchObject({ kind: "openclaw-pairing", schemaVersion: 1 });
    expect(observeWith(observeOpenClawPairingSettlement)).toMatchObject({ state: "settled" });
    expect(observeWith(observeOrdinaryOpenClawPairingSettlement)).toMatchObject({
      state: "settled",
    });
    expect(observeWith(observeOpenClawPairingRepairSettlement)).toMatchObject({ state: "settled" });
    expect([fs.readFileSync(pairedPath), fs.readFileSync(authPath)]).toEqual(before);
  });

  it("binds the TUI grant in a stable digest distinct from the same CLI identity", () => {
    const tuiReceipt = observe();
    const device = paired[fixture.deviceId]!;
    device.scopes.reverse();
    device.approvedScopes.reverse();
    device.tokens.operator.scopes.reverse();
    auth.tokens.operator.scopes.reverse();
    writeState();
    expect(observe()).toEqual(tuiReceipt);

    device.clientId = "cli";
    device.clientMode = "cli";
    device.scopes = ["operator.pairing", "operator.write"];
    device.approvedScopes = [...device.scopes];
    device.tokens.operator.scopes = ["operator.pairing", "operator.read", "operator.write"];
    auth.tokens.operator.scopes = [...device.tokens.operator.scopes];
    writeState();
    const cliReceipt = observe();
    expect(cliReceipt.deviceIdentitySha256).toBe(tuiReceipt.deviceIdentitySha256);
    expect(cliReceipt.pairingStateSha256).not.toBe(tuiReceipt.pairingStateSha256);
  });

  it.each([
    [
      "client",
      () => {
        paired[fixture.deviceId]!.clientId = "foreign-client";
      },
    ],
    [
      "mode",
      () => {
        paired[fixture.deviceId]!.clientMode = "cli";
      },
    ],
    [
      "extra-scope",
      () => {
        paired[fixture.deviceId]!.scopes.push("operator.pairing");
      },
    ],
    [
      "missing-scope",
      () => {
        auth.tokens.operator.scopes = ["operator.read"];
      },
    ],
    [
      "token",
      () => {
        auth.tokens.operator.token = "different-credential";
      },
    ],
    [
      "revoked",
      () => {
        paired[fixture.deviceId]!.tokens.operator.revokedAtMs = 1;
      },
    ],
  ] as const)("rejects an incompatible TUI %s", (_change, changeState) => {
    changeState();
    writeState();
    expect(() => observe()).toThrow(OpenClawPairingQualificationError);
  });

  it("refuses a pending TUI grant and leaves approval to its native owner", () => {
    const pendingPath = path.join(fixture.stateDirectory, "devices", "pending.json");
    const pending = JSON.stringify({
      request: {
        requestId: "request",
        deviceId: fixture.deviceId,
        publicKey: fixture.publicKey,
        clientId: "openclaw-tui",
        clientMode: "ui",
        role: "operator",
        roles: ["operator"],
        scopes: TUI_SCOPES,
        isRepair: false,
      },
    });
    fs.writeFileSync(pendingPath, pending);
    expect(() => observe()).toThrow(OpenClawPairingQualificationError);
    expect(() => observeWith(observeOrdinaryOpenClawPairingSettlement)).toThrow(
      OpenClawPairingQualificationError,
    );
    expect(fs.readFileSync(pendingPath, "utf8")).toBe(pending);
  });
});
