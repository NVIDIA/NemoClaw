// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  type RunResult,
  runUninstallPlan as runUninstallPlanBase,
  type UninstallRunDeps,
  type UninstallRunOptions,
} from "./run-plan";
import { MANAGED_STARTUP_RECEIPT_VOLUME_LABEL } from "../../onboard/managed-startup/docker-receipt-transfer";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

async function runUninstallPlan(options: UninstallRunOptions, deps: UninstallRunDeps) {
  return await runUninstallPlanBase(options, {
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

async function runWithDockerInventory(): Promise<string[][]> {
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

  const result = await runUninstallPlan(
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
  it("keeps containers belonging to the separate OpenClaw project (#8496)", async () => {
    const calls = await runWithDockerInventory();

    expect(calls).not.toContainEqual(["rm", "-f", "c-openclaw"]);
    expect(calls).not.toContainEqual(["rm", "-f", "c-registry"]);
    expect(calls).not.toContainEqual(["rm", "-f", "c-unrelated"]);
  });

  it("keeps images belonging to the separate OpenClaw project (#8496)", async () => {
    const calls = await runWithDockerInventory();

    expect(calls).not.toContainEqual(["rmi", "-f", "i-openclaw"]);
    expect(calls).not.toContainEqual(["rmi", "-f", "i-tag"]);
    expect(calls).not.toContainEqual(["rmi", "-f", "i-registry"]);
    expect(calls).not.toContainEqual(["rmi", "-f", "i-unrelated"]);
  });

  it("still removes the gateway and sandbox containers it owns by name", async () => {
    const calls = await runWithDockerInventory();

    expect(calls).toContainEqual(["rm", "-f", "c-cluster"]);
    expect(calls).toContainEqual(["rm", "-f", "c-sandbox"]);
  });

  it("still reclaims a randomly named probe container by its NemoClaw image", async () => {
    const calls = await runWithDockerInventory();

    expect(calls).toContainEqual(["rm", "-f", "c-probe"]);
  });

  it("still removes NemoClaw images published under a registry path", async () => {
    const calls = await runWithDockerInventory();

    expect(calls).toContainEqual(["rmi", "-f", "i-nemoclaw"]);
    expect(calls).toContainEqual(["rmi", "-f", "i-managed"]);
  });

  it("still removes gateway-built OpenShell sandbox images", async () => {
    const calls = await runWithDockerInventory();

    expect(calls).toContainEqual(["rmi", "-f", "i-openshell"]);
  });

  it.each([
    ["removes", 0, 0],
    ["fails closed on", 1, 1],
  ] as const)(
    "%s labelled receipt volumes and preserves unlabelled matches during force-fresh cleanup",
    async (_scenario, removalStatus, expectedExitCode) => {
      const owned = `nemoclaw-managed-startup-receipt-volume-${"a".repeat(32)}`;
      const unlabelled = `nemoclaw-managed-startup-receipt-volume-${"b".repeat(32)}`;
      const calls: string[][] = [];
      const volumeLabels = new Map<string, string | null>([
        [owned, "1"],
        [unlabelled, null],
      ]);
      const routes: Record<string, () => RunResult> = {
        info: () => ok(),
        "ps -a --format {{.ID}} {{.Image}} {{.Names}}": () => ok(),
        "images --format {{.ID}} {{.Repository}}:{{.Tag}}": () => ok(),
        [`volume ls --filter label=${MANAGED_STARTUP_RECEIPT_VOLUME_LABEL}=1 --format {{.Name}}`]:
          () =>
            ok(
              [...volumeLabels]
                .filter(([, label]) => label === "1")
                .map(([name]) => name)
                .join("\n"),
            ),
        [`volume inspect --format {{json .Labels}} ${owned}`]: () =>
          ok(JSON.stringify({ [MANAGED_STARTUP_RECEIPT_VOLUME_LABEL]: "1" })),
        [`volume rm -f ${owned}`]: () => {
          const successfulRemoval: Partial<Record<number, () => boolean>> = {
            0: () => volumeLabels.delete(owned),
          };
          successfulRemoval[removalStatus]?.();
          return { status: removalStatus, stdout: removalStatus === 0 ? owned : "", stderr: "" };
        },
        "volume inspect openshell-cluster-nemoclaw": () => ({
          status: 1,
          stdout: "",
          stderr: "Error response from daemon: get openshell-cluster-nemoclaw: no such volume",
        }),
      };
      const runDocker = vi.fn((args: string[]) => {
        calls.push(args);
        const command = args.join(" ");
        return (routes[command] ?? (() => ok()))();
      });

      const result = await runUninstallPlan(
        {
          assumeYes: true,
          deleteModels: false,
          destroyUserData: true,
          forceFreshReset: true,
          keepOpenShell: true,
        },
        {
          commandExists: () => true,
          env: { HOME: "/tmp/nemoclaw-force-fresh-receipts" } as NodeJS.ProcessEnv,
          existsSync: () => false,
          hasPortableRuntimeCleanup: () => false,
          isTty: false,
          kill: () => true,
          log: () => undefined,
          rmSync: vi.fn(),
          run: (command, args) =>
            command === "openshell" && args.join(" ") === "gateway list -o json"
              ? ok(JSON.stringify([{ name: "nemoclaw" }]))
              : ok(),
          runDocker,
        },
      );

      expect(result.exitCode).toBe(expectedExitCode);
      expect(calls).toContainEqual(["volume", "rm", "-f", owned]);
      expect(calls).not.toContainEqual(["volume", "rm", "-f", unlabelled]);
      expect(volumeLabels.has(unlabelled)).toBe(true);
    },
  );

  it.each([
    {
      containerInventory: "owned-id nemoclaw-sandbox:test openshell-owned",
      failureCommand: ["rm", "-f", "owned-id"],
      plannedVolumeInspection: {
        status: 1,
        stdout: "",
        stderr: "Error response from daemon: get openshell-cluster-nemoclaw: no such volume",
      },
      scenario: "container removal fails",
    },
    {
      containerInventory: "",
      failureCommand: ["volume", "rm", "-f", "openshell-cluster-nemoclaw"],
      plannedVolumeInspection: ok(),
      scenario: "planned-volume removal fails",
    },
    {
      containerInventory: "",
      failureCommand: ["volume", "inspect", "openshell-cluster-nemoclaw"],
      plannedVolumeInspection: { status: 1, stdout: "", stderr: "permission denied" },
      scenario: "planned-volume inspection is inconclusive",
    },
  ] as const)(
    "fails force-fresh cleanup when $scenario",
    async ({ containerInventory, failureCommand, plannedVolumeInspection }) => {
      const routes: Record<string, RunResult> = {
        info: ok(),
        "ps -a --format {{.ID}} {{.Image}} {{.Names}}": ok(containerInventory),
        "images --format {{.ID}} {{.Repository}}:{{.Tag}}": ok(),
        "rm -f owned-id": { status: 1, stdout: "", stderr: "busy" },
        "volume inspect openshell-cluster-nemoclaw": plannedVolumeInspection,
        "volume rm -f openshell-cluster-nemoclaw": {
          status: 1,
          stdout: "",
          stderr: "busy",
        },
      };
      const runDocker = vi.fn((args: string[]): RunResult => {
        return routes[args.join(" ")] ?? ok();
      });

      const result = await runUninstallPlan(
        {
          assumeYes: true,
          deleteModels: false,
          destroyUserData: true,
          forceFreshReset: true,
          keepOpenShell: true,
        },
        {
          commandExists: () => true,
          env: { HOME: "/tmp/nemoclaw-force-fresh-docker-failure" } as NodeJS.ProcessEnv,
          existsSync: () => false,
          hasPortableRuntimeCleanup: () => false,
          isTty: false,
          kill: () => true,
          log: () => undefined,
          rmSync: vi.fn(),
          run: (command, args) =>
            command === "openshell" && args.join(" ") === "gateway list -o json"
              ? ok(JSON.stringify([{ name: "nemoclaw" }]))
              : ok(),
          runDocker,
        },
      );

      expect(result.exitCode).toBe(1);
      expect(runDocker).toHaveBeenCalledWith(failureCommand, expect.any(Object));
    },
  );

  it("removes and verifies a label-owned force-fresh container with unrelated name and image", async () => {
    const ownedId = "0123456789ab";
    const routes: Record<string, RunResult> = {
      info: ok(),
      "ps -a --format {{.ID}} {{.Image}} {{.Names}}": ok(
        `${ownedId} registry.example.com/unrelated:latest arbitrary-name`,
      ),
      "ps -aq --filter label=io.nvidia.nemoclaw.managed-image.contract=1": ok(ownedId),
      "images --format {{.ID}} {{.Repository}}:{{.Tag}}": ok(),
      [`rm -f ${ownedId}`]: ok(ownedId),
      [`container inspect ${ownedId}`]: {
        status: 1,
        stdout: "",
        stderr: `Error: No such object: ${ownedId}`,
      },
      "volume inspect openshell-cluster-nemoclaw": {
        status: 1,
        stdout: "",
        stderr: "Error response from daemon: get openshell-cluster-nemoclaw: no such volume",
      },
    };
    const runDocker = vi.fn((args: string[]): RunResult => routes[args.join(" ")] ?? ok());

    const result = await runUninstallPlan(
      {
        assumeYes: true,
        deleteModels: false,
        destroyUserData: true,
        forceFreshReset: true,
        keepOpenShell: true,
      },
      {
        commandExists: () => true,
        env: { HOME: "/tmp/nemoclaw-force-fresh-labelled-container" } as NodeJS.ProcessEnv,
        existsSync: () => false,
        hasPortableRuntimeCleanup: () => false,
        isTty: false,
        kill: () => true,
        log: () => undefined,
        rmSync: vi.fn(),
        run: (command, args) =>
          command === "openshell" && args.join(" ") === "gateway list -o json"
            ? ok(JSON.stringify([{ name: "nemoclaw" }]))
            : ok(),
        runDocker,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(runDocker).toHaveBeenCalledWith(["rm", "-f", ownedId], expect.any(Object));
    expect(runDocker).toHaveBeenCalledWith(["container", "inspect", ownedId], expect.any(Object));
  });
});
