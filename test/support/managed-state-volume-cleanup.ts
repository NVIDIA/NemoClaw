// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { vi } from "vitest";
import { runManagedImageOpenShellE2e } from "../../scripts/checks/run-managed-image-openshell-e2e";
import { createHermesStateVolumeDockerHarness } from "../../src/lib/onboard/__test-helpers__/hermes-state-volume";
import { managedStartupStateRoots } from "../../src/lib/onboard/managed-startup/state-roots";
import { managedImageRuntimeIdentity } from "../../src/lib/onboard/managed-image/agents";
import {
  prepareManagedStateVolumes,
  removeManagedStateVolumes,
} from "../../src/lib/onboard/managed-workload/managed-state-volumes";

type PreparationFailure =
  | "second root"
  | "verification"
  | "before preparation"
  | "foreign ownership";

export function createManagedStateVolumeCleanupFixture(failure: PreparationFailure) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "partial-state-volume-"));
  vi.stubEnv("RUNNER_TEMP", temp);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(net, "createServer").mockReturnValue({
    unref() {},
    once() {},
    listen(_port: number, _host: string, callback: () => void) {
      callback();
    },
    close(callback: () => void) {
      callback();
    },
  } as unknown as net.Server);
  const roots = managedStartupStateRoots({
    agent: "openclaw",
    sandboxName: "partial-fixture",
    agentIdentity: managedImageRuntimeIdentity("openclaw"),
  });
  const extraRoot = { ...roots[0]!, resourceIdentity: "second-fixture-volume" };
  const foreignVolume =
    failure === "foreign ownership"
      ? { name: roots[0]!.resourceIdentity, labels: { ...roots[0]!.ownershipLabels } }
      : null;
  const docker = createHermesStateVolumeDockerHarness(foreignVolume);
  let cleanupStarted = false;
  const runDocker = (args: readonly string[]) => {
    if (args.at(-1) === extraRoot.resourceIdentity) {
      return args[0] === "create"
        ? { status: 1, stderr: "injected second-root failure" }
        : { status: 1, stderr: "no such volume" };
    }
    if (failure === "verification" && args[0] === "inspect" && docker.volume && !cleanupStarted) {
      return { status: 1, stderr: "injected verification failure" };
    }
    return docker.runDocker(args);
  };
  return {
    roots: failure === "second root" ? [...roots, extraRoot] : roots,
    docker,
    prepare: (input: Parameters<typeof prepareManagedStateVolumes>[0]) =>
      prepareManagedStateVolumes(input, {
        runContainerEngine: runDocker,
        registerExitCleanup: () => () => undefined,
      }),
    remove: (input: Parameters<typeof removeManagedStateVolumes>[0]) => {
      cleanupStarted = true;
      return removeManagedStateVolumes(input, { runContainerEngine: runDocker });
    },
    startGateway: async () => {
      if (failure === "before preparation") throw new Error("injected early failure");
    },
    command: (command: string, args: string[]) => {
      const ok = { status: 0, stdout: "", stderr: "" };
      if (command === "tail") return ok;
      if (command === "openshell")
        return args[0] === "--version" ? { ...ok, stdout: "openshell 0.0.116" } : ok;
      if (command === "docker" && args[0] === "image")
        return { ...ok, stdout: `sha256:${"b".repeat(64)}` };
      if (command === "docker" && args[0] === "ps") return ok;
      if (command === "docker" && args[0] === "network")
        return args[1] === "inspect"
          ? { status: 1, stderr: `Error: No such network: ${args[2]}` }
          : ok;
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    },
    run: () =>
      runManagedImageOpenShellE2e({
        agent: "openclaw",
        image: `ghcr.io/nvidia/nemoclaw/openclaw@sha256:${"a".repeat(64)}`,
        sandbox: "partial-fixture",
      }),
    remainingState: () => fs.readdirSync(temp),
    dispose: () => fs.rmSync(temp, { recursive: true, force: true }),
  };
}
