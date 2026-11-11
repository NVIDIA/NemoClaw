// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  observeOpenClawPairingSettlement,
  OpenClawPairingQualificationError,
} from "./openclaw-pairing-qualification";

describe("pairing observation failure diagnostics", () => {
  it.each([
    ["__NEMOCLAW_OPENCLAW_PAIRING_FAILURE__=client-auth\n", "client-auth"],
    ["__NEMOCLAW_OPENCLAW_PAIRING_FAILURE__=token=do-not-report\n", "process-failed"],
    [
      "__NEMOCLAW_OPENCLAW_PAIRING_FAILURE__=client-auth\nuntrusted trailing output",
      "process-failed",
    ],
  ])("only exposes an exact allowlisted failure classification", (stdout, expectedReason) => {
    const spawn = vi.fn(() => ({ status: 1, signal: null, stdout, stderr: "secret stderr" }));
    let failure: unknown;
    try {
      observeOpenClawPairingSettlement("alpha", "nemoclaw-8080", "2026.9.5", "/sandbox/.openclaw", {
        getOpenshellBinary: () => "openshell",
        readApprovalPolicy: () => "# Policy execution is mocked in this protocol test",
        spawnSync: spawn as never,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(OpenClawPairingQualificationError);
    expect(failure).toMatchObject({ failureReason: expectedReason });
    expect(JSON.stringify(failure)).not.toContain("do-not-report");
    expect(JSON.stringify(failure)).not.toContain("secret stderr");
  });
});
