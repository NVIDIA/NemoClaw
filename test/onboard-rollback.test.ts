// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";

// Internals are reached via require() (matching credential-rotation.test.ts,
// gemini-probe-auth.test.ts, ssh-known-hosts.test.ts, wsl2-probe-timeout.test.ts):
// dist/lib/onboard uses bottom-of-file `module.exports = {...}` instead of
// per-function `export` keywords, and several tests rely on the d.ts staying
// `unknown`-shaped so their runtime guards type-narrow correctly. Switching to
// a named ESM import would break those neighbouring tests' narrowing.
type OnboardRollbackInternals = {
  buildOrphanedSandboxRollbackMessage: (
    sandboxName: string,
    err: unknown,
    deleteSucceeded: boolean,
  ) => string[];
};

function isOnboardRollbackInternals(value: object | null): value is OnboardRollbackInternals {
  return (
    value !== null &&
    typeof Reflect.get(value, "buildOrphanedSandboxRollbackMessage") === "function"
  );
}

const loadedOnboardInternals = require("../dist/lib/onboard");
const onboardInternals =
  typeof loadedOnboardInternals === "object" && loadedOnboardInternals !== null
    ? loadedOnboardInternals
    : null;
if (!isOnboardRollbackInternals(onboardInternals)) {
  throw new Error("Expected onboard rollback internals to be available");
}
const { buildOrphanedSandboxRollbackMessage } = onboardInternals;

describe("ghost-sandbox rollback message (#2174)", () => {
  it("reports successful cleanup when delete returns 0", () => {
    const lines = buildOrphanedSandboxRollbackMessage(
      "alpha",
      new Error("All dashboard ports in range 18789-18798 are occupied"),
      true,
    );
    expect(lines[0]).toBe("");
    expect(lines).toContain("  Could not allocate a dashboard port for 'alpha'.");
    expect(lines).toContain(
      "  All dashboard ports in range 18789-18798 are occupied",
    );
    expect(lines).toContain(
      "  The orphaned sandbox has been removed — you can safely retry.",
    );
    expect(lines.some((l: string) => l.includes("Manual cleanup"))).toBeFalsy();
  });

  it("falls back to manual-cleanup guidance when delete fails", () => {
    const lines = buildOrphanedSandboxRollbackMessage(
      "beta",
      new Error("range exhausted"),
      false,
    );
    expect(lines).toContain("  Could not remove the orphaned sandbox. Manual cleanup:");
    expect(lines).toContain('    openshell sandbox delete "beta"');
    expect(
      lines.some((l: string) => l.includes("orphaned sandbox has been removed")),
    ).toBeFalsy();
  });

  it("renders non-Error throwables via String coercion", () => {
    const lines = buildOrphanedSandboxRollbackMessage("gamma", "raw string failure", true);
    expect(lines).toContain("  raw string failure");
  });

  it("escapes the sandbox name into the manual-cleanup command exactly", () => {
    const lines = buildOrphanedSandboxRollbackMessage(
      "weird-name_42",
      new Error("oops"),
      false,
    );
    expect(lines).toContain('    openshell sandbox delete "weird-name_42"');
  });
});
