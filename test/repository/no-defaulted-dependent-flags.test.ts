// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  findDefaultedDependentFlags,
  isScannedSourcePath,
} from "../../scripts/checks/no-defaulted-dependent-flags.mts";

describe("defaulted dependent flag guard", () => {
  it("reports a Flags.integer definition that combines default with dependsOn (#8883)", () => {
    const source = [
      "const flags = {",
      "  timeout: Flags.integer({",
      '    dependsOn: ["wait"],',
      "    default: 180,",
      "  }),",
      "};",
    ].join("\n");

    expect(findDefaultedDependentFlags(source, "src/example.ts")).toEqual([
      { filePath: "src/example.ts", line: 2, flagName: "timeout" },
    ]);
  });

  it("flags a function-valued default, which oclif also resolves on every parse", () => {
    const source = 'const f = Flags.string({ dependsOn: ["wait"], default: () => "x" });';

    expect(findDefaultedDependentFlags(source, "src/example.ts")).toMatchObject([
      { line: 1, flagName: "(unnamed flag)" },
    ]);
  });

  it("allows dependsOn without a default and a default without dependsOn", () => {
    const source = [
      'const a = Flags.integer({ dependsOn: ["wait"], min: 1 });',
      "const b = Flags.integer({ default: 180 });",
    ].join("\n");

    expect(findDefaultedDependentFlags(source, "src/example.ts")).toEqual([]);
  });

  it("ignores non-Flags calls that combine the same option names", () => {
    const source = 'options({ dependsOn: ["wait"], default: 180 });';

    expect(findDefaultedDependentFlags(source, "src/example.ts")).toEqual([]);
  });
});

describe("scanned source path selection", () => {
  it("scans source TypeScript under src and nemoclaw/src", () => {
    expect(isScannedSourcePath("src/commands/sandbox/channels/status.ts")).toBe(true);
    expect(isScannedSourcePath("nemoclaw/src/commands/example.ts")).toBe(true);
  });

  it("excludes tests, declarations, and paths outside the scan roots", () => {
    expect(isScannedSourcePath("src/commands/sandbox/channels/status.test.ts")).toBe(false);
    expect(isScannedSourcePath("src/lib/actions/sandbox/channel-status.test-helpers.ts")).toBe(
      false,
    );
    expect(isScannedSourcePath("src/lib/example.d.ts")).toBe(false);
    expect(isScannedSourcePath("scripts/checks/run.mts")).toBe(false);
  });
});
