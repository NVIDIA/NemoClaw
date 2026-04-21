// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Verify sandbox names stay validated and out of raw shell command strings.
import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";

describe("sandboxName command hardening in onboard.js", () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src", "lib", "onboard.ts"),
    "utf-8",
  );

  it("re-validates sandboxName at the createSandbox boundary", () => {
    expect(src).toMatch(/const sandboxName = validateName\(/);
  });

  it("runs setup-dns-proxy.sh through the argv helper instead of bash -c interpolation", () => {
    expect(src).toMatch(/runFile\("bash",\s*\[path\.join\(SCRIPTS, "setup-dns-proxy\.sh"\),/);
  });

  it("forwards opts to openshellArgv so openshellBinary overrides are not dropped", () => {
    // Regression guard: runOpenshell and runCaptureOpenshell must pass opts
    // through to openshellArgv. Without this, callers that supply
    // { openshellBinary: customPath } silently fall back to the default binary.
    expect(src).toMatch(/function runOpenshell\(args, opts[^)]*\)\s*\{[^}]*openshellArgv\(args,\s*opts\)/s);
    expect(src).toMatch(/function runCaptureOpenshell\(args, opts[^)]*\)\s*\{[^}]*openshellArgv\(args,\s*opts\)/s);
  });

  it("does not have raw sandboxName interpolation in run or runCapture template literals", () => {
    // Match run()/runCapture() calls that span multiple lines and contain
    // template literals, so multiline invocations are not missed.
    const callPattern = /\b(run|runCapture)\s*\(\s*`([^`]*)`/g;
    const violations = [];
    let match;
    while ((match = callPattern.exec(src)) !== null) {
      const template = match[2];
      if (template.includes("${sandboxName}") && !template.includes("shellQuote(sandboxName)")) {
        const line = src.slice(0, match.index).split("\n").length;
        violations.push(`Line ${line}: ${match[0].slice(0, 120).trim()}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
