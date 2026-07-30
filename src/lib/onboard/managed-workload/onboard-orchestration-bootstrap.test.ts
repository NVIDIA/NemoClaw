// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { ManagedBootstrapRuntimeProvider } from "../managed-bootstrap/runtime-provider";
import type { ManagedStartupRootApplyRequest } from "../managed-startup/root-apply";
import type { PreparedSandboxWorkloadSource } from "../workload/preparation";
import { resolveOnboardManagedBootstrapLaunch } from "./onboard-orchestration";

const DIGEST = `sha256:${"a".repeat(64)}` as const;
const REPOSITORY = "ghcr.io/nvidia/nemoclaw/hermes-sandbox" as const;
const runtimeProvider = { driverId: "docker" } as ManagedBootstrapRuntimeProvider;
const request = { agent: "hermes" } as ManagedStartupRootApplyRequest;
const managedWorkload = {
  source: {
    kind: "managed-image",
    reference: `${REPOSITORY}@${DIGEST}`,
    contract: { image: REPOSITORY, digest: DIGEST },
  },
  release: "v0.0.98",
  fallbackDiagnostic: null,
} as PreparedSandboxWorkloadSource;

describe("onboard managed bootstrap launch", () => {
  it("binds the provider launch to the exact managed image and workload argv", () => {
    expect(
      resolveOnboardManagedBootstrapLaunch({
        workload: managedWorkload,
        runtimeProvider,
        bootstrapIdentity: "b".repeat(64),
        request,
        intendedWorkloadArgv: ["env", "hermes"],
      }),
    ).toEqual({
      bootstrapIdentity: "b".repeat(64),
      runtimeProvider,
      request,
      image: { repository: REPOSITORY, manifestDigest: DIGEST },
      agentIdentity: { uid: 1000, gid: 1000, workdir: "/sandbox" },
      intendedWorkloadArgv: ["env", "hermes"],
      expectedSupervisorArgv: ["/opt/openshell/bin/openshell-sandbox"],
    });
  });

  it("rejects an incomplete managed launch but leaves explicit Dockerfile launches alone", () => {
    expect(() =>
      resolveOnboardManagedBootstrapLaunch({
        workload: managedWorkload,
        runtimeProvider: null,
        bootstrapIdentity: "b".repeat(64),
        request,
        intendedWorkloadArgv: ["env", "hermes"],
      }),
    ).toThrow("missing its identity-bound bootstrap launch contract");

    expect(
      resolveOnboardManagedBootstrapLaunch({
        workload: {
          source: {
            kind: "legacy-dockerfile",
            dockerfilePath: "/workspace/CustomDockerfile",
            reason: "custom-dockerfile",
          },
          release: null,
          fallbackDiagnostic: null,
        },
        runtimeProvider: null,
        bootstrapIdentity: null,
        request: null,
        intendedWorkloadArgv: null,
      }),
    ).toBeNull();
  });
});
