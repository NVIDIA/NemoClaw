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
  it("routes the CommonJS CLI and ESM plugin through one canonical CJS boundary", async () => {
    const cliPolicy = require("../../dist/lib/policy/merge.js") as {
      parseOpenShellPolicy: (raw: string) => {
        yamlBody: string;
        policy: Record<string, unknown>;
      };
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
        path.join(repoRoot, "nemoclaw", "dist", "shared", "openshell-policy-boundary.cjs"),
      ).href
    )) as {
      parseOpenShellPolicy: (raw: string) => {
        yamlBody: string;
        policy: Record<string, unknown>;
      };
      withoutProviderComposedPolicies: (
        policies: Record<string, unknown>,
      ) => Record<string, unknown>;
      stripProviderComposedPolicies: (policy: string) => string;
    };
    const canonicalBoundary =
      require("../../nemoclaw/dist/shared/openshell-policy-boundary.cjs") as {
        parseOpenShellPolicy: typeof cliPolicy.parseOpenShellPolicy;
        stripProviderComposedPolicies: typeof cliPolicy.stripProviderComposedPolicies;
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

    const policyOutput = ["Version: 1", "Hash: sha256:test", "---", policy].join("\n");
    expect(cliPolicy.parseOpenShellPolicy(policyOutput)).toEqual(
      pluginBoundary.parseOpenShellPolicy(policyOutput),
    );
    expect(cliPolicy.parseOpenShellPolicy).toBe(canonicalBoundary.parseOpenShellPolicy);
    expect(cliPolicy.stripProviderComposedPolicies).toBe(
      canonicalBoundary.stripProviderComposedPolicies,
    );

    const pluginRunner = await import(
      pathToFileURL(path.join(repoRoot, "nemoclaw", "dist", "blueprint", "runner.js")).href
    );
    expect(pluginRunner.actionApply).toBeTypeOf("function");
  });

  it("preserves fail-soft CLI parsing while the canonical runner parser stays strict", () => {
    const cliPolicy = require("../../dist/lib/policy/index.js") as {
      parseCurrentPolicy: (raw: string | null | undefined) => string;
    };
    const canonical = require("../../nemoclaw/dist/shared/openshell-policy-boundary.cjs") as {
      parseOpenShellPolicy: (
        raw: string,
        options?: { allowUnmarkedPolicyBody?: boolean },
      ) => { yamlBody: string; policy: Record<string, unknown> };
    };
    const policyBody = "version: 1\nnetwork_policies:\n  safe: {}";
    const policyOutput = ["Version: 1", "Hash: sha256:test", "---", policyBody].join("\n");

    expect(cliPolicy.parseCurrentPolicy(policyOutput)).toBe(policyBody);
    expect(canonical.parseOpenShellPolicy(policyOutput)).toEqual({
      yamlBody: policyBody,
      policy: YAML.parse(policyBody),
    });

    const versionlessBody = "some_key:\n  keep: true";
    expect(cliPolicy.parseCurrentPolicy(versionlessBody)).toBe(versionlessBody);
    expect(() => canonical.parseOpenShellPolicy(versionlessBody)).toThrow(
      /does not contain a policy YAML document/,
    );
    expect(cliPolicy.parseCurrentPolicy("Version: 1\nHash: sha256:test")).toBe("");
    expect(() => canonical.parseOpenShellPolicy("Version: 1\nHash: sha256:test")).toThrow(
      /does not contain a policy YAML document/,
    );
    expect(cliPolicy.parseCurrentPolicy("version: [unterminated")).toBe("");
  });

  it("ships the generated canonical CJS boundary through both package manifests", () => {
    expect(packageFiles(repoRoot)).toContain("nemoclaw/dist/");
    expect(packageFiles(path.join(repoRoot, "nemoclaw"))).toContain("dist/");

    expect(
      fs.existsSync(
        path.join(repoRoot, "nemoclaw", "src", "shared", "openshell-policy-boundary.cts"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(repoRoot, "nemoclaw", "dist", "shared", "openshell-policy-boundary.cjs"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(repoRoot, "nemoclaw", "dist", "shared", "openshell-policy-boundary.d.cts"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(repoRoot, "nemoclaw", "dist", "shared", "openshell-policy-boundary.js"),
      ),
    ).toBe(false);
  });
});
