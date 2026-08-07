// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { vi } from "vitest";
import type { ContainerEngine } from "../../../src/lib/adapters/container-engine";
import {
  capturePodmanSocketAuthority,
  createPodmanContainerEngine,
} from "../../../src/lib/adapters/podman";
import type {
  RuntimeProviderBundle,
  RuntimeProviderLifecycleInput,
  RuntimeProviderLifecycleSurface,
} from "../../../src/lib/onboard/runtime-provider/contract";
import { createPodmanRuntimeProviderBundle } from "../../../src/lib/onboard/runtime-provider/podman";
import type { SandboxEntry } from "../../../src/lib/state/registry/types";
import { expect, test } from "../fixtures/e2e-test.ts";

const AGENTS = [
  { agent: "openclaw", sandboxName: "podman-openclaw" },
  { agent: "hermes", sandboxName: "podman-hermes" },
  { agent: "langchain-deepagents-code", sandboxName: "podman-dcode" },
] as const;
const SOCKET_PATH = process.env.E2E_PODMAN_SOCKET ?? "";
const E2E_PHASES = [
  "pin the exact rootless Podman endpoint",
  "qualify the Podman 5 host contract",
  "exercise all-agent exact-container start and stop",
  "verify all-agent restart identity and final at-rest state",
] as const;

type SupportedLifecycle = Extract<RuntimeProviderLifecycleSurface, { supported: true }>;

function engines(): { hostDoctor: ContainerEngine; sandboxLifecycle: ContainerEngine } {
  expect(SOCKET_PATH).toMatch(/^\/run\/user\/[0-9]+\/podman\/podman[.]sock$/u);
  const socketAuthority = capturePodmanSocketAuthority(SOCKET_PATH);
  return {
    hostDoctor: createPodmanContainerEngine({ operation: "host-doctor", socketAuthority }),
    sandboxLifecycle: createPodmanContainerEngine({
      operation: "sandbox-lifecycle",
      socketAuthority,
    }),
  };
}

function supportedLifecycle(bundle: RuntimeProviderBundle): SupportedLifecycle {
  expect(bundle.lifecycle.supported).toBe(true);
  return bundle.lifecycle as SupportedLifecycle;
}

function inspectContainer(engine: ContainerEngine, sandboxName: string) {
  const result = engine.capture(["container", "inspect", `openshell-sandbox-${sandboxName}`]);
  expect(result).toMatchObject({ status: 0, stderr: "" });
  const entries = JSON.parse(result.stdout) as Array<{
    Id: string;
    State: { Paused: boolean; Running: boolean; Status: string };
  }>;
  expect(entries).toHaveLength(1);
  expect(entries[0]?.Id).toMatch(/^[0-9a-f]{64}$/u);
  return entries[0]!;
}

test("qualifies rootless Podman and preserves all-agent exact CPU lifecycle identity", {
  meta: { e2ePhases: E2E_PHASES },
}, async ({ progress }) => {
  progress.phase("pin the exact rootless Podman endpoint");
  const runtimeEngines = engines();
  const bundle = createPodmanRuntimeProviderBundle({ engines: runtimeEngines });

  progress.phase("qualify the Podman 5 host contract");
  const doctor = bundle.preflightDoctor.inspectHost();

  expect(doctor).toMatchObject({
    group: "Host",
    label: "Podman runtime",
    status: "ok",
  });
  expect(doctor.detail).toContain("rootless server 5.");
  expect(bundle.identity.id).toBe("podman");
  expect(bundle.workload.profile.support).toBeNull();
  expect(bundle.capabilities.hostLocalInference).toBe(false);

  progress.phase("exercise all-agent exact-container start and stop");
  for (const { agent, sandboxName } of AGENTS) {
    const agentEngines = engines();
    const agentBundle = createPodmanRuntimeProviderBundle({ engines: agentEngines });
    const lifecycle = supportedLifecycle(agentBundle);
    const sandbox: SandboxEntry = { agent, name: sandboxName, openshellDriver: "podman" };
    const input: RuntimeProviderLifecycleInput = {
      environment: process.env,
      log: vi.fn(),
      sandbox,
      sandboxName,
    };
    const beforeStop = vi.fn();
    const initial = inspectContainer(agentEngines.sandboxLifecycle, sandboxName);

    expect(initial.State).toMatchObject({ Paused: false, Running: false });
    expect(["configured", "created"]).toContain(initial.State.Status);
    expect(agentBundle.preflightDoctor.preflightLifecycle("start", input)).toBeNull();
    expect(lifecycle.start(input)).toEqual({ exitCode: 0 });
    await lifecycle.verifyStarted(
      input,
      vi.fn(async () => undefined),
    );

    const running = inspectContainer(agentEngines.sandboxLifecycle, sandboxName);
    expect(running.Id).toBe(initial.Id);
    expect(running.State).toMatchObject({ Paused: false, Running: true, Status: "running" });

    expect(lifecycle.stop(input, { beforeStop })).toEqual({ exitCode: 0, state: "stopped" });
    expect(beforeStop).toHaveBeenCalledExactlyOnceWith();
    const stopped = inspectContainer(agentEngines.sandboxLifecycle, sandboxName);
    expect(stopped.Id).toBe(initial.Id);
    expect(stopped.State).toMatchObject({ Paused: false, Running: false, Status: "exited" });

    expect(lifecycle.start(input)).toEqual({ exitCode: 0 });
    const restarted = inspectContainer(agentEngines.sandboxLifecycle, sandboxName);
    expect(restarted.Id).toBe(initial.Id);
    expect(restarted.State).toMatchObject({ Paused: false, Running: true, Status: "running" });
    expect(lifecycle.stop(input, { beforeStop: vi.fn() })).toEqual({
      exitCode: 0,
      state: "stopped",
    });
    const final = inspectContainer(agentEngines.sandboxLifecycle, sandboxName);
    expect(final.Id).toBe(initial.Id);
    expect(final.State).toMatchObject({ Paused: false, Running: false, Status: "exited" });
  }
  progress.phase("verify all-agent restart identity and final at-rest state");
});
