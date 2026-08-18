// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { resolveFullE2eColdWorkloadEvidence } from "../live/full-e2e-workload-evidence";

const MANAGED_REFERENCE = `ghcr.io/nvidia/nemoclaw/openclaw@sha256:${"a".repeat(64)}`;
const SOURCE_REVISION = "b".repeat(40);

function registry(workload: Record<string, unknown>, imageTag: unknown = workload.reference) {
  return {
    sandboxes: {
      "e2e-full": {
        imageTag,
        workload,
      },
    },
  };
}

describe("full E2E cold workload evidence", () => {
  it("requires BuildKit for the registered legacy Dockerfile workload (#9362)", () => {
    const evidence = resolveFullE2eColdWorkloadEvidence({
      registry: registry({
        schemaVersion: 1,
        kind: "legacy-dockerfile",
        reference: "nemoclaw-sandbox-e2e-full:latest",
        shared: false,
      }),
      sandboxName: "e2e-full",
      usedBuildKitPrebuild: true,
    });

    expect(evidence).toEqual({
      kind: "legacy-dockerfile",
      reference: "nemoclaw-sandbox-e2e-full:latest",
    });
  });

  it("requires an exact registered digest and no build for managed onboarding (#9362)", () => {
    const evidence = resolveFullE2eColdWorkloadEvidence({
      registry: registry({
        schemaVersion: 1,
        kind: "managed-image",
        reference: MANAGED_REFERENCE,
        sourceCohort: "all-agents-2026-08-17",
        sourceRevision: SOURCE_REVISION,
        shared: true,
      }),
      sandboxName: "e2e-full",
      usedBuildKitPrebuild: false,
    });

    expect(evidence).toEqual({
      kind: "managed-image",
      reference: MANAGED_REFERENCE,
      sourceCohort: "all-agents-2026-08-17",
      sourceRevision: SOURCE_REVISION,
    });
  });

  it.each([
    {
      name: "legacy onboarding without BuildKit",
      receipt: {
        schemaVersion: 1,
        kind: "legacy-dockerfile",
        reference: "nemoclaw-sandbox-e2e-full:latest",
        shared: false,
      },
      usedBuildKitPrebuild: false,
      message: "legacy Dockerfile cold onboarding must use the local BuildKit prebuild",
    },
    {
      name: "managed onboarding with BuildKit",
      receipt: {
        schemaVersion: 1,
        kind: "managed-image",
        reference: MANAGED_REFERENCE,
        sourceCohort: "all-agents-2026-08-17",
        sourceRevision: SOURCE_REVISION,
        shared: true,
      },
      usedBuildKitPrebuild: true,
      message: "managed-image cold onboarding must not use a local BuildKit prebuild",
    },
  ])("rejects $name (#9362)", ({ message, receipt, usedBuildKitPrebuild }) => {
    expect(() =>
      resolveFullE2eColdWorkloadEvidence({
        registry: registry(receipt),
        sandboxName: "e2e-full",
        usedBuildKitPrebuild,
      }),
    ).toThrow(message);
  });

  it("rejects a managed receipt that does not match the registered image tag (#9362)", () => {
    expect(() =>
      resolveFullE2eColdWorkloadEvidence({
        registry: registry(
          {
            schemaVersion: 1,
            kind: "managed-image",
            reference: MANAGED_REFERENCE,
            sourceCohort: "all-agents-2026-08-17",
            sourceRevision: SOURCE_REVISION,
            shared: true,
          },
          `ghcr.io/nvidia/nemoclaw/openclaw@sha256:${"c".repeat(64)}`,
        ),
        sandboxName: "e2e-full",
        usedBuildKitPrebuild: false,
      }),
    ).toThrow("managed-image workload reference must match the registered sandbox image tag");
  });
});
