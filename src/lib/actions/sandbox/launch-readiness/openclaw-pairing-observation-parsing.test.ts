// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  buildOpenClawPairingObservationScript,
  observeOpenClawPairingQualification,
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
  it("pins observation to the named gateway and rejects non-terminal output (#9023)", () => {
    const digest = "a".repeat(64);
    const spawn = vi.fn(
      (_binary: string, _args: readonly string[], _options: Parameters<typeof spawnSync>[2]) => ({
        status: 0,
        signal: null,
        stdout: `__NEMOCLAW_OPENCLAW_PAIRING_QUALIFICATION__=${JSON.stringify({
          deviceIdentitySha256: digest,
          pairingStateSha256: digest,
          requiredRoles: ["operator"],
          requiredScopes: ["operator.pairing", "operator.read", "operator.write"],
        })}\nuntrusted trailing output\n`,
        stderr: "",
      }),
    );

    expect(() =>
      observeOpenClawPairingQualification(
        "alpha",
        "nemoclaw-8080",
        "2026.7.1",
        "/sandbox/.openclaw",
        {
          getOpenshellBinary: () => "openshell",
          readApprovalPolicy: () => "# Policy execution is mocked in this transport test",
          spawnSync: spawn as never,
        },
      ),
    ).toThrow("OpenClaw pairing qualification is unavailable");
    expect(spawn.mock.calls[0]?.[1]).toEqual([
      "sandbox",
      "exec",
      "--name",
      "alpha",
      "-g",
      "nemoclaw-8080",
      "--",
      "sh",
      "-s",
    ]);
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({
      maxBuffer: 4 * 1_024,
      stdio: ["pipe", "pipe", "ignore"],
      timeout: 3_000,
    });
  });
});
