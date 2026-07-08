// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { verifyRebuildPostRestore } from "./rebuild-post-restore-phase";

const verified = {
  restoreSucceeded: true,
  mutablePermsVerified: true,
  mutableConfigHashVerified: true,
  mcpBridgeRestoreVerified: true,
  policyPresetRestoreVerified: true,
  policyReconciliationVerified: true,
  registryReconciliationVerified: true,
  shieldsRelocked: true,
  messagingHostForwardVerified: true,
  openClawDoctorVerified: true,
  recoveryShieldsUnlocked: false,
};

const requiredCases = [
  ["restoreSucceeded", "STATE_RESTORE_INCOMPLETE"],
  ["mutablePermsVerified", "MUTABLE_CONFIG_PERMISSIONS_UNVERIFIED"],
  ["mutableConfigHashVerified", "MUTABLE_CONFIG_HASH_UNVERIFIED"],
  ["mcpBridgeRestoreVerified", "MCP_BRIDGE_RESTORE_UNVERIFIED"],
  ["policyPresetRestoreVerified", "POLICY_PRESET_RESTORE_INCOMPLETE"],
  ["policyReconciliationVerified", "POLICY_RECONCILIATION_UNVERIFIED"],
  ["registryReconciliationVerified", "REGISTRY_RECONCILIATION_UNVERIFIED"],
  ["shieldsRelocked", "SHIELDS_RELOCK_UNVERIFIED"],
  ["messagingHostForwardVerified", "MESSAGING_HOST_FORWARD_UNVERIFIED"],
] as const;

describe("verifyRebuildPostRestore", () => {
  it("permits completion only when every required observation is verified", () => {
    expect(verifyRebuildPostRestore(verified)).toEqual({
      complete: true,
      required: [],
      advisory: [],
    });
  });

  it("returns a stable code for every required completion blocker", () => {
    const result = verifyRebuildPostRestore({
      restoreSucceeded: false,
      mutablePermsVerified: false,
      mutableConfigHashVerified: false,
      mcpBridgeRestoreVerified: false,
      policyPresetRestoreVerified: false,
      policyReconciliationVerified: false,
      registryReconciliationVerified: false,
      shieldsRelocked: false,
      messagingHostForwardVerified: false,
      openClawDoctorVerified: true,
      recoveryShieldsUnlocked: false,
    });

    expect(result).toEqual({
      complete: false,
      required: [
        "STATE_RESTORE_INCOMPLETE",
        "MUTABLE_CONFIG_PERMISSIONS_UNVERIFIED",
        "MUTABLE_CONFIG_HASH_UNVERIFIED",
        "MCP_BRIDGE_RESTORE_UNVERIFIED",
        "POLICY_PRESET_RESTORE_INCOMPLETE",
        "POLICY_RECONCILIATION_UNVERIFIED",
        "REGISTRY_RECONCILIATION_UNVERIFIED",
        "SHIELDS_RELOCK_UNVERIFIED",
        "MESSAGING_HOST_FORWARD_UNVERIFIED",
      ],
      advisory: [],
    });
  });

  it.each(requiredCases)("blocks completion when only %s is unverified", (field, code) => {
    expect(verifyRebuildPostRestore({ ...verified, [field]: false })).toEqual({
      complete: false,
      required: [code],
      advisory: [],
    });
  });

  it("keeps advisory findings visible without blocking completion", () => {
    expect(
      verifyRebuildPostRestore({
        ...verified,
        openClawDoctorVerified: false,
        recoveryShieldsUnlocked: true,
      }),
    ).toEqual({
      complete: true,
      required: [],
      advisory: ["OPENCLAW_DOCTOR_UNVERIFIED", "RECOVERY_SHIELDS_UNLOCKED"],
    });
  });
});
