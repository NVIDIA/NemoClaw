// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { parseGatewayInference } from "../../src/lib/inference/config.js";
import { resolveOnboardManagedBootstrapLaunch } from "../../src/lib/onboard/managed-workload/onboard-orchestration.js";
import { validateName } from "../../src/lib/runner.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
describe("OpenShell 0.0.99 executable contracts", () => {
  it("binds managed Docker activation to the v0.0.99 supervisor workdir argv (#8497)", () => {
    const authorityStore = {};
    const launch = resolveOnboardManagedBootstrapLaunch({
      runtime: {
        runtimeProvider: {
          bootstrap: {
            supported: true,
            bootstrapKind: "managed-image",
            createAuthorityStore: () => authorityStore,
          },
        },
      } as never,
      workload: {
        source: {
          kind: "managed-image",
          contract: {
            agent: "openclaw",
            image: "registry.example/nemoclaw/openclaw",
            digest: `sha256:${"1".repeat(64)}`,
          },
        },
      } as never,
      sandboxName: "alpha",
      stateRoot: "/tmp/nemoclaw-state",
      bootstrapIdentity: "bootstrap-identity",
      request: {} as never,
      intendedWorkloadArgv: ["/usr/local/bin/nemoclaw-start"],
    });

    expect(launch?.expectedSupervisorArgv).toEqual([
      "/opt/openshell/bin/openshell-sandbox",
      "--workdir",
      "/sandbox",
    ]);
    expect(launch?.authorityStore).toBe(authorityStore);
  });
  it("proves the exposed 0.0.99 compatibility contracts through behavior (#8497)", () => {
    expect(
      parseGatewayInference(
        `Inference:\n  Workspace: default\n  Provider: compatible-endpoint\n  Model: review-model\n  Version: 1\n\nSystem inference: Not configured`,
      ),
    ).toMatchObject({ provider: "compatible-endpoint", model: "review-model" });

    expect(validateName("a".repeat(19), "sandbox name")).toBe("a".repeat(19));
    expect(() => validateName("a".repeat(20), "sandbox name")).toThrow(
      "sandbox name too long (max 19 chars)",
    );
  });
});
