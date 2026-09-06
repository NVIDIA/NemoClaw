// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  "c-cluster redis:7 openshell-cluster-nemoclaw",
  "c-sandbox redis:7 openshell-default--my-assistant-d619959d-ec43-443f-9015-802ad337bc56",
  "c-sandbox-legacy redis:7 openshell-my-assistant",
  "c-gateway redis:7 nemoclaw-openshell-gateway",
  // Probe containers run with `--rm` and no `--name`, so an interrupted run
  // leaves a randomly named container that only its image identifies.
  "c-probe nemoclaw-hermes-sandbox-base-local:image-abc nostalgic_curie",
  "c-foreign-nemoclaw redis:7 nemoclaw-unrelated",
  "c-foreign-openshell redis:7 openshell-scratch",
  "c-gateway-prefix redis:7 nemoclaw-openshell-gateway-copy",
  "c-cluster-prefix redis:7 openshell-cluster-nemoclaw-copy",
  "c-sandbox-prefix redis:7 openshell-default--my-assistant-not-a-uuid",
  "c-openclaw ghcr.io/openclaw/openclaw:latest my-openclaw-test",
  "c-registry registry.example.com/nemoclaw/tool:1 registry-tool",
  "c-unrelated redis:7 cache",
].join("\n");

const IMAGES_OUTPUT = [
  "i-nemoclaw ghcr.io/nvidia/nemoclaw:test",
  "i-managed ghcr.io/nvidia/nemoclaw/openclaw-sandbox:latest",
  // The gateway builds sandbox images under this repository, so the `openshell`
  // half of the filter selects real resources and must stay covered.
  "i-openshell openshell/sandbox-from:1780294581",
  "i-openclaw ghcr.io/openclaw/openclaw:latest",
  "i-tag python:3.12-nemoclaw",
  "i-registry registry.example.com/nemoclaw/tool:1",
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
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-docker-scope-"));
  fs.mkdirSync(path.join(tmpHome, ".nemoclaw"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpHome, ".nemoclaw", "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: "my-assistant",
      sandboxes: { "my-assistant": { name: "my-assistant" } },
    }),
  );
  try {
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
          HOME: tmpHome,
          NEMOCLAW_AGENT: "",
          TMPDIR: tmpHome,
        } as NodeJS.ProcessEnv,
        existsSync: (target: string) => target.startsWith(tmpHome) && fs.existsSync(target),
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
  } finally {
    fs.rmSync(tmpHome, { force: true, recursive: true });
  }
}

describe("uninstall Docker resource scope", () => {
  it("keeps containers without ownership evidence (#10382)", () => {
    const calls = runWithDockerInventory();

    expect(calls).not.toContainEqual(["rm", "-f", "c-foreign-nemoclaw"]);
    expect(calls).not.toContainEqual(["rm", "-f", "c-foreign-openshell"]);
    expect(calls).not.toContainEqual(["rm", "-f", "c-gateway-prefix"]);
    expect(calls).not.toContainEqual(["rm", "-f", "c-cluster-prefix"]);
    expect(calls).not.toContainEqual(["rm", "-f", "c-sandbox-prefix"]);
    expect(calls).not.toContainEqual(["rm", "-f", "c-openclaw"]);
    expect(calls).not.toContainEqual(["rm", "-f", "c-registry"]);
    expect(calls).not.toContainEqual(["rm", "-f", "c-unrelated"]);
  });

  it("keeps images belonging to the separate OpenClaw project (#8496)", () => {
    const calls = runWithDockerInventory();

    expect(calls).not.toContainEqual(["rmi", "-f", "i-openclaw"]);
    expect(calls).not.toContainEqual(["rmi", "-f", "i-tag"]);
    expect(calls).not.toContainEqual(["rmi", "-f", "i-registry"]);
    expect(calls).not.toContainEqual(["rmi", "-f", "i-unrelated"]);
  });

  it("removes exact gateway containers and registry-owned sandbox containers", () => {
    const calls = runWithDockerInventory();

    expect(calls).toContainEqual(["rm", "-f", "c-cluster"]);
    expect(calls).toContainEqual(["rm", "-f", "c-sandbox"]);
    expect(calls).toContainEqual(["rm", "-f", "c-sandbox-legacy"]);
    expect(calls).toContainEqual(["rm", "-f", "c-gateway"]);
  });

  it("still reclaims a randomly named probe container by its NemoClaw image", () => {
    const calls = runWithDockerInventory();

    expect(calls).toContainEqual(["rm", "-f", "c-probe"]);
  });

  it("still removes NemoClaw images published under a registry path", () => {
    const calls = runWithDockerInventory();

    expect(calls).toContainEqual(["rmi", "-f", "i-nemoclaw"]);
    expect(calls).toContainEqual(["rmi", "-f", "i-managed"]);
  });

  it("still removes gateway-built OpenShell sandbox images", () => {
    const calls = runWithDockerInventory();

    expect(calls).toContainEqual(["rmi", "-f", "i-openshell"]);
  });
});
