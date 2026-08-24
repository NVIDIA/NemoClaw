// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  isPolicyAuthorityRefusalError,
  PolicyAuthorityRefusalError,
} from "../adapters/openshell/policy-authority";
import { redactShieldsDiagnostic } from "./audit";

describe("Shields policy-authority recovery", () => {
  it("keeps a policy-authority refusal typed across recovery boundaries (#9833)", () => {
    const refusal = new PolicyAuthorityRefusalError(
      "Policy authority changed during Shields recovery",
      "externally-managed",
    );

    expect(isPolicyAuthorityRefusalError(refusal)).toBe(true);
    expect(refusal).toMatchObject({
      code: "NEMOCLAW_POLICY_AUTHORITY_REFUSAL",
      observedAuthority: "externally-managed",
    });
  });

  it("redacts credentials from policy-authority relock diagnostics (#9833)", () => {
    const secret = "nvapi-abcdefghijklmnopqrstuvwxyz0123456789";

    expect(redactShieldsDiagnostic(`restrictive relock failed with ${secret}`)).not.toContain(
      secret,
    );
  });
});
