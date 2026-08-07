// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { vi } from "vitest";
import type { ContainerEngine } from "../../../src/lib/adapters/container-engine";
import {
  capturePodmanSocketAuthority,
  createPodmanContainerEngine,
} from "../../../src/lib/adapters/podman";
import { buildDockerDriverGatewayEnv } from "../../../src/lib/onboard/docker-driver-gateway-env";
import { ensureDockerDriverGatewayLocalTlsBundle } from "../../../src/lib/onboard/docker-driver-gateway-local-tls";
import {
  installPortableDemoSandboxLifecycle,
  portableDemoLifecycleInternals,
} from "../../../src/lib/onboard/experimental/portable-demo-lifecycle";
import type {
  RuntimeProviderBundle,
  RuntimeProviderLifecycleInput,
  RuntimeProviderLifecycleSurface,
} from "../../../src/lib/onboard/runtime-provider/contract";
import { createPodmanRuntimeProviderBundle } from "../../../src/lib/onboard/runtime-provider/podman";
import type { SandboxEntry } from "../../../src/lib/state/registry/types";
import { expect, test } from "../fixtures/e2e-test.ts";
import {
  ARTIFACT_DIR,
  cleanupPodmanLifecycle,
  exactContainerId,
  executableOnPath,
  GATEWAY_NAME,
  inspectContainer,
  OPENSHELL_VERSION,
  runCommand,
  SOCKET_PATH,
  startPinnedGateway,
  waitForHealthyGateway,
} from "./podman-cpu-lifecycle-helpers.ts";

const AGENTS = [
  { agent: "openclaw", sandboxName: "podman-openclaw" },
  { agent: "hermes", sandboxName: "podman-hermes" },
  { agent: "langchain-deepagents-code", sandboxName: "podman-dcode" },
] as const;
const BASE_IMAGE =
  "docker.io/library/ubuntu@sha256:019e8eb29a85e74d64925745884f2ec79aa27e3feab36353d24656f4d6b89467";
const GATEWAY_PORT = 18_080;
const SUPERVISOR_IMAGE =
  "ghcr.io/nvidia/openshell/supervisor@sha256:ea3632b6e9528e2309103af5b6949606fcdc83ca1f69e8db81482a25bea84bb6";
