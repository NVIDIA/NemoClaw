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

// `docker ps` reports `{{.ID}} {{.Image}} {{.Names}}`. Container cleanup uses
// only container-specific ownership evidence — the exact gateway names or an
// unambiguous registered sandbox container — never a name prefix or an image
// reference. Image provenance stays visible but grants no container authority.
const PS_OUTPUT = [
  "c-cluster redis:7 openshell-cluster-nemoclaw",
  "c-sandbox redis:7 openshell-default--my-assistant-d619959d-ec43-443f-9015-802ad337bc56",
  "c-sandbox-exact redis:7 openshell-exact-assistant",
  "c-sandbox-legacy redis:7 openshell-legacy-assistant-runtime-id",
  "c-gateway redis:7 nemoclaw-openshell-gateway",
  // Probe containers run with `--rm` and no `--name`, so an interrupted run
  // leaves a randomly named container identified only by its image. Image
  // provenance is not container ownership, so cleanup must preserve it.
  "c-probe nemoclaw-hermes-sandbox-base-local:image-abc nostalgic_curie",
  "c-foreign-image nemoclaw-hermes-sandbox-base-local:image-abc foreign_workload",
  "c-foreign-nemoclaw redis:7 nemoclaw-unrelated",
  "c-foreign-openshell redis:7 openshell-scratch",
  "c-gateway-prefix redis:7 nemoclaw-openshell-gateway-copy",
  "c-cluster-prefix redis:7 openshell-cluster-nemoclaw-copy",
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

interface FixtureOptions {
  psResult?: RunResult;
  sandboxes?: readonly string[];
}

function runWithDockerInventory(options: FixtureOptions = {}): {
  calls: string[][];
  errors: string[];
  result: ReturnType<typeof runUninstallPlan>;
  rmSync: ReturnType<typeof vi.fn>;
} {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-docker-scope-"));
  const stateDir = path.join(tmpHome, ".nemoclaw");
  fs.mkdirSync(stateDir, { recursive: true });
  const sandboxNames = options.sandboxes ?? ["my-assistant", "exact-assistant", "legacy-assistant"];
  fs.writeFileSync(
    path.join(stateDir, "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: sandboxNames[0],
      sandboxes: Object.fromEntries(sandboxNames.map((name) => [name, { name }])),
    }),
  );
  try {
    const calls: string[][] = [];
    const isContainerInventory = (args: string[]) =>
      args[0] === "ps" && args.join(" ").includes("{{.ID}} {{.Image}} {{.Names}}");
    const runDocker = vi.fn((args: string[]) => {
      calls.push(args);
      return isContainerInventory(args)
        ? (options.psResult ?? ok(`${PS_OUTPUT}\n`))
        : args[0] === "images"
          ? ok(`${IMAGES_OUTPUT}\n`)
          : ok();
    });
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
    const errors: string[] = [];
    const rmSync = vi.fn();
    const result = runUninstallPlan(
      { assumeYes: true, deleteModels: false, destroyUserData: true, keepOpenShell: true },
      {
        commandExists: () => true,
        env: {
          HOME: tmpHome,
          NEMOCLAW_AGENT: "",
          TMPDIR: tmpHome,
        } as NodeJS.ProcessEnv,
        error: (message) => errors.push(message),
        existsSync: (target: string) => target.startsWith(tmpHome) && fs.existsSync(target),
        isTty: false,
        kill: () => true,
        log: () => undefined,
        rmSync,
        run,
        runDocker,
      },
    );
    return { calls, errors, result, rmSync };
  } finally {
    fs.rmSync(tmpHome, { force: true, recursive: true });
  }
}

describe("uninstall Docker resource scope", () => {
  it("keeps containers without container-specific ownership evidence (#10382)", () => {
    const { calls, result } = runWithDockerInventory();

    expect(result.exitCode).toBe(0);
    const forbiddenIds = new Set([
      // A randomly named probe container is identified only by its NemoClaw
      // image; image provenance is not container ownership, so it stays.
      "c-probe",
      "c-foreign-image",
      "c-foreign-nemoclaw",
      "c-foreign-openshell",
      "c-gateway-prefix",
      "c-cluster-prefix",
      "c-openclaw",
      "c-registry",
      "c-unrelated",
    ]);
    const removedForbiddenIds = calls
      .filter((args) => args[0] === "rm")
      .map((args) => args[2])
      .filter((id) => id !== undefined && forbiddenIds.has(id));
    expect(removedForbiddenIds).toEqual([]);
  });

  it("removes exact gateway and unambiguous registered sandbox containers", () => {
    const { calls } = runWithDockerInventory();

    expect(calls).toContainEqual(["rm", "-f", "c-cluster"]);
    expect(calls).toContainEqual(["rm", "-f", "c-sandbox"]);
    expect(calls).toContainEqual(["rm", "-f", "c-sandbox-exact"]);
    expect(calls).toContainEqual(["rm", "-f", "c-sandbox-legacy"]);
    expect(calls).toContainEqual(["rm", "-f", "c-gateway"]);
  });

  it("fails closed when registered sandbox ownership is ambiguous", () => {
    const psResult = ok(
      [
        "c-first redis:7 openshell-my-assistant-runtime-a",
        "c-second redis:7 openshell-my-assistant-runtime-b",
      ].join("\n"),
    );
    const { calls } = runWithDockerInventory({ psResult, sandboxes: ["my-assistant"] });

    expect(calls).not.toContainEqual(["rm", "-f", "c-first"]);
    expect(calls).not.toContainEqual(["rm", "-f", "c-second"]);
  });

  it("keeps images belonging to the separate OpenClaw project (#8496)", () => {
    const { calls } = runWithDockerInventory();

    expect(calls).not.toContainEqual(["rmi", "-f", "i-openclaw"]);
    expect(calls).not.toContainEqual(["rmi", "-f", "i-tag"]);
    expect(calls).not.toContainEqual(["rmi", "-f", "i-registry"]);
    expect(calls).not.toContainEqual(["rmi", "-f", "i-unrelated"]);
  });

  it("removes NemoClaw and gateway-built OpenShell images", () => {
    const { calls } = runWithDockerInventory();

    expect(calls).toContainEqual(["rmi", "-f", "i-nemoclaw"]);
    expect(calls).toContainEqual(["rmi", "-f", "i-managed"]);
    expect(calls).toContainEqual(["rmi", "-f", "i-openshell"]);
  });

  it("preserves retry state when Docker container inventory fails", () => {
    const { calls, errors, result, rmSync } = runWithDockerInventory({
      psResult: { status: 42, stdout: "", stderr: "daemon inventory unavailable" },
    });

    expect(result.exitCode).toBe(1);
    expect(errors).toContainEqual(
      expect.stringContaining(
        "Could not inventory Docker containers: daemon inventory unavailable",
      ),
    );
    expect(errors).toContainEqual(expect.stringContaining("preserved for retry"));
    expect(calls.some((args) => args[0] === "images")).toBe(false);
    expect(rmSync.mock.calls.some(([target]) => String(target).endsWith("/.nemoclaw"))).toBe(false);
  });
});
