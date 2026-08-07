// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

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

let productionPaths: string[] = [];
let bootstrapProtocolPaths: string[] = [];
let activationPaths: string[] = [];
let providerPaths: string[] = [];
let dockerfilePaths: string[] = [];
let packagingPaths: string[] = [];
const managedBootstrapLoad =
  /(?:from\s*|import\s*|import\s*\(\s*|require\s*\(\s*)["']([^"']*managed-bootstrap(?:\/[^"']*)?)["']/giu;
const allowedManagedBootstrapLoad =
  /\/managed-bootstrap\/(?:adapter|envelope|runtime-create)(?:\.[cm]?[jt]s)?$/u;
const packagedBootstrapAsset =
  /(?:nemoclaw-managed-bootstrap|managed-bootstrap-trampoline|managed-startup-image-runtime\.cjs|nemoclaw-managed-startup-hold)/u;

function disallowedManagedBootstrapLoads(source: string): string[] {
  return [...source.matchAll(managedBootstrapLoad)]
    .map((match) => match[1] ?? "")
    .filter((specifier) => !allowedManagedBootstrapLoad.test(specifier));
}

beforeAll(() => {
  productionPaths = trackedPaths(
    "src/lib/onboard.ts",
    "src/lib/onboard",
    "scripts",
    "agents",
    ".github/workflows",
    "Dockerfile",
    "Dockerfile.base",
  );
  bootstrapProtocolPaths = productionPaths.filter(
    (path) =>
      path.startsWith("src/lib/onboard/managed-bootstrap/") &&
      path.endsWith(".ts") &&
      !path.endsWith(".test.ts"),
  );
  activationPaths = productionPaths.filter(
    (path) =>
      (path === "src/lib/onboard.ts" || path.startsWith("src/lib/onboard/")) &&
      path.endsWith(".ts") &&
      !path.endsWith(".test.ts") &&
      !path.startsWith("src/lib/onboard/managed-bootstrap/"),
  );
  providerPaths = activationPaths.filter((path) =>
    path.startsWith("src/lib/onboard/runtime-provider/"),
  );
  dockerfilePaths = productionPaths.filter((path) => /(?:^|\/)Dockerfile(?:\.base)?$/u.test(path));
  packagingPaths = productionPaths.filter(
    (path) =>
      dockerfilePaths.includes(path) ||
      path.startsWith("scripts/") ||
      path.startsWith("agents/") ||
      path.startsWith(".github/workflows/"),
  );
});

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
    expect([providerContract.current, providerContract.registry].join("\n")).not.toMatch(
      /managed-bootstrap/u,
    );
    expect(disallowedManagedBootstrapLoads(providerContract.docker)).toEqual([
      "../managed-bootstrap/docker-runtime",
    ]);
    expect(providerContract.current).not.toMatch(/\b(?:podman|mxc)\b/iu);
  });

  it("inventories every managed-bootstrap protocol source", () => {
    expect(bootstrapProtocolPaths).toEqual([
      "src/lib/onboard/managed-bootstrap/adapter.ts",
      "src/lib/onboard/managed-bootstrap/docker-authority-store.ts",
      "src/lib/onboard/managed-bootstrap/docker-journal.ts",
      "src/lib/onboard/managed-bootstrap/docker-runtime.ts",
      "src/lib/onboard/managed-bootstrap/docker-shared-state.ts",
      "src/lib/onboard/managed-bootstrap/docker-spec.ts",
      "src/lib/onboard/managed-bootstrap/docker-test-fixture.ts",
      "src/lib/onboard/managed-bootstrap/docker.ts",
      "src/lib/onboard/managed-bootstrap/envelope.ts",
      "src/lib/onboard/managed-bootstrap/image-runtime.ts",
      "src/lib/onboard/managed-bootstrap/index.ts",
      "src/lib/onboard/managed-bootstrap/managed-bootstrap-test-fixture.ts",
      "src/lib/onboard/managed-bootstrap/podman-bootstrap-journal.ts",
      "src/lib/onboard/managed-bootstrap/podman-bootstrap-replacement.ts",
      "src/lib/onboard/managed-bootstrap/podman-held-workload.ts",
      "src/lib/onboard/managed-bootstrap/podman-image-transaction.ts",
      "src/lib/onboard/managed-bootstrap/podman-watcher-lease.ts",
      "src/lib/onboard/managed-bootstrap/runtime-create.ts",
    ]);
  });

  it("inventories every runtime-provider implementation", () => {
    expect(providerPaths).toEqual([
      "src/lib/onboard/runtime-provider/access.ts",
      "src/lib/onboard/runtime-provider/contract.ts",
      "src/lib/onboard/runtime-provider/current.ts",
      "src/lib/onboard/runtime-provider/docker-llama-cpp-managed-lifecycle.ts",
      "src/lib/onboard/runtime-provider/docker-llama-cpp-operation.ts",
      "src/lib/onboard/runtime-provider/docker.ts",
      "src/lib/onboard/runtime-provider/host-local-create-journal.ts",
      "src/lib/onboard/runtime-provider/host-local-inference.ts",
      "src/lib/onboard/runtime-provider/mxc.ts",
      "src/lib/onboard/runtime-provider/persisted-engine-authority.ts",
      "src/lib/onboard/runtime-provider/podman-lifecycle.ts",
      "src/lib/onboard/runtime-provider/podman-preflight.ts",
      "src/lib/onboard/runtime-provider/podman.ts",
      "src/lib/onboard/runtime-provider/registry.ts",
      "src/lib/onboard/runtime-provider/snapshot.ts",
    ]);
  });

  // source-shape-contract: security -- Managed llama.cpp activation must remain behind the exact receipt-backed controller and operation-scoped Docker authority
  it("activates Docker llama.cpp only through its durable lifecycle controller (#8433)", () => {
    const docker = read("src/lib/onboard/runtime-provider/docker.ts");
    const adapter = read("src/lib/onboard/runtime-provider/docker-llama-cpp-managed-lifecycle.ts");
    const operation = read("src/lib/onboard/runtime-provider/docker-llama-cpp-operation.ts");
    const hostLocalContract = read("src/lib/onboard/runtime-provider/host-local-inference.ts");
    const podman = read("src/lib/onboard/runtime-provider/podman.ts");
    const installer = read("src/lib/inference/llama-cpp/managed-installer.ts");
    const localModelProfilePlan = read("src/lib/onboard/local-model-profile/plan.ts");
    const allTrackedPaths = trackedPaths(".");
    expect(allTrackedPaths.filter((path) => !existsSync(join(repoRoot, path)))).toEqual([]);
    const productionComposition = allTrackedPaths
      .filter(
        (path) =>
          /\.[cm]?ts$/u.test(path) &&
          !path.endsWith(".test.ts") &&
          !path.includes("/test/") &&
          !path.startsWith("test/") &&
          path !== "src/lib/onboard/runtime-provider/docker-llama-cpp-managed-lifecycle.ts",
      )
      .map(read)
      .join("\n");
    expect(docker).toContain("createDockerLlamaCppHostLocalOperation");
    expect(docker).toMatch(/hostLocalInference:\s*\{[\s\S]*services:\s*\[["']llama-cpp["']\]/u);
    expect(adapter).toContain("createDockerLlamaCppManagedLifecycle");
    expect(operation).toContain("createDockerLlamaCppManagedLifecycle");
    expect(installer).toContain("requireRuntimeProviderHostLocalInferenceOperation");
    expect(installer).not.toMatch(/(?:createDocker|docker-llama-cpp)/u);
    expect(hostLocalContract).not.toMatch(/(?:Docker|Podman|createDocker)/u);
    expect(podman).toMatch(/hostLocalInference:\s*unsupported\(/u);
    expect(podman).not.toContain("createDockerLlamaCppHostLocalOperation");
    expect(productionComposition).toContain("createDockerLlamaCppManagedLifecycle");
    expect(productionComposition).toContain("docker-llama-cpp-managed-lifecycle");
    expect(localModelProfilePlan).toContain(
      'export const LOCAL_MODEL_PROFILE_ENABLED_ENV = "NEMOCLAW_ENABLE_LOCAL_MODEL_PROFILE"',
    );
    expect(localModelProfilePlan).toContain('export type LocalModelProfileRuntime = "vllm";');
    expect(localModelProfilePlan).not.toMatch(/LocalModelProfileRuntime\s*=\s*[^;]*llama-cpp/u);
  });

  it("inventories every production Dockerfile", () => {
    expect(dockerfilePaths).toEqual([
      "Dockerfile",
      "Dockerfile.base",
      "agents/hermes/Dockerfile",
      "agents/hermes/Dockerfile.base",
      "agents/langchain-deepagents-code/Dockerfile",
      "agents/langchain-deepagents-code/Dockerfile.base",
    ]);
  });

  // source-shape-contract: security -- The central managed-bootstrap authority must stay driver-neutral so Docker, Podman, and MXC providers share one transaction contract
  it("keeps the dormant managed-bootstrap protocol driver-neutral", () => {
    const bootstrapProtocolSource = [
      read("src/lib/onboard/managed-bootstrap/adapter.ts"),
      read("src/lib/onboard/managed-bootstrap/envelope.ts"),
      read("src/lib/onboard/managed-bootstrap/index.ts"),
    ].join("\n");
    const runtimeCreateContract = read("src/lib/onboard/managed-bootstrap/runtime-create.ts");
    expect(bootstrapProtocolSource).not.toMatch(/from\s+["'][^"']*(?:docker|podman)[^"']*["']/iu);
    expect(bootstrapProtocolSource).not.toMatch(
      /(?:driverId|providerId)\s*(?:===|!==)\s*["'](?:docker|podman)["']/iu,
    );
    expect(bootstrapProtocolSource).not.toMatch(/\b(?:docker|podman|openshell|mxc)\b/iu);
    expect(runtimeCreateContract).not.toMatch(/\b(?:docker|podman|mxc)\b/iu);
    expect(runtimeCreateContract).not.toMatch(
      /(?:driverId|providerId)\s*(?:===|!==)\s*["'][^"']+["']/iu,
    );
  });

  // source-shape-contract: security -- Central onboarding consumes the provider-neutral create contract while provider bundles own driver-specific bootstrap implementations
  it("keeps central activation paths disconnected from driver bootstrap adapters", () => {
    const onboardEntry = read("src/lib/onboard.ts");
    const activationSource = activationPaths
      .filter((path) => !path.startsWith("src/lib/onboard/runtime-provider/"))
      .map(read)
      .join("\n");
    expect(disallowedManagedBootstrapLoads(onboardEntry)).toEqual([]);
    expect(disallowedManagedBootstrapLoads(activationSource)).toEqual([]);
    expect(
      disallowedManagedBootstrapLoads(
        [
          'import type { Contract } from "../managed-bootstrap/adapter";',
          'import { envelope } from "../managed-bootstrap/envelope";',
          'import type { Lifecycle } from "../../managed-bootstrap/runtime-create.mts";',
        ].join("\n"),
      ),
    ).toEqual([]);
    expect(
      disallowedManagedBootstrapLoads(
        [
          'import "../managed-bootstrap";',
          'import "../managed-bootstrap/index";',
          'import "../managed-bootstrap/docker-runtime";',
          'await import("../managed-bootstrap/podman-runtime");',
          'require("../managed-bootstrap/mxc-runtime");',
          'export { provider } from "../managed-bootstrap/future-provider";',
          'import type { Fake } from "../fake-managed-bootstrap/adapter";',
          'import type { Nested } from "../managed-bootstrap/docker/adapter";',
        ].join("\n"),
      ),
    ).toEqual([
      "../managed-bootstrap",
      "../managed-bootstrap/index",
      "../managed-bootstrap/docker-runtime",
      "../managed-bootstrap/podman-runtime",
      "../managed-bootstrap/mxc-runtime",
      "../managed-bootstrap/future-provider",
      "../fake-managed-bootstrap/adapter",
      "../managed-bootstrap/docker/adapter",
    ]);
  });

  // source-shape-contract: security -- Qualified bootstrap implementations compose only inside their provider bundle; unqualified providers remain unsupported
  it("composes Docker bootstrap locally while keeping Kubernetes unsupported", () => {
    const dockerProvider = read("src/lib/onboard/runtime-provider/docker.ts");
    // Neutral contracts may name an operation but cannot activate a provider implementation.
    const providerImplementationSource = providerPaths
      .filter(
        (path) =>
          path !== "src/lib/onboard/runtime-provider/contract.ts" &&
          path !== "src/lib/onboard/runtime-provider/docker.ts" &&
          path !== "src/lib/onboard/runtime-provider/persisted-engine-authority.ts",
      )
      .map(read)
      .join("\n");
    expect(providerImplementationSource).not.toMatch(/managed-bootstrap/iu);
    expect(disallowedManagedBootstrapLoads(dockerProvider)).toEqual([
      "../managed-bootstrap/docker-runtime",
    ]);
    expect(dockerProvider).toMatch(
      /bootstrap:\s*createDockerManagedBootstrapSurface\(providerId\)/u,
    );
    expect(dockerProvider.match(/bootstrap:\s*unsupported\(/gu)).toHaveLength(1);
    expect(dockerProvider.match(/recovery:\s*unsupported\(/gu)).toHaveLength(2);
  });

  // source-shape-contract: security -- Every managed image must package the same reviewed native boundary while provider activation remains independently gated
  it("packages the dormant managed-bootstrap native boundary for every agent image", () => {
    const entrypoint = read("scripts/managed-bootstrap-entrypoint.c");
    const trampoline = read("scripts/managed-bootstrap-trampoline.sh");
    const hold = read("scripts/managed-startup-hold.sh");
    const directE2e = read("scripts/checks/run-managed-image-direct-e2e.ts");
    const bootstrapRuntime = read("src/lib/onboard/managed-bootstrap/image-runtime.ts");
    const startupRuntime = read("src/lib/onboard/managed-startup/image-runtime.ts");
    const packagingSources = packagingPaths.map((path) => [path, read(path)] as const);
    expect(entrypoint).toMatch(/exec_process\(NEMOCLAW_MANAGED_BOOTSTRAP_BASH/u);
    expect(entrypoint).toMatch(/NEMOCLAW_MANAGED_BOOTSTRAP_FREESTANDING/u);
    expect(trampoline).toMatch(/Non-executable image-owned bootstrap body/u);
    expect(hold.startsWith("#!/bin/bash -p\n")).toBe(true);
    expect(hold).toContain('[ "$7" = "--" ]');
    expect(hold).toContain("/usr/local/bin/nemoclaw-start");
    expect(directE2e).toContain("renderManagedBootstrapHeldCommand(request, bootstrapIdentity");
    expect(directE2e).toContain("...heldWorkloadArgv.slice(1)");
    expect(directE2e).toContain(`"--interactive"`);
    expect(directE2e).toContain("cat > ${MANAGED_BOOTSTRAP_REQUEST_FILE}");
    expect(directE2e).toContain("chown 0:0 ${MANAGED_BOOTSTRAP_REQUEST_FILE}");
    expect(directE2e).not.toContain(`docker(["cp"`);
    expect(directE2e).not.toMatch(/const HOLD\s*=/u);
    expect(bootstrapRuntime.match(/require\.main === module/gu)).toHaveLength(1);
    expect(startupRuntime).not.toMatch(/require\.main === module/u);
    for (const dockerfilePath of [
      "Dockerfile",
      "agents/hermes/Dockerfile",
      "agents/langchain-deepagents-code/Dockerfile",
    ]) {
      const dockerfile = read(dockerfilePath);
      expect(dockerfile).toContain(" AS managed-bootstrap-entrypoint-builder");
      expect(dockerfile).toContain("COPY scripts/managed-bootstrap-entrypoint.c ./");
      expect(dockerfile).toContain(
        "COPY --from=managed-bootstrap-entrypoint-builder /out/usr/local/bin/nemoclaw-managed-bootstrap /usr/local/bin/nemoclaw-managed-bootstrap",
      );
      expect(dockerfile).toContain(
        "COPY --from=managed-bootstrap-entrypoint-builder /out/usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh",
      );
    }
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
      "scripts/managed-bootstrap-entrypoint.c",
      "scripts/managed-bootstrap-trampoline.sh",
      "scripts/managed-startup-hold.sh",
    ]);
  });
});
