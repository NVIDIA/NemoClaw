// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildPolicyDenialConnectHint } from "./connect";

// Host-side companion to the in-sandbox breadcrumb (#5978): the `nemoclaw
// <name> connect` flow knows the real sandbox name, so the hint is a directly
// runnable command (unlike the in-sandbox stanza, which falls back to `<name>`
// on OpenShell builds that set OPENSHELL_SANDBOX=1).
describe("policy-denial connect hint (#5978)", () => {
  it("names the real sandbox in a runnable logs command", () => {
    const hint = buildPolicyDenialConnectHint("qa-5978");
    expect(hint).toContain("nemoclaw qa-5978 logs --tail 50");
    expect(hint).not.toContain("<name>");
  });

  it("references the policy-denial signature so a later 403 is recognisable", () => {
    expect(buildPolicyDenialConnectHint("qa-5978")).toContain(
      "CONNECT tunnel failed, response 403",
    );
  });
});
