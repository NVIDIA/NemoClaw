// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { spawnSync, SpawnSyncReturns } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  buildOpenClawPairingObservationScript,
  observeOpenClawPairingSettlement,
  observeOpenClawPairingRepairSettlement,
  observeOrdinaryOpenClawPairingSettlement,
  observeOpenClawPairingQualification,
  OpenClawPairingQualificationError,
  OpenClawPairingObservationRetryableError,
  OpenClawPairingIncompatibleError,
  parseOpenClawPairingObservation,
  parseOpenClawPairingRepairObservation,
  parseOpenClawPairingSettlementObservation,
} from "./openclaw-pairing-qualification";

const TOKEN = "credential-value-must-not-leave-the-sandbox";

describe("OpenClaw pairing observation parsing", () => {
  it("rejects extra receipt fields that could carry unrestricted state (#9023)", () => {
    const digest = "a".repeat(64);
    const output = `__NEMOCLAW_OPENCLAW_PAIRING_QUALIFICATION__=${JSON.stringify({
      deviceIdentitySha256: digest,
      pairingStateSha256: digest,
      requiredRoles: ["operator"],
      requiredScopes: ["operator.pairing", "operator.read", "operator.write"],
      token: TOKEN,
    })}\n`;

    expect(parseOpenClawPairingObservation(output)).toBeNull();
  });

  it("rejects non-terminal or expanded Portable settlement output (#9207)", () => {
    const digest = "a".repeat(64);
    const output = `__NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT__=${JSON.stringify({
      state: "settled",
      deviceIdentitySha256: digest,
      requestId: "secret-request",
    })}\n`;
    expect(parseOpenClawPairingSettlementObservation(output)).toBeNull();
    expect(
      parseOpenClawPairingSettlementObservation(
        `__NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT__=${JSON.stringify({
          state: "settled",
          deviceIdentitySha256: digest,
        })}\ntrailing\n`,
      ),
    ).toBeNull();
  });

  it("keeps canonical pending state outside strict Portable settlement (#9817)", () => {
    const digest = "a".repeat(64);
    const output = `__NEMOCLAW_OPENCLAW_PAIRING_SETTLEMENT__=${JSON.stringify({
      state: "pairing-pending",
      deviceIdentitySha256: digest,
    })}\n`;

    expect(parseOpenClawPairingRepairObservation(output)).toEqual({
      state: "pairing-pending",
      deviceIdentitySha256: digest,
    });
    expect(parseOpenClawPairingSettlementObservation(output)).toBeNull();
  });
  it("transports state paths without shell interpretation (#9023)", () => {
    const rawStateDirectory = "/sandbox/state'$(touch should-not-run)";
    const script = buildOpenClawPairingObservationScript(
      Buffer.from("test-policy", "utf8").toString("base64"),
      rawStateDirectory,
    );

    expect(script).not.toContain(rawStateDirectory);
    expect(script).toContain(Buffer.from(rawStateDirectory, "utf8").toString("base64"));
  });
});

describe.each([
  observeOpenClawPairingSettlement,
  observeOpenClawPairingRepairSettlement,
  observeOrdinaryOpenClawPairingSettlement,
  observeOpenClawPairingQualification,
])("pairing observation failure categories: %s", (observe) => {
  it.each([
    [
      "deadline-exceeded",
      { error: Object.assign(new Error(TOKEN), { code: "ETIMEDOUT" }), signal: "SIGTERM" },
    ],
    ["output-limit-exceeded", { error: Object.assign(new Error(TOKEN), { code: "ENOBUFS" }) }],
    ["child-error", { error: Object.assign(new Error(TOKEN), { code: TOKEN }) }],
    ["child-signal", { signal: "SIGTERM" }],
    ["child-exit-failed", { status: 1 }],
    ["child-exit-failed", { status: null }],
    ["state-changing", { status: 3 }],
    ["incompatible-state", { status: 4 }],
    ["invalid-output", { status: 0 }],
  ])("reports %s without child output or credentials", (category, overrides) => {
    const child = vi.fn<typeof spawnSync>().mockReturnValue({
      pid: 123,
      status: 0,
      signal: null,
      output: [],
      stdout: TOKEN,
      stderr: TOKEN,
      ...overrides,
    } as SpawnSyncReturns<string>);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let caught: unknown;
    try {
      observe("alpha", "gateway", "2026.9.2", "/sandbox/.openclaw", {
        getOpenshellBinary: () => "openshell",
        readApprovalPolicy: () => "test-policy",
        // This fixture returns UTF-8 output for the observer's fixed encoding.
        spawnSync: child as unknown as typeof spawnSync,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OpenClawPairingQualificationError);
    expect(caught).toMatchObject({ failureCategory: category });
    expect(caught instanceof OpenClawPairingObservationRetryableError).toBe(
      category === "state-changing",
    );
    expect(caught instanceof OpenClawPairingIncompatibleError).toBe(
      category === "incompatible-state",
    );
    expect(
      `${String(caught)}${JSON.stringify(caught)}${JSON.stringify(log.mock.calls)}`,
    ).not.toContain(TOKEN);
    expect(child).toHaveBeenCalledOnce();
    expect(child.mock.calls[0]?.[2]).toMatchObject({
      timeout: 3000,
      maxBuffer: 4096,
      stdio: ["pipe", "pipe", "ignore"],
    });
  });

  it("classifies unavailable input before spawning a child", () => {
    const child = vi.fn();
    expect(() =>
      observe("alpha", "gateway", "2026.9.2", "/sandbox/.openclaw", {
        readApprovalPolicy: () => null,
        spawnSync: child,
      }),
    ).toThrow(expect.objectContaining({ failureCategory: "input-unavailable" }));
    expect(child).not.toHaveBeenCalled();
  });

  it("redacts unexpected observer exceptions", () => {
    expect(() =>
      observe("alpha", "gateway", "2026.9.2", "/sandbox/.openclaw", {
        readApprovalPolicy: () => {
          throw new Error(TOKEN);
        },
      }),
    ).toThrow(
      expect.objectContaining({
        failureCategory: "unclassified",
        message: "OpenClaw pairing qualification is unavailable.",
      }),
    );
  });
});
