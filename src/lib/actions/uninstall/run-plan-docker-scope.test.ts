// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  type RunResult,
  runUninstallPlan as runUninstallPlanBase,
  type UninstallRunDeps,
  type UninstallRunOptions,
} from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function runUninstallPlan(options: UninstallRunOptions, deps: UninstallRunDeps) {
  return runUninstallPlanBase(options, {
    resolveGatewayTeardownAuthority: ({ gatewayName, gatewayPort }) => ({
      gatewayName,
      gatewayPort,
      mode: "nemoclaw-managed",
      source: gatewayPort === 8080 ? "packaged-service" : "standalone",
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    }),
    ...deps,
  });
}

// A host that also runs the separate OpenClaw project. `docker ps` reports
// `{{.ID}} {{.Image}} {{.Names}}`, so the OpenClaw workload contributes both an
// unrelated container name and an unrelated image reference; `docker images`
// reports `{{.ID}} {{.Repository}}:{{.Tag}}`.
const PS_OUTPUT = [
  "c-cluster nemoclaw-cluster:native openshell-cluster-nemoclaw",
  "c-sandbox nemoclaw-sandbox-local:build-1 openshell-my-assistant",
  // Probe containers run with `--rm` and no `--name`, so an interrupted run
  // leaves a randomly named container that only its image identifies.
  "c-probe nemoclaw-hermes-sandbox-base-local:image-abc nostalgic_curie",
  "c-openclaw ghcr.io/openclaw/openclaw:latest my-openclaw-test",
  "c-unrelated redis:7 cache",
].join("\n");

const IMAGES_OUTPUT = [
  "i-nemoclaw ghcr.io/nvidia/nemoclaw:test",
  // The gateway builds sandbox images under this repository, so the `openshell`
  // half of the filter selects real resources and must stay covered.
  "i-openshell openshell/sandbox-from:1780294581",
  "i-openclaw ghcr.io/openclaw/openclaw:latest",
  "i-unrelated redis:7",
].join("\n");

function collectDockerCalls(): { calls: string[][]; runDocker: UninstallRunDeps["runDocker"] } {
  const calls: string[][] = [];
  const dockerResponses: Record<string, RunResult> = {
    ps: ok(`${PS_OUTPUT}\n`),
    images: ok(`${IMAGES_OUTPUT}\n`),
  };
  const runDocker = vi.fn((args: string[]) => {
    calls.push(args);
    return dockerResponses[args[0] ?? ""] ?? ok();
  });
  return { calls, runDocker };
}

function runWithDockerInventory(): string[][] {
  const { calls, runDocker } = collectDockerCalls();
  const run = vi.fn((command: string, args: string[]) => {
    const stubbed: Record<string, RunResult> = {
      "-c": ok("/fake/bin/tool\n"),
      "-f": ok(""),
    };
    return (
      stubbed[args[0] ?? ""] ??
      (command === "openshell" && args[0] === "gateway" && args[1] === "list"
        ? ok(JSON.stringify([{ name: "nemoclaw" }]))
        : ok())
    );
  });

  const result = runUninstallPlan(
    { assumeYes: true, deleteModels: false, keepOpenShell: true },
    {
      commandExists: () => true,
      env: {
        HOME: "/tmp/nemoclaw-uninstall-docker-scope",
        NEMOCLAW_AGENT: "",
        TMPDIR: "/tmp/nemoclaw-uninstall-docker-scope",
      } as NodeJS.ProcessEnv,
      existsSync: () => false,
      isTty: false,
      kill: () => true,
      log: () => undefined,
      rmSync: vi.fn(),
      run,
      runDocker,
    },
  );

  expect(result.exitCode).toBe(0);
  return calls;
}

describe("uninstall Docker resource scope", () => {
  it("keeps containers belonging to the separate OpenClaw project (#8496)", () => {
    const calls = runWithDockerInventory();

    expect(calls).not.toContainEqual(["rm", "-f", "c-openclaw"]);
    expect(calls).not.toContainEqual(["rm", "-f", "c-unrelated"]);
  });

  it("keeps images belonging to the separate OpenClaw project (#8496)", () => {
    const calls = runWithDockerInventory();

    expect(calls).not.toContainEqual(["rmi", "-f", "i-openclaw"]);
    expect(calls).not.toContainEqual(["rmi", "-f", "i-unrelated"]);
  });

  it("still removes the gateway and sandbox containers it owns by name", () => {
    const calls = runWithDockerInventory();

    expect(calls).toContainEqual(["rm", "-f", "c-cluster"]);
    expect(calls).toContainEqual(["rm", "-f", "c-sandbox"]);
  });

  it("still reclaims a randomly named probe container by its NemoClaw image", () => {
    const calls = runWithDockerInventory();

    expect(calls).toContainEqual(["rm", "-f", "c-probe"]);
  });

  it("still removes NemoClaw images published under a registry path", () => {
    const calls = runWithDockerInventory();

    expect(calls).toContainEqual(["rmi", "-f", "i-nemoclaw"]);
  });

  it("still removes gateway-built OpenShell sandbox images", () => {
    const calls = runWithDockerInventory();

    expect(calls).toContainEqual(["rmi", "-f", "i-openshell"]);
  });
});
