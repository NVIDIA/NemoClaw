// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import path from "node:path";

import { compileRunPlans } from "../scenarios/compiler.ts";
import { loadManifest, loadManifestsFromDir, validateManifest } from "../scenarios/manifests.ts";
import { listScenarios } from "../scenarios/registry.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SCENARIO_SUITE_DIR = path.join(REPO_ROOT, "test/e2e-scenario");
const MANIFEST_DIR = path.join(SCENARIO_SUITE_DIR, "manifests");

describe("NemoClawInstance manifests", () => {
  it("test_should_validate_all_nemoclaw_instance_manifests", () => {
    const manifests = loadManifestsFromDir(MANIFEST_DIR);

    expect(manifests.length).toBeGreaterThanOrEqual(19);
    for (const manifest of manifests) {
      expect(() => validateManifest(manifest.document, manifest.filePath)).not.toThrow();
    }
  });

  it("test_should_reject_manifest_with_assertion_or_suite_ids", () => {
    const badManifest = {
      apiVersion: "nemoclaw.io/v1",
      kind: "NemoClawInstance",
      metadata: { name: "bad" },
      spec: {
        setup: { install: { source: "repo-current" } },
        onboarding: { agent: "openclaw", provider: "nvidia" },
        assertions: ["runtime.smoke"],
        suites: ["smoke"],
      },
    };

    expect(() => validateManifest(badManifest, "bad.yaml")).toThrow(/assertion|suite|product-facing/i);
  });

  it("test_should_reject_raw_secret_values_in_manifest", () => {
    const badManifest = {
      apiVersion: "nemoclaw.io/v1",
      kind: "NemoClawInstance",
      metadata: { name: "bad-secret" },
      spec: {
        setup: { install: { source: "repo-current" } },
        onboarding: { agent: "openclaw", provider: "nvidia", apiKey: "nvapi-literal-secret" },
        state: { credentialRefs: ["NVIDIA_API_KEY"] },
      },
    };

    expect(() => validateManifest(badManifest, "bad-secret.yaml")).toThrow(/raw secret|credentialRefs/i);
  });

  it("test_should_cover_every_typed_scenario_manifest_need", () => {
    const manifestNames = new Set(loadManifestsFromDir(MANIFEST_DIR).map((manifest) => manifest.document.metadata.name));
    const missingManifests = listScenarios()
      .map((scenario) => scenario.manifestPath)
      .filter((manifestPath): manifestPath is string => Boolean(manifestPath))
      .map((manifestPath) => path.basename(manifestPath, ".yaml"))
      .filter((id) => !manifestNames.has(id));

    expect(missingManifests, `missing manifest files: ${missingManifests.join(", ")}`).toEqual([]);
  });

  it("plan_only_output_should_show_resolved_manifest_setup_and_onboarding_choices", () => {
    const [plan] = compileRunPlans(["ubuntu-repo-cloud-openclaw"]);

    expect(plan.manifestPath).toBe("test/e2e-scenario/manifests/openclaw-nvidia.yaml");
    expect(plan.manifestPath).toBeDefined();
    expect(plan.manifest).toEqual(loadManifest(path.join(REPO_ROOT, plan.manifestPath as string)).document);
    expect(plan.manifest?.spec.setup.install.source).toBe("repo-current");
    expect(plan.manifest?.spec.onboarding.agent).toBe("openclaw");
    expect(plan.manifest?.spec.onboarding.provider).toBe("nvidia");
  });
});
