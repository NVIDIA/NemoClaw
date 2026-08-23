// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadManifestsFromDir, validateManifest } from "../registry/manifests.ts";
import { listTargets } from "../registry/registry.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const E2E_SUITE_DIR = path.join(REPO_ROOT, "test/e2e");
const MANIFEST_DIR = path.join(E2E_SUITE_DIR, "manifests");

describe("NemoClawInstance manifests", () => {
  it("loads every checked-in instance manifest through validation", () => {
    const manifests = loadManifestsFromDir(MANIFEST_DIR);

    expect(manifests).not.toHaveLength(0);
  });

  it("rejects manifest assertion and suite IDs", () => {
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

  it("rejects raw secret values", () => {
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

});
