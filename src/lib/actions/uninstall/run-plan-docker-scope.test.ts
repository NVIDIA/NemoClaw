// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { NEMOCLAW_MANAGED_PROBE_LABEL } from "../../adapters/docker/exec";
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

// `docker ps` reports the explicit probe label after the ordinary inventory
// fields. Image provenance remains visible but does not grant container cleanup
// authority.
const PS_OUTPUT = [
  "c-cluster redis:7 openshell-cluster-nemoclaw false",
  "c-sandbox redis:7 openshell-default--my-assistant-d619959d-ec43-443f-9015-802ad337bc56 false",
  "c-sandbox-exact redis:7 openshell-exact-assistant false",
  "c-sandbox-legacy redis:7 openshell-legacy-assistant-runtime-id false",
  "c-gateway redis:7 nemoclaw-openshell-gateway false",
  `c-probe nemoclaw-hermes-sandbox-base-local:image-abc nostalgic_curie true`,
  "c-foreign-image nemoclaw-hermes-sandbox-base-local:image-abc foreign_workload false",
  "c-foreign-openshell-image openshell/sandbox-from:123 foreign_openshell_workload false",
  "c-foreign-nemoclaw redis:7 nemoclaw-unrelated false",
  "c-foreign-openshell redis:7 openshell-scratch false",
  "c-gateway-prefix redis:7 nemoclaw-openshell-gateway-copy false",
  "c-cluster-prefix redis:7 openshell-cluster-nemoclaw-copy false",
  "c-openclaw ghcr.io/openclaw/openclaw:latest my-openclaw-test false",
  "c-registry registry.example.com/nemoclaw/tool:1 registry-tool false",
  "c-unrelated redis:7 cache false",
].join("\n");

const IMAGES_OUTPUT = [
  "i-nemoclaw ghcr.io/nvidia/nemoclaw:test",
  "i-managed ghcr.io/nvidia/nemoclaw/openclaw-sandbox:latest",
  "i-openshell openshell/sandbox-from:1780294581",
  "i-openclaw ghcr.io/openclaw/openclaw:latest",
  "i-tag python:3.12-nemoclaw",
  "i-registry registry.example.com/nemoclaw/tool:1",
  "i-foreign-nemoclaw nemoclaw-unrelated:latest",
  "i-foreign-openshell openshell/third-party:latest",
  "i-foreign-nvidia ghcr.io/nvidia/nemoclaw-third-party:latest",
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
    const runDocker = vi.fn((args: string[]) => {
      calls.push(args);
      return args[0] === "ps" && args.join(" ").includes(NEMOCLAW_MANAGED_PROBE_LABEL)
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
      { assumeYes: true, deleteModels: false, keepOpenShell: true },
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
      "c-foreign-image",
      "c-foreign-openshell-image",
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

  it("removes exact gateway, unambiguous registered sandbox, and labeled probe containers", () => {
    const { calls } = runWithDockerInventory();

    expect(calls).toContainEqual(["rm", "-f", "c-cluster"]);
    expect(calls).toContainEqual(["rm", "-f", "c-sandbox"]);
    expect(calls).toContainEqual(["rm", "-f", "c-sandbox-exact"]);
    expect(calls).toContainEqual(["rm", "-f", "c-sandbox-legacy"]);
    expect(calls).toContainEqual(["rm", "-f", "c-gateway"]);
    expect(calls).toContainEqual(["rm", "-f", "c-probe"]);
  });

  it("fails closed when registered sandbox ownership is ambiguous", () => {
    const psResult = ok(
      [
        "c-first redis:7 openshell-my-assistant-runtime-a false",
        "c-second redis:7 openshell-my-assistant-runtime-b false",
      ].join("\n"),
    );
    const { calls } = runWithDockerInventory({ psResult, sandboxes: ["my-assistant"] });

    expect(calls).not.toContainEqual(["rm", "-f", "c-first"]);
    expect(calls).not.toContainEqual(["rm", "-f", "c-second"]);
  });

  it("keeps images outside exact managed repositories (#8496)", () => {
    const { calls } = runWithDockerInventory();

    const forbiddenImageIds = new Set([
      "i-openclaw",
      "i-tag",
      "i-registry",
      "i-foreign-nemoclaw",
      "i-foreign-openshell",
      "i-foreign-nvidia",
      "i-unrelated",
    ]);
    const removedForbiddenImageIds = calls
      .filter((args) => args[0] === "rmi")
      .map((args) => args[2])
      .filter((id) => id !== undefined && forbiddenImageIds.has(id));
    expect(removedForbiddenImageIds).toEqual([]);
  });

  it("removes images from exact NemoClaw and gateway-built repositories", () => {
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
