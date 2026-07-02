// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { auditOpenShellPolicyBoundaryDependencies } from "../../scripts/checks/verify-openshell-policy-boundary-dependencies.mts";

const repoRoot = path.join(import.meta.dirname, "..", "..");
const require = createRequire(import.meta.url);

function packageFiles(packageRoot: string): string[] {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  ) as { files?: string[] };
  return packageJson.files ?? [];
}

describe("OpenShell policy boundary package contract", () => {
  it("pins the YAML parser used by both production package boundaries", () => {
    for (const packageRoot of [repoRoot, path.join(repoRoot, "nemoclaw")]) {
      const dependencyVersion = JSON.parse(
        execFileSync("npm", ["pkg", "get", "dependencies.yaml"], {
          cwd: packageRoot,
          encoding: "utf8",
        }),
      ) as string;

      expect(dependencyVersion).toBe("2.8.3");
    }
  });

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

  it("loads the source plugin runner through the tsx subprocess boundary", () => {
    const runnerPath = path.join(repoRoot, "nemoclaw", "src", "blueprint", "runner.ts");
    const output = execFileSync(
      process.execPath,
      [
        path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs"),
        "--input-type=module",
        "--eval",
        `const runner = await import(${JSON.stringify(pathToFileURL(runnerPath).href)}); process.stdout.write(typeof runner.actionApply);`,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );

    expect(output).toBe("function");
  });

  it("preserves fail-soft CLI parsing while the canonical runner parser stays strict", () => {
    const cliPolicy = require("../../dist/lib/policy/index.js") as {
      parseCurrentPolicy: (raw: string | null | undefined) => string;
    };
    const canonical = require("../../nemoclaw/dist/shared/openshell-policy-boundary.cjs") as {
      parseOpenShellPolicy: (raw: string) => {
        yamlBody: string;
        policy: Record<string, unknown>;
      };
    };
    const policyBody = "version: 1\nnetwork_policies:\n  safe: {}";
    const policyOutput = ["Version: 1", "Hash: sha256:test", "---", policyBody].join("\n");

    expect(cliPolicy.parseCurrentPolicy(policyOutput)).toBe(policyBody);
    expect(canonical.parseOpenShellPolicy(policyOutput)).toEqual({
      yamlBody: policyBody,
      policy: YAML.parse(policyBody),
    });

    const versionlessBody = "some_key:\n  keep: true";
    expect(cliPolicy.parseCurrentPolicy(versionlessBody)).toBe("");
    expect(() => canonical.parseOpenShellPolicy(versionlessBody)).toThrow(
      /does not contain a policy YAML document/,
    );
    expect(cliPolicy.parseCurrentPolicy("Version: 1\nHash: sha256:test")).toBe("");
    expect(() => canonical.parseOpenShellPolicy("Version: 1\nHash: sha256:test")).toThrow(
      /does not contain a policy YAML document/,
    );
    expect(cliPolicy.parseCurrentPolicy("version: [unterminated")).toBe("");

    const versionlessNetworkPolicies = "network_policies:\n  safe: {}";
    expect(cliPolicy.parseCurrentPolicy(versionlessNetworkPolicies)).toBe(
      versionlessNetworkPolicies,
    );
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

  it("locks the generated sandbox boundary to its reviewed direct dependency", () => {
    const boundaryPath = path.join(
      repoRoot,
      "nemoclaw",
      "dist",
      "shared",
      "openshell-policy-boundary.cjs",
    );
    expect(auditOpenShellPolicyBoundaryDependencies(fs.readFileSync(boundaryPath, "utf8"))).toEqual(
      ["yaml"],
    );

    expect(() =>
      auditOpenShellPolicyBoundaryDependencies('require("unexpected-package");'),
    ).toThrow(/non-whitelisted modules: unexpected-package/);
    expect(() =>
      auditOpenShellPolicyBoundaryDependencies('const dependency = "yaml"; require(dependency);'),
    ).toThrow(/non-literal module load/);

    const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
    expect(dockerfile).toContain("verify-openshell-policy-boundary-dependencies.mts");
    expect(dockerfile).toContain("dist/shared/openshell-policy-boundary.cjs");
  });
});
