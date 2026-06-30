// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

const repoRoot = path.join(import.meta.dirname, "..", "..");
const require = createRequire(import.meta.url);

function packageFiles(packageRoot: string): string[] {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  ) as { files?: string[] };
  return packageJson.files ?? [];
}

describe("OpenShell policy boundary package contract", () => {
  it("keeps the CommonJS CLI and ESM plugin source boundaries in behavioral parity", async () => {
    const cliPolicy = require("../../dist/lib/policy/merge.js") as {
      withoutProviderComposedPolicies: (
        policies: Record<string, unknown>,
      ) => Record<string, unknown>;
      stripProviderComposedPolicies: (policy: string) => string;
    };
    expect(
      cliPolicy.withoutProviderComposedPolicies({ safe: {}, _provider_generated: {} }),
    ).toEqual({ safe: {} });

    const pluginBoundary = (await import(
      pathToFileURL(
        path.join(repoRoot, "nemoclaw", "dist", "shared", "openshell-policy-boundary.js"),
      ).href
    )) as {
      withoutProviderComposedPolicies: (
        policies: Record<string, unknown>,
      ) => Record<string, unknown>;
      stripProviderComposedPolicies: (policy: string) => string;
    };
    expect(
      pluginBoundary.withoutProviderComposedPolicies({ safe: {}, _provider_generated: {} }),
    ).toEqual({ safe: {} });

    const policy = YAML.stringify({
      version: 1,
      future_policy: { keep: true },
      network_policies: { safe: {}, _provider_generated: {} },
    });
    expect(YAML.parse(cliPolicy.stripProviderComposedPolicies(policy))).toEqual(
      YAML.parse(pluginBoundary.stripProviderComposedPolicies(policy)),
    );
    expect(() => cliPolicy.stripProviderComposedPolicies("version: [unterminated")).toThrow();
    expect(() => pluginBoundary.stripProviderComposedPolicies("version: [unterminated")).toThrow();

    const pluginRunner = await import(
      pathToFileURL(path.join(repoRoot, "nemoclaw", "dist", "blueprint", "runner.js")).href
    );
    expect(pluginRunner.actionApply).toBeTypeOf("function");
  });

  it("ships the ESM boundary through both package manifests", () => {
    expect(packageFiles(repoRoot)).toContain("nemoclaw/dist/");
    expect(packageFiles(path.join(repoRoot, "nemoclaw"))).toContain("dist/");

    expect(
      fs.existsSync(
        path.join(repoRoot, "nemoclaw", "src", "shared", "openshell-policy-boundary.ts"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(repoRoot, "nemoclaw", "dist", "shared", "openshell-policy-boundary.js"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(repoRoot, "nemoclaw", "dist", "shared", "openshell-policy-boundary.d.ts"),
      ),
    ).toBe(true);
  });
});
