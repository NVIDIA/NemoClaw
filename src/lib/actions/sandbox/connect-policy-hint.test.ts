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

  // Defense in depth: sandbox names are RFC-1123-validated upstream, but the
  // host hint still strips control characters so a name carrying ANSI escapes
  // or newlines can never spoof/rewrite the terminal at this TTY sink.
  it("strips control characters from sandbox names", () => {
    const hint = buildPolicyDenialConnectHint("qa\u001b[31m-5978\nINJECTED");
    expect(hint).not.toContain("\u001b");
    expect(hint).not.toContain("\n");
    expect(hint).toContain("nemoclaw qa[31m-5978INJECTED logs --tail 50");
  });
});
