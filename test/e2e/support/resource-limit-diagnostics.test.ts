// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  containsSecurityResourceLimitDiagnostic,
  resourceLimitOutputFilterScript,
} from "../fixtures/resource-limit-diagnostics.ts";

function filterResourceLimitOutput(input: string): string {
  const result = spawnSync(process.execPath, ["-e", resourceLimitOutputFilterScript()], {
    encoding: "utf8",
    input,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe("resource-limit security diagnostics", () => {
  it.each([
    "[SECURITY] Sandbox resource limits were NOT hardened for this shell.",
    "[SECURITY] Could not set soft nproc limit",
    "[SECURITY] Could not set hard nofile limit",
    "[SECURITY] Effective sandbox resource limits do not match policy",
  ])("recognizes a failed hardening warning: %s", (warning) => {
    expect(containsSecurityResourceLimitDiagnostic(warning)).toBe(true);
  });

  it("ignores unrelated security and shell output", () => {
    expect(
      containsSecurityResourceLimitDiagnostic(
        "[SECURITY] Provider credentials are unavailable.\nnproc_soft=512\nnofile_soft=65536",
      ),
    ).toBe(false);
  });

  it("retains only content-free probe fields before artifact capture", () => {
    const summary = filterResourceLimitOutput(
      [
        "connected shell token=do-not-retain",
        "prompt> __NEMOCLAW_RLIMIT_CONNECT_BEGIN__",
        "login_nproc_soft=512",
        "interactive_raise_nofile=1",
        "__NEMOCLAW_RLIMIT_CONNECT_END__",
        "request body must not be retained",
      ].join("\n"),
    );

    expect(summary).toBe(
      [
        "__NEMOCLAW_RLIMIT_CONNECT_BEGIN__",
        "login_nproc_soft=512",
        "interactive_raise_nofile=1",
        "__NEMOCLAW_RLIMIT_CONNECT_END__",
        "resource_limit_diagnostic=0",
        "",
      ].join("\n"),
    );
    expect(summary).not.toContain("do-not-retain");
    expect(summary).not.toContain("request body");
  });

  it("reports a resource-limit warning without retaining its text", () => {
    const warning = "[SECURITY] Could not set hard nofile limit token=do-not-retain";
    const summary = filterResourceLimitOutput(warning);

    expect(summary).toBe("resource_limit_diagnostic=1\n");
    expect(summary).not.toContain(warning);
    expect(summary).not.toContain("do-not-retain");
  });
});
