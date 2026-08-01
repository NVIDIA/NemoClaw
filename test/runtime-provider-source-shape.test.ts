// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..");

describe("runtime provider central source boundary", () => {
  // source-shape-contract: compatibility -- Migrated lifecycle and mutation consumers must stay provider-neutral while production selection excludes unqualified future providers and managed-bootstrap dependencies
  it("keeps migrated provider identities and implementations behind the one bundle composition", () => {
    const read = (relativePath: string) => readFileSync(join(repoRoot, relativePath), "utf8");
    const driverNeutralActions = {
      "actions/inference-set.ts": read("src/lib/actions/inference-set.ts"),
      "actions/sandbox/destroy-execution.ts": read("src/lib/actions/sandbox/destroy-execution.ts"),
      "actions/sandbox/destroy.ts": read("src/lib/actions/sandbox/destroy.ts"),
      "actions/sandbox/runtime/lifecycle-runtime.ts": read(
        "src/lib/actions/sandbox/runtime/lifecycle-runtime.ts",
      ),
      "actions/sandbox/start.ts": read("src/lib/actions/sandbox/start.ts"),
      "actions/sandbox/stop.ts": read("src/lib/actions/sandbox/stop.ts"),
    };
    const onboardConsumers = {
      "onboard/compute/plan.ts": read("src/lib/onboard/compute/plan.ts"),
      "onboard/sandbox-registration.ts": read("src/lib/onboard/sandbox-registration.ts"),
      "onboard/workload/runtime.ts": read("src/lib/onboard/workload/runtime.ts"),
    };
    const providerContract = {
      contract: read("src/lib/onboard/runtime-provider/contract.ts"),
      current: read("src/lib/onboard/runtime-provider/current.ts"),
      docker: read("src/lib/onboard/runtime-provider/docker.ts"),
      registry: read("src/lib/onboard/runtime-provider/registry.ts"),
    };

    for (const [name, source] of Object.entries(driverNeutralActions)) {
      expect(source, `${name} must stay driver-neutral`).not.toMatch(/\b(?:docker|podman)\b/iu);
      expect(source, `${name} must not import driver adapters`).not.toMatch(
        /(?:adapters\/docker|docker-driver-sandbox-recovery)/u,
      );
    }
    for (const [name, source] of [
      ...Object.entries(driverNeutralActions),
      ...Object.entries(onboardConsumers),
    ]) {
      expect(source, `${name} must not branch on a driver name`).not.toMatch(
        /\b(?:openshellDriver|driverName)\s*={2,3}\s*["'][^"']+["']/u,
      );
      expect(source, `${name} must not switch on a driver name`).not.toMatch(
        /switch\s*\([^)]*\b(?:openshellDriver|driverName)\b[^)]*\)/u,
      );
    }
    expect(driverNeutralActions["actions/sandbox/start.ts"]).toMatch(
      /resolved\.lifecycle\.verifyStarted\(/u,
    );
    expect(Object.values(providerContract).join("\n")).not.toMatch(/managed-bootstrap/u);
    expect(providerContract.current).not.toMatch(/\b(?:podman|mxc)\b/iu);
  });
});
