// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..", "..");
const require = createRequire(import.meta.url);

function packageFiles(packageRoot: string): string[] {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  ) as { files?: string[] };
  return packageJson.files ?? [];
}

describe("shared OpenShell policy boundary package contract", () => {
  it("loads through the built CommonJS CLI and ESM plugin runtime paths", async () => {
    const cliPolicy = require("../../dist/lib/policy/merge.js") as {
      withoutProviderComposedPolicies: (
        policies: Record<string, unknown>,
      ) => Record<string, unknown>;
    };
    expect(
      cliPolicy.withoutProviderComposedPolicies({ safe: {}, _provider_generated: {} }),
    ).toEqual({ safe: {} });

    const pluginRunner = await import(
      pathToFileURL(path.join(repoRoot, "nemoclaw", "dist", "blueprint", "runner.js")).href
    );
    expect(pluginRunner.actionApply).toBeTypeOf("function");
  });

  it("declares the shared runtime directory in both package manifests", () => {
    expect(packageFiles(repoRoot)).toContain("nemoclaw/shared/");
    expect(packageFiles(path.join(repoRoot, "nemoclaw"))).toContain("shared/");

    expect(
      fs.existsSync(path.join(repoRoot, "nemoclaw", "shared", "openshell-policy-boundary.cjs")),
    ).toBe(true);
    expect(
      fs.existsSync(path.join(repoRoot, "nemoclaw", "shared", "openshell-policy-boundary.d.cts")),
    ).toBe(true);
  });
});
