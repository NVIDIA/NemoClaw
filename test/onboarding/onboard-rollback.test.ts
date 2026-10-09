// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

// Internals are reached via require() (matching credential-rotation.test.ts,
// gemini-probe-auth.test.ts, ssh-known-hosts.test.ts, wsl2-probe-timeout.test.ts):
// src/lib/onboard uses bottom-of-file `module.exports = {...}` instead of
// per-function `export` keywords, and several tests rely on the d.ts staying
// `unknown`-shaped so their runtime guards type-narrow correctly. Switching to
// a named ESM import would break those neighbouring tests' narrowing.
type OnboardRollbackInternals = {
  buildOrphanedSandboxRollbackMessage: (
    sandboxName: string,
    err: unknown,
    gatewayName?: string,
  ) => string[];
};

function isOnboardRollbackInternals(value: object | null): value is OnboardRollbackInternals {
  return (
    value !== null &&
    typeof Reflect.get(value, "buildOrphanedSandboxRollbackMessage") === "function"
  );
}

const loadedOnboardInternals = require("../../src/lib/onboard");
const onboardInternals =
  typeof loadedOnboardInternals === "object" && loadedOnboardInternals !== null
    ? loadedOnboardInternals
    : null;
if (!isOnboardRollbackInternals(onboardInternals)) {
  throw new Error("Expected onboard rollback internals to be available");
}
const { buildOrphanedSandboxRollbackMessage } = onboardInternals;

describe("ghost-sandbox rollback message (#2174)", () => {
  it("reports the surviving sandbox and fail-closed recovery", () => {
    const lines = buildOrphanedSandboxRollbackMessage(
      "alpha",
      new Error("All dashboard ports in range 18789-18798 are occupied"),
      "nemoclaw-18080",
    );
    expect(lines[0]).toBe("");
    expect(lines).toContain("  Could not allocate a dashboard port for 'alpha'.");
    expect(lines).toContain("  All dashboard ports in range 18789-18798 are occupied");
    expect(lines).toContain(
      "  NemoClaw left the sandbox running because OpenShell deletion targets a mutable name.",
    );
    expect(lines).toContain(
      '  Recovery remains blocked while gateway "nemoclaw-18080" reports this sandbox present.',
    );
    expect(lines).toContain(
      "  Do not delete it by mutable name; run 'nemoclaw alpha destroy' to check for authoritative absence.",
    );
    expect(lines.join("\n")).not.toContain("openshell sandbox delete");
  });

  it("renders non-Error throwables via String coercion", () => {
    const lines = buildOrphanedSandboxRollbackMessage("gamma", "raw string failure");
    expect(lines).toContain("  raw string failure");
  });

  it("escapes the gateway and preserves the sandbox name in recovery guidance", () => {
    const lines = buildOrphanedSandboxRollbackMessage(
      'weird-name_42"',
      new Error("oops"),
      'gateway"name',
    );
    expect(lines).toContain(
      '  Recovery remains blocked while gateway "gateway\\\"name" reports this sandbox present.',
    );
    expect(lines).toContain(
      "  Do not delete it by mutable name; run 'nemoclaw weird-name_42\" destroy' to check for authoritative absence.",
    );
    expect(lines.join("\n")).not.toContain("openshell sandbox delete");
  });

  it("does not suggest deletion when the owning gateway is unknown", () => {
    const lines = buildOrphanedSandboxRollbackMessage("alpha", new Error("oops"));
    expect(lines).toContain(
      "  The owning OpenShell gateway is unknown. Do not delete a same-name sandbox.",
    );
    expect(lines.join("\n")).not.toContain("openshell sandbox delete");
  });
});
