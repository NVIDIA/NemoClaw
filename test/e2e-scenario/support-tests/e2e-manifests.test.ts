// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import path from "node:path";

import { loadManifest, loadManifestsFromDir, validateManifest } from "../scenarios/manifests.ts";
import { listScenarios } from "../scenarios/registry.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SCENARIO_SUITE_DIR = path.join(REPO_ROOT, "test/e2e-scenario");
const MANIFEST_DIR = path.join(SCENARIO_SUITE_DIR, "manifests");

describe("NemoClawInstance manifests", () => {
  it("should validate all NemoClaw instance manifests", () => {
    const manifests = loadManifestsFromDir(MANIFEST_DIR);

    expect(manifests.length).toBeGreaterThanOrEqual(19);
    for (const manifest of manifests) {
      expect(() => validateManifest(manifest.document, manifest.filePath)).not.toThrow();
    }
  });

  it("should reject manifest with assertion or suite IDs", () => {
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

    expect(() => validateManifest(badManifest, "bad.yaml")).toThrow(
      /assertion|suite|product-facing/i,
    );
  });

  it("should reject raw secret values in manifest", () => {
    const badManifest = {
      apiVersion: "nemoclaw.io/v1",
      kind: "NemoClawInstance",
      metadata: { name: "bad-secret" },
      spec: {
        setup: { install: { source: "repo-current" } },
        onboarding: { agent: "openclaw", provider: "nvidia", apiKey: "nvapi-literal-secret" },
        state: { credentialRefs: ["NVIDIA_INFERENCE_API_KEY"] },
      },
    };

    expect(() => validateManifest(badManifest, "bad-secret.yaml")).toThrow(
      /raw secret|credentialRefs/i,
    );
  });

  it("should cover every typed scenario manifest need", () => {
    const manifestNames = new Set(
      loadManifestsFromDir(MANIFEST_DIR).map((manifest) => manifest.document.metadata.name),
    );
    const missingManifests = listScenarios()
      .map((scenario) => scenario.manifestPath)
      .filter((manifestPath): manifestPath is string => Boolean(manifestPath))
      .map((manifestPath) => path.basename(manifestPath, ".yaml"))
      .filter((id) => !manifestNames.has(id));

    expect(missingManifests, `missing manifest files: ${missingManifests.join(", ")}`).toEqual([]);
  });

  it("registry scenario manifest paths resolve setup and onboarding choices", () => {
    const scenario = listScenarios().find((entry) => entry.id === "ubuntu-repo-cloud-openclaw");

    expect(scenario).toBeTruthy();
    expect(scenario!.manifestPath).toBe("test/e2e-scenario/manifests/openclaw-nvidia.yaml");
    const manifest = loadManifest(path.join(REPO_ROOT, scenario!.manifestPath as string)).document;
    expect(manifest.spec.setup.install.source).toBe("repo-current");
    expect(manifest.spec.onboarding.agent).toBe("openclaw");
    expect(manifest.spec.onboarding.provider).toBe("nvidia");
  });
});