const E2E_PHASES = [
  "pin the exact rootless Podman endpoint",
  "qualify the Podman 5 host contract",
  "start the pinned OpenShell Podman gateway",
  "activate registered-agent identities through the pinned OpenShell CLI",
  "exercise exact-container stop and start",
  "verify production portable ownership and final at-rest state",
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

test("activates pinned OpenShell sandboxes and preserves registered-agent Podman CPU identity", {
  meta: { e2ePhases: E2E_PHASES },
  timeout: 360_000,
}, async ({ progress }) => {
  progress.phase("pin the exact rootless Podman endpoint");
  expect(process.platform).toBe("linux");
  expect(process.getuid?.()).not.toBe(0);
  expect(ARTIFACT_DIR).not.toBe("");
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

  const openshellBin = executableOnPath("openshell");
  const gatewayBin = executableOnPath("openshell-gateway");
  const sandboxBin = executableOnPath("openshell-sandbox");
  for (const component of [openshellBin, gatewayBin, sandboxBin]) {
    expect(runCommand(component, ["--version"])).toContain(OPENSHELL_VERSION);
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-openshell-"));
  const stateDir = path.join(root, "gateway-state");
  const cliEnv: NodeJS.ProcessEnv = {
    ...process.env,
    OPENSHELL_GATEWAY: GATEWAY_NAME,
    XDG_CONFIG_HOME: path.join(root, "cli-config"),
  };
  const createdSandboxes: string[] = [];
  let gateway: ChildProcess | null = null;
  let completed = false;
  const previousPortableProfile = process.env.NEMOCLAW_EXPERIMENTAL_PROFILE;

  try {
    progress.phase("start the pinned OpenShell Podman gateway");
    process.env.NEMOCLAW_EXPERIMENTAL_PROFILE = "portable";
    const gatewayEnv = buildDockerDriverGatewayEnv({
      platform: "linux",
      gatewayPort: GATEWAY_PORT,
      stateDir,
      podmanSocketPath: SOCKET_PATH,
      getDockerSupervisorImage: () => SUPERVISOR_IMAGE,
      resolveSandboxBin: () => sandboxBin,
    });
    const tls = ensureDockerDriverGatewayLocalTlsBundle({ gatewayBin, stateDir });
    cliEnv.OPENSHELL_LOCAL_TLS_DIR = tls.localTlsDir;
    gateway = await startPinnedGateway(gatewayBin, gatewayEnv, progress);
    runCommand(
      openshellBin,
      [
        "gateway",
        "add",
        `https://127.0.0.1:${String(GATEWAY_PORT)}`,
        "--local",
        "--name",
        GATEWAY_NAME,
      ],
      { env: cliEnv },
    );
    const gatewayInfo = await waitForHealthyGateway(openshellBin, cliEnv, gateway);
    expect(gatewayInfo).toMatchObject({ status: "healthy", version: OPENSHELL_VERSION });
    expect(gatewayInfo.compute_drivers).toContainEqual(expect.objectContaining({ name: "podman" }));

    progress.phase("activate registered-agent identities through the pinned OpenShell CLI");
    for (const { agent, sandboxName } of AGENTS) {
      runCommand(
        openshellBin,
        [
          "sandbox",
          "create",
          "-g",
          GATEWAY_NAME,
          "--name",
          sandboxName,
          "--from",
          BASE_IMAGE,
          "--label",
          `nemoclaw.agent=${agent}`,
          "--no-tty",
          "--",
          "/bin/sh",
          "-lc",
          `printf '%s\\n' '${agent}' >/tmp/nemoclaw-agent-proof`,
        ],
        { env: cliEnv, timeoutMs: 240_000 },
      );
      createdSandboxes.push(sandboxName);
      const activated = inspectContainer(runtimeEngines.sandboxLifecycle, sandboxName, agent);
      expect(activated.State).toMatchObject({ Paused: false, Running: true, Status: "running" });
    }

    const openclawSandbox = AGENTS[0].sandboxName;
    const portableStateDir = path.join(root, "portable-lifecycle");
    installPortableDemoSandboxLifecycle(
      openclawSandbox,
      [
        "env",
        "CHAT_UI_URL=http://127.0.0.1:18789",
        "NEMOCLAW_DASHBOARD_PORT=18789",
        "OPENCLAW_HOME=/sandbox",
        "OPENCLAW_STATE_DIR=/sandbox/.openclaw",
        "OPENCLAW_WORKSPACE_DIR=/sandbox/.openclaw/workspace",
        `NEMOCLAW_SANDBOX_NAME=${openclawSandbox}`,
        "/usr/local/bin/nemoclaw-start",
      ],
      { ...process.env, NEMOCLAW_EXPERIMENTAL_PROFILE: "portable" },
      {
        platform: "linux",
        podman: (args) => runtimeEngines.sandboxLifecycle.capture(args),
        stateDir: portableStateDir,
      },
    );
    const portableReceipt = JSON.parse(
      fs.readFileSync(
        portableDemoLifecycleInternals.receiptPath(openclawSandbox, portableStateDir),
        "utf-8",
      ),
    ) as { containerId: string; sandboxName: string; schemaVersion: number };
    expect(portableReceipt).toMatchObject({
      containerId: exactContainerId(runtimeEngines.sandboxLifecycle, openclawSandbox),
      sandboxName: openclawSandbox,
      schemaVersion: 2,
    });

    progress.phase("exercise exact-container stop and start");
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
      const initial = inspectContainer(agentEngines.sandboxLifecycle, sandboxName, agent);

      expect(lifecycle.stop(input, { beforeStop })).toEqual({ exitCode: 0, state: "stopped" });
      expect(beforeStop).toHaveBeenCalledExactlyOnceWith();
      const stopped = inspectContainer(
        agentEngines.sandboxLifecycle,
        sandboxName,
        agent,
        initial.Id,
      );
      expect(stopped.State).toMatchObject({ Paused: false, Running: false, Status: "exited" });

      expect(agentBundle.preflightDoctor.preflightLifecycle("start", input)).toBeNull();
      expect(lifecycle.start(input)).toEqual({ exitCode: 0 });
      await lifecycle.verifyStarted(
        input,
        vi.fn(async () => undefined),
      );
      const running = inspectContainer(
        agentEngines.sandboxLifecycle,
        sandboxName,
        agent,
        initial.Id,
      );
      expect(running.State).toMatchObject({ Paused: false, Running: true, Status: "running" });

      expect(lifecycle.stop(input, { beforeStop: vi.fn() })).toEqual({
        exitCode: 0,
        state: "stopped",
      });
      expect(lifecycle.start(input)).toEqual({ exitCode: 0 });
      const restarted = inspectContainer(
        agentEngines.sandboxLifecycle,
        sandboxName,
        agent,
        initial.Id,
      );
      expect(restarted.State).toMatchObject({ Paused: false, Running: true, Status: "running" });
      expect(lifecycle.stop(input, { beforeStop: vi.fn() })).toEqual({
        exitCode: 0,
        state: "stopped",
      });
      const final = inspectContainer(agentEngines.sandboxLifecycle, sandboxName, agent, initial.Id);
      expect(final.State).toMatchObject({ Paused: false, Running: false, Status: "exited" });
    }
    progress.phase("verify production portable ownership and final at-rest state");
    completed = true;
  } finally {
    await cleanupPodmanLifecycle({
      cliEnv,
      completed,
      createdSandboxes,
      engine: runtimeEngines.sandboxLifecycle,
      gateway,
      openshellBin,
      previousPortableProfile,
      root,
    });
  }
});
