// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..");

describe("runtime provider central source boundary", () => {
  // source-shape-contract: compatibility -- Central non-snapshot actions must stay provider-neutral while production selection excludes unqualified future providers and managed-bootstrap dependencies
  it("keeps provider identities and implementations behind the one bundle composition", () => {
    const centralConsumers = [
      readFileSync(join(repoRoot, "src/lib/actions/inference-set.ts"), "utf8"),
      readFileSync(join(repoRoot, "src/lib/actions/sandbox/destroy-execution.ts"), "utf8"),
      readFileSync(join(repoRoot, "src/lib/actions/sandbox/destroy.ts"), "utf8"),
      readFileSync(join(repoRoot, "src/lib/actions/sandbox/runtime/lifecycle-runtime.ts"), "utf8"),
      readFileSync(join(repoRoot, "src/lib/actions/sandbox/start.ts"), "utf8"),
      readFileSync(join(repoRoot, "src/lib/actions/sandbox/stop.ts"), "utf8"),
      readFileSync(join(repoRoot, "src/lib/onboard/compute/plan.ts"), "utf8"),
      readFileSync(join(repoRoot, "src/lib/onboard/sandbox-registration.ts"), "utf8"),
      readFileSync(join(repoRoot, "src/lib/onboard/workload/runtime.ts"), "utf8"),
    ];
    const nonSnapshotActions = centralConsumers.slice(0, 6);
    const providerContract = [
      readFileSync(join(repoRoot, "src/lib/onboard/runtime-provider/contract.ts"), "utf8"),
      readFileSync(join(repoRoot, "src/lib/onboard/runtime-provider/current.ts"), "utf8"),
      readFileSync(join(repoRoot, "src/lib/onboard/runtime-provider/docker.ts"), "utf8"),
      readFileSync(join(repoRoot, "src/lib/onboard/runtime-provider/registry.ts"), "utf8"),
    ];

    for (const source of nonSnapshotActions) {
      expect(source).not.toMatch(/\b(?:docker|podman)\b/iu);
      expect(source).not.toMatch(/(?:adapters\/docker|docker-driver-sandbox-recovery)/u);
    }
    for (const source of centralConsumers) {
      expect(source).not.toMatch(/\b(?:openshellDriver|driverName)\s*={2,3}\s*["'][^"']+["']/u);
      expect(source).not.toMatch(/switch\s*\([^)]*\b(?:openshellDriver|driverName)\b[^)]*\)/u);
    }
    expect(providerContract.join("\n")).not.toMatch(/managed-bootstrap/u);
    expect(providerContract[1]).not.toMatch(/\b(?:podman|mxc)\b/iu);
  });
});
