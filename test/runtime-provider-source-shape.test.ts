// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..");
const byCodeUnit = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

function trackedPaths(...pathspecs: readonly string[]): string[] {
  return execFileSync("git", ["ls-files", "-z", "--", ...pathspecs], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .sort(byCodeUnit);
}

const read = (relativePath: string): string => readFileSync(join(repoRoot, relativePath), "utf8");

describe("runtime provider central source boundary", () => {
  // source-shape-contract: compatibility -- Migrated lifecycle and mutation consumers must stay provider-neutral while production selection excludes unqualified future providers and driver-specific bootstrap dependencies
  it("keeps migrated provider identities and implementations behind the one bundle composition", () => {
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
      activation: read("src/lib/onboard/runtime-provider/activation.ts"),
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
    expect(providerContract.contract).toMatch(
      /import type[\s\S]*from ["']\.\.\/managed-bootstrap\/runtime-create["']/u,
    );
    expect(
      [providerContract.current, providerContract.docker, providerContract.registry].join("\n"),
    ).not.toMatch(/managed-bootstrap/u);
    expect(providerContract.current).not.toMatch(/\b(?:podman|mxc)\b/iu);
    expect(providerContract.activation).not.toMatch(/\b(?:podman|mxc)\b/iu);
    expect(providerContract.activation).not.toMatch(
      /(?:providerId|driverName)\s*(?:===|!==)\s*["'](?:docker|podman|mxc)["']/iu,
    );
  });

  // source-shape-contract: security -- The bootstrap protocol and image-owned trampoline must remain dormant until a later provider slice supplies runtime packaging and exact activation
  it("keeps managed bootstrap provider-neutral, image-owned, and dormant", () => {
    const dockerProvider = readFileSync(
      join(repoRoot, "src/lib/onboard/runtime-provider/docker.ts"),
      "utf8",
    );
    const persistedEngineAuthority = readFileSync(
      join(repoRoot, "src/lib/onboard/runtime-provider/persisted-engine-authority.ts"),
      "utf8",
    );
    const productionPaths = trackedPaths(
      "src/lib/onboard.ts",
      "src/lib/onboard",
      "scripts",
      "agents",
      ".github/workflows",
      "Dockerfile",
      "Dockerfile.base",
    );
    const bootstrapSourcePaths = productionPaths.filter(
      (path) =>
        path.startsWith("src/lib/onboard/managed-bootstrap/") &&
        path.endsWith(".ts") &&
        !path.endsWith(".test.ts"),
    );
    const bootstrapProtocolPaths = bootstrapSourcePaths.filter((path) =>
      [
        "src/lib/onboard/managed-bootstrap/adapter.ts",
        "src/lib/onboard/managed-bootstrap/envelope.ts",
        "src/lib/onboard/managed-bootstrap/index.ts",
      ].includes(path),
    );
    const activationPaths = productionPaths.filter(
      (path) =>
        (path === "src/lib/onboard.ts" || path.startsWith("src/lib/onboard/")) &&
        path.endsWith(".ts") &&
        !path.endsWith(".test.ts") &&
        !path.startsWith("src/lib/onboard/managed-bootstrap/"),
    );
    const providerPaths = activationPaths.filter((path) =>
      path.startsWith("src/lib/onboard/runtime-provider/"),
    );
    const dockerfilePaths = productionPaths.filter((path) =>
      /(?:^|\/)Dockerfile(?:\.base)?$/u.test(path),
    );
    const packagingPaths = productionPaths.filter(
      (path) =>
        dockerfilePaths.includes(path) ||
        path.startsWith("scripts/") ||
        path.startsWith("agents/") ||
        path.startsWith(".github/workflows/"),
    );
    const bootstrapProtocol = bootstrapProtocolPaths.map(read);
    const activationSources = activationPaths.map(read);
    const providerImplementationSources = providerPaths
      .filter(
        (path) =>
          ![
            "src/lib/onboard/runtime-provider/contract.ts",
            "src/lib/onboard/runtime-provider/persisted-engine-authority.ts",
          ].includes(path),
      )
      .map(read);
    const packagingSources = packagingPaths.map((path) => [path, read(path)] as const);
    const packagedBootstrapAsset =
      /(?:nemoclaw-managed-bootstrap|managed-bootstrap-trampoline|managed-startup-image-runtime\.cjs|nemoclaw-managed-startup-hold)/u;

    expect(bootstrapSourcePaths).toEqual([
      "src/lib/onboard/managed-bootstrap/adapter.ts",
      "src/lib/onboard/managed-bootstrap/docker-journal.ts",
      "src/lib/onboard/managed-bootstrap/docker-runtime.ts",
      "src/lib/onboard/managed-bootstrap/docker-shared-state.ts",
      "src/lib/onboard/managed-bootstrap/docker-spec.ts",
      "src/lib/onboard/managed-bootstrap/docker-test-fixture.ts",
      "src/lib/onboard/managed-bootstrap/docker.ts",
      "src/lib/onboard/managed-bootstrap/envelope.ts",
      "src/lib/onboard/managed-bootstrap/index.ts",
      "src/lib/onboard/managed-bootstrap/podman-bootstrap-journal.ts",
      "src/lib/onboard/managed-bootstrap/podman-bootstrap-replacement.ts",
      "src/lib/onboard/managed-bootstrap/podman-held-workload.ts",
      "src/lib/onboard/managed-bootstrap/podman-image-transaction.ts",
      "src/lib/onboard/managed-bootstrap/podman-watcher-lease.ts",
      "src/lib/onboard/managed-bootstrap/runtime-create.ts",
    ]);
    expect(providerPaths).toEqual([
      "src/lib/onboard/runtime-provider/access.ts",
      "src/lib/onboard/runtime-provider/activation.ts",
      "src/lib/onboard/runtime-provider/contract.ts",
      "src/lib/onboard/runtime-provider/current.ts",
      "src/lib/onboard/runtime-provider/docker.ts",
      "src/lib/onboard/runtime-provider/host-local-inference.ts",
      "src/lib/onboard/runtime-provider/installer-qualification.ts",
      "src/lib/onboard/runtime-provider/persisted-engine-authority.ts",
      "src/lib/onboard/runtime-provider/persisted-engine-lifecycle.ts",
      "src/lib/onboard/runtime-provider/podman-gpu.ts",
      "src/lib/onboard/runtime-provider/podman-host-local-inference-test-harness.ts",
      "src/lib/onboard/runtime-provider/podman-host-local-inference.ts",
      "src/lib/onboard/runtime-provider/podman-inference-args.ts",
      "src/lib/onboard/runtime-provider/podman-lifecycle.ts",
      "src/lib/onboard/runtime-provider/podman-preflight.ts",
      "src/lib/onboard/runtime-provider/podman.ts",
      "src/lib/onboard/runtime-provider/registry.ts",
      "src/lib/onboard/runtime-provider/snapshot.ts",
    ]);
    expect(dockerfilePaths).toEqual([
      "Dockerfile",
      "Dockerfile.base",
      "agents/hermes/Dockerfile",
      "agents/hermes/Dockerfile.base",
      "agents/langchain-deepagents-code/Dockerfile",
      "agents/langchain-deepagents-code/Dockerfile.base",
    ]);

    expect(bootstrapProtocol.join("\n")).not.toMatch(
      /from\s+["'][^"']*(?:docker|podman)[^"']*["']/iu,
    );
    expect(bootstrapProtocol.join("\n")).not.toMatch(
      /(?:driverId|providerId)\s*(?:===|!==)\s*["'](?:docker|podman)["']/iu,
    );
    expect(bootstrapProtocol.join("\n")).not.toMatch(/\b(?:docker|podman|openshell|mxc)\b/iu);
    expect(activationSources.join("\n")).not.toMatch(
      /(?:from\s+["'][^"']*managed-bootstrap\/(?:docker|docker-journal|docker-runtime)|require\([^)]*managed-bootstrap)/u,
    );
    expect(dockerProvider).not.toMatch(
      /(?:from\s+["'][^"']*managed-bootstrap|require\([^)]*managed-bootstrap)/u,
    );
    expect(providerImplementationSources.join("\n")).not.toMatch(/managed-bootstrap/iu);
    expect(persistedEngineAuthority).not.toMatch(
      /(?:from\s+["'][^"']*managed-bootstrap|require\([^)]*managed-bootstrap)/u,
    );
    expect(dockerProvider.match(/bootstrap:\s*unsupported\(/gu)).toHaveLength(2);
    expect(
      packagingSources
        .filter(([, source]) => packagedBootstrapAsset.test(source))
        .map(([path]) => path),
    ).toEqual([
      ".github/workflows/managed-images.yaml",
      "Dockerfile",
      "agents/hermes/Dockerfile",
      "agents/langchain-deepagents-code/Dockerfile",
      "scripts/checks/run-managed-image-direct-e2e.ts",
      "scripts/managed-bootstrap-trampoline.sh",
      "scripts/managed-startup-hold.sh",
    ]);
  });
});
