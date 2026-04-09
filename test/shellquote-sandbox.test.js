// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Verify shellQuote is applied to sandboxName in shell commands
import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";

describe("sandboxName shell quoting in onboard.js", () => {
  const src = fs.readFileSync(
    path.join(import.meta.dirname, "..", "bin", "lib", "onboard.js"),
    "utf-8",
  );

  it("quotes sandboxName in openshell sandbox exec command", () => {
    expect(src).toMatch(/openshell sandbox exec \$\{shellQuote\(sandboxName\)\}/);
  });

  it("quotes sandboxName in setup-dns-proxy.sh command", () => {
    expect(src).toMatch(
      /setup-dns-proxy\.sh.*\$\{shellQuote\(GATEWAY_NAME\)\}.*\$\{shellQuote\(sandboxName\)\}/,
    );
  });

  it("does not have unquoted sandboxName in runCapture or run calls", () => {
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
