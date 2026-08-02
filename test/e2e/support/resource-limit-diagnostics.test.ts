// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  containsSecurityResourceLimitDiagnostic,
  RESOURCE_LIMIT_CONNECT_BEGIN_MARKER,
  RESOURCE_LIMIT_CONNECT_END_MARKER,
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
        RESOURCE_LIMIT_CONNECT_BEGIN_MARKER,
        "login_nproc_soft=512",
        "interactive_raise_nofile=1",
        RESOURCE_LIMIT_CONNECT_END_MARKER,
        "request body must not be retained",
      ].join("\n"),
    );

    expect(summary).toBe(
      [
        RESOURCE_LIMIT_CONNECT_BEGIN_MARKER,
        "login_nproc_soft=512",
        "interactive_raise_nofile=1",
        RESOURCE_LIMIT_CONNECT_END_MARKER,
        "resource_limit_diagnostic=0",
        "resource_limit_protocol_error=0",
        "",
      ].join("\n"),
    );
    expect(summary).not.toContain("do-not-retain");
    expect(summary).not.toContain("request body");
  });

  it("reports a resource-limit warning without retaining its text", () => {
    const warning = "[SECURITY] Could not set hard nofile limit token=do-not-retain";
    const summary = filterResourceLimitOutput(
      [warning, RESOURCE_LIMIT_CONNECT_BEGIN_MARKER, RESOURCE_LIMIT_CONNECT_END_MARKER].join("\n"),
    );

    expect(summary).toContain("resource_limit_diagnostic=1\n");
    expect(summary).toContain("resource_limit_protocol_error=0\n");
    expect(summary).not.toContain(warning);
    expect(summary).not.toContain("do-not-retain");
  });

  it("rejects a marker embedded in connected-shell output", () => {
    const summary = filterResourceLimitOutput(
      [`prompt> ${RESOURCE_LIMIT_CONNECT_BEGIN_MARKER}`, RESOURCE_LIMIT_CONNECT_END_MARKER].join(
        "\n",
      ),
    );

    expect(summary).not.toContain(`${RESOURCE_LIMIT_CONNECT_BEGIN_MARKER}\n`);
    expect(summary).toContain("resource_limit_protocol_error=1\n");
  });

  it("rejects a probe field outside the marker frame", () => {
    const summary = filterResourceLimitOutput(
      [
        "login_nproc_soft=1",
        RESOURCE_LIMIT_CONNECT_BEGIN_MARKER,
        RESOURCE_LIMIT_CONNECT_END_MARKER,
      ].join("\n"),
    );

    expect(summary).not.toContain("login_nproc_soft=1");
    expect(summary).toContain("resource_limit_protocol_error=1\n");
  });

  it("rejects a duplicate probe field inside the marker frame", () => {
    const summary = filterResourceLimitOutput(
      [
        RESOURCE_LIMIT_CONNECT_BEGIN_MARKER,
        "login_nproc_soft=1",
        "login_nproc_soft=4096",
        RESOURCE_LIMIT_CONNECT_END_MARKER,
      ].join("\n"),
    );

    expect(summary.match(/^login_nproc_soft=/gmu)).toHaveLength(2);
    expect(summary).toContain("resource_limit_protocol_error=1\n");
  });

  it("rejects an incomplete marker frame", () => {
    const summary = filterResourceLimitOutput(RESOURCE_LIMIT_CONNECT_BEGIN_MARKER);

    expect(summary).toContain("resource_limit_protocol_error=1\n");
  });
});
