// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  buildOpenClawPairingObservationScript,
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
