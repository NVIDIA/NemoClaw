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

  // source-shape-contract: security -- The bootstrap protocol and image-owned trampoline must remain dormant until a later provider slice supplies runtime packaging and exact activation
  it("keeps managed bootstrap provider-neutral, image-owned, and dormant", () => {
    const bootstrapProtocol = [
      readFileSync(join(repoRoot, "src/lib/onboard/managed-bootstrap/adapter.ts"), "utf8"),
      readFileSync(join(repoRoot, "src/lib/onboard/managed-bootstrap/envelope.ts"), "utf8"),
      readFileSync(join(repoRoot, "src/lib/onboard/managed-bootstrap/index.ts"), "utf8"),
    ];
    const activationSources = [
      readFileSync(join(repoRoot, "src/lib/onboard.ts"), "utf8"),
      readFileSync(join(repoRoot, "src/lib/onboard/docker-gpu-sandbox-create.ts"), "utf8"),
      readFileSync(join(repoRoot, "src/lib/onboard/sandbox-create-launch.ts"), "utf8"),
      readFileSync(join(repoRoot, "src/lib/onboard/sandbox-create-step.ts"), "utf8"),
      readFileSync(join(repoRoot, "src/lib/onboard/sandbox-gpu-create-flow.ts"), "utf8"),
      readFileSync(join(repoRoot, "src/lib/onboard/sandbox-gpu-create-run-attempt.ts"), "utf8"),
      readFileSync(join(repoRoot, "src/lib/onboard/runtime-provider/contract.ts"), "utf8"),
      readFileSync(join(repoRoot, "src/lib/onboard/runtime-provider/current.ts"), "utf8"),
      readFileSync(join(repoRoot, "src/lib/onboard/runtime-provider/registry.ts"), "utf8"),
    ];
    const dockerProvider = readFileSync(
      join(repoRoot, "src/lib/onboard/runtime-provider/docker.ts"),
      "utf8",
    );
    const dockerBootstrapAdapter = readFileSync(
      join(repoRoot, "src/lib/onboard/managed-bootstrap/docker.ts"),
      "utf8",
    );
    const managedDockerfiles = [
      readFileSync(join(repoRoot, "Dockerfile"), "utf8"),
      readFileSync(join(repoRoot, "agents/hermes/Dockerfile"), "utf8"),
      readFileSync(join(repoRoot, "agents/langchain-deepagents-code/Dockerfile"), "utf8"),
    ];

    expect(bootstrapProtocol.join("\n")).not.toMatch(
      /from\s+["'][^"']*(?:docker|podman)[^"']*["']/iu,
    );
    expect(bootstrapProtocol.join("\n")).not.toMatch(
      /(?:driverId|providerId)\s*(?:===|!==)\s*["'](?:docker|podman)["']/iu,
    );
    expect(activationSources.join("\n")).not.toMatch(
      /(?:from\s+["'][^"']*managed-bootstrap|require\([^)]*managed-bootstrap)/u,
    );
    expect(dockerProvider).not.toMatch(
      /(?:from\s+["'][^"']*managed-bootstrap|require\([^)]*managed-bootstrap)/u,
    );
    expect(dockerProvider.match(/bootstrap:\s*unsupported\(/gu)).toHaveLength(2);
    expect(dockerBootstrapAdapter).toContain('"rollback-authorized"');
    expect(dockerBootstrapAdapter).toContain('"shared-state-committed"');
    expect(bootstrapProtocol[2]).not.toMatch(/from\s+["'][^"']*docker/u);

    for (const dockerfile of managedDockerfiles) {
      expect(dockerfile).toContain(
        "COPY scripts/managed-bootstrap-trampoline.sh /usr/local/bin/nemoclaw-managed-bootstrap",
      );
      expect(dockerfile).toContain("/usr/local/bin/nemoclaw-managed-bootstrap");
      expect(dockerfile).not.toMatch(/(?:ENTRYPOINT|CMD)\s+\[[^\n]*nemoclaw-managed-bootstrap/iu);
      expect(dockerfile).not.toContain("managed-startup-image-runtime.cjs");
      expect(dockerfile).not.toContain("nemoclaw-managed-startup-hold");
    }
  });
});
