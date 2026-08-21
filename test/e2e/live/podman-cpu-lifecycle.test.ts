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
  type PodmanContainerEngine,
} from "../../../src/lib/adapters/podman";
import { buildDockerDriverGatewayEnv } from "../../../src/lib/onboard/docker-driver-gateway-env";
import { ensureDockerDriverGatewayLocalTlsBundle } from "../../../src/lib/onboard/docker-driver-gateway-local-tls";
import {
  installPortableDemoSandboxLifecycle,
  portableDemoLifecycleInternals,
} from "../../../src/lib/onboard/experimental/portable-demo-lifecycle";
import { inspectPortablePodmanReadiness } from "../../../src/lib/onboard/experimental/portable-runtime-readiness";
import type {
  RuntimeProviderBundle,
  RuntimeProviderLifecycleInput,
  RuntimeProviderLifecycleSurface,
} from "../../../src/lib/onboard/runtime-provider/contract";
import { createPodmanRuntimeProviderBundle } from "../../../src/lib/onboard/runtime-provider/podman";
import type { SandboxEntry } from "../../../src/lib/state/registry/types";
import { expect, test } from "../fixtures/e2e-test.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import { OPENSHELL_V0106_QUALIFICATION } from "../fixtures/openshell-v0106-qualification.ts";
import {
  consumeNativeRuntimeCandidateEvidence,
  type NativeRuntimeCandidateEvidence,
} from "../registry/native-runtime-qualification.ts";
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
  // Keep the rootless proof on the immutable sandbox-base from the NemoClaw
  // v0.0.89 fixture, which runs OpenShell v0.0.85. Unlike a minimal Ubuntu
  // image, it includes the `ip` binary needed before workload startup and
  // exercises the v0.0.85 image-to-v0.0.106 supervisor compatibility boundary.
  "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:3265d482f67c9d81ee3a59b0bbad5eb5ea6c705fea81ece8ae888ed12794f7f1";
const ACTIVATION_POLICY = path.join(REPO_ROOT, "test/e2e/live/podman-cpu-lifecycle-policy.yaml");
const GATEWAY_PORT = 18_080;
const SUPERVISOR_IMAGE = OPENSHELL_V0106_QUALIFICATION.supervisorImage;
const E2E_PHASES = [
  "consume exact candidate prerequisites",
  "pin the exact rootless Podman endpoint",
  "qualify the Podman 5 host contract",
  "prove cold activation and warm API readiness",
  "start the pinned OpenShell Podman gateway",
  "activate registered-agent identities through the pinned OpenShell CLI",
  "exercise exact-container stop and start",
  "record successful final at-rest state",
] as const;

type SupportedLifecycle = Extract<RuntimeProviderLifecycleSurface, { supported: true }>;

function candidateAuthority() {
  const expectedSourceRevision = process.env.E2E_SOURCE_REVISION ?? "";
  expect(expectedSourceRevision).toMatch(/^[a-f0-9]{40}$/u);
  const evidence = JSON.parse(
    fs.readFileSync(path.join(ARTIFACT_DIR, "candidate-execution-prerequisites.json"), "utf8"),
  ) as NativeRuntimeCandidateEvidence;
  return consumeNativeRuntimeCandidateEvidence(evidence, expectedSourceRevision);
}

function engines(): {
  hostDoctor: PodmanContainerEngine;
  sandboxLifecycle: PodmanContainerEngine;
} {
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

test(
  "activates pinned OpenShell sandboxes and preserves registered-agent Podman CPU identity",
  {
    meta: { e2ePhases: E2E_PHASES },
    timeout: 360_000,
  },
  async ({ progress, shellProbe }) => {
    progress.phase("consume exact candidate prerequisites");
    expect(candidateAuthority()).toMatchObject({
      candidateId: "podman-cpu-lifecycle",
      providerId: "podman",
      executionPath: "runtime-provider-bundle",
    });

    progress.phase("pin the exact rootless Podman endpoint");
    expect(process.platform).toBe("linux");
    expect(process.getuid?.()).not.toBe(0);
    expect(ARTIFACT_DIR).not.toBe("");
    let runtimeEngines = engines();
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
    expect(bundle.workload.profile).toMatchObject({
      support: {
        exactDigestReferences: true,
        platforms: ["linux/amd64", "linux/arm64"],
      },
      hostArchitectures: ["amd64", "arm64"],
      managedImageSelectionPolicy: "require-managed",
      legacyDockerfileBuilds: false,
    });
    expect(bundle.capabilities.hostLocalInference).toBe(false);

    const openshellBin = executableOnPath("openshell");
    const gatewayBin = executableOnPath("openshell-gateway");
    const sandboxBin = executableOnPath("openshell-sandbox");
    for (const component of [openshellBin, gatewayBin, sandboxBin]) {
      expect(
        await runCommand(shellProbe, component, ["--version"], {
          artifactName: `podman-lifecycle-version-${path.basename(component)}`,
        }),
      ).toContain(OPENSHELL_VERSION);
    }

    const uid = process.getuid?.() ?? -1;
    expect(
      uid,
      "Rootless portable lifecycle evidence requires a non-root Linux UID",
    ).toBeGreaterThan(0);
    const runtimeAuthority = {
      schemaVersion: 1,
      kind: "podman",
      ownership: "current-user",
      uid,
      homeDir: os.homedir(),
      configHome: path.join(os.homedir(), ".config"),
      runtimeDir: path.join("/run/user", String(uid)),
      socketPath: SOCKET_PATH,
    } as const;

    progress.phase("prove cold activation and warm API readiness");
    const proofServicePid = process.env.E2E_PODMAN_SERVICE_PID ?? "";
    expect(proofServicePid).toMatch(/^[1-9][0-9]*$/u);
    await runCommand(
      shellProbe,
      "bash",
      [
        "-ceu",
        `
pid="$1"
kill "$pid"
for _attempt in $(seq 1 100); do
  if ! kill -0 "$pid" 2>/dev/null; then
    exit 0
  fi
  sleep 0.1
done
printf 'Podman proof service %s did not stop\n' "$pid" >&2
exit 1
`,
        "podman-proof-service-stop",
        proofServicePid,
      ],
      { artifactName: "podman-lifecycle-stop-proof-service", timeoutMs: 60_000 },
    );
    expect(fs.existsSync(`/proc/${proofServicePid}`)).toBe(false);
    fs.rmSync(SOCKET_PATH, { force: true });
    await runCommand(
      shellProbe,
      "systemctl",
      ["--user", "stop", "podman.service", "podman.socket"],
      { artifactName: "podman-lifecycle-stop-user-units", timeoutMs: 10_000 },
    );
    for (const unit of ["podman.service", "podman.socket"]) {
      expect(
        await runCommand(shellProbe, "systemctl", ["--user", "is-active", unit], {
          allowFailure: true,
          artifactName: `podman-lifecycle-cold-${unit}`,
          timeoutMs: 10_000,
        }),
      ).not.toBe("active");
    }
    const coldReadiness = inspectPortablePodmanReadiness(runtimeAuthority);
    expect(coldReadiness).toMatchObject({ ok: true, timing: { mode: "cold" } });
    const warmReadiness = inspectPortablePodmanReadiness(runtimeAuthority);
    expect(warmReadiness).toMatchObject({ ok: true, timing: { mode: "warm" } });
    runtimeEngines = engines();

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
      await runCommand(
        shellProbe,
        openshellBin,
        [
          "gateway",
          "add",
          `https://127.0.0.1:${String(GATEWAY_PORT)}`,
          "--local",
          "--name",
          GATEWAY_NAME,
        ],
        { artifactName: "podman-lifecycle-add-gateway", env: cliEnv },
      );
      const gatewayInfo = await waitForHealthyGateway(shellProbe, openshellBin, cliEnv, gateway);
      expect(gatewayInfo).toMatchObject({ status: "healthy", version: OPENSHELL_VERSION });
      expect(gatewayInfo.compute_drivers).toContainEqual(
        expect.objectContaining({ name: "podman" }),
      );

      progress.phase("activate registered-agent identities through the pinned OpenShell CLI");
      for (const { agent, sandboxName } of AGENTS) {
        // Record the exact proof-owned name before creation so cleanup also
        // covers a sandbox that reaches OpenShell's Error phase.
        createdSandboxes.push(sandboxName);
        await runCommand(
          shellProbe,
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
            "--policy",
            ACTIVATION_POLICY,
            "--label",
            `nemoclaw.agent=${agent}`,
            "--no-tty",
            "--",
            "/bin/sh",
            "-lc",
            // OpenShell keeps sandboxes by default after the initial command
            // exits. Let this command finish so `sandbox create` can return;
            // a foreground keepalive would hold the CLI session indefinitely.
            `printf '%s\\n' '${agent}' >/tmp/nemoclaw-agent-proof`,
          ],
          {
            artifactName: `podman-lifecycle-create-${agent}`,
            env: cliEnv,
            timeoutMs: 240_000,
          },
        );
        expect(
          await runCommand(
            shellProbe,
            openshellBin,
            [
              "sandbox",
              "exec",
              "--name",
              sandboxName,
              "-g",
              GATEWAY_NAME,
              "--",
              "cat",
              "/tmp/nemoclaw-agent-proof",
            ],
            {
              artifactName: `podman-lifecycle-agent-proof-${agent}`,
              env: cliEnv,
              timeoutMs: 10_000,
            },
          ),
        ).toBe(agent);
        const activated = inspectContainer(runtimeEngines.sandboxLifecycle, sandboxName);
        expect(activated.State).toMatchObject({ Paused: false, Running: true, Status: "running" });
      }

      expect(
        await runCommand(
          shellProbe,
          openshellBin,
          [
            "sandbox",
            "exec",
            "--name",
            AGENTS[0].sandboxName,
            "-g",
            GATEWAY_NAME,
            "--",
            "/bin/sh",
            "-lc",
            "command -v ip",
          ],
          {
            artifactName: "podman-lifecycle-v085-ip-prerequisite",
            env: cliEnv,
            timeoutMs: 10_000,
          },
        ),
      ).toMatch(/^\/(?:usr\/)?s?bin\/ip$/u);

      const openclawSandbox = AGENTS[0].sandboxName;
      const portableStateDir = path.join(root, "portable-lifecycle");
      const readinessLogs: string[] = [];
      const registryGeneration = installPortableDemoSandboxLifecycle(
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
          log: (message) => readinessLogs.push(message),
          runtimeAuthority,
          stateDir: portableStateDir,
        },
      );
      expect(readinessLogs).toContainEqual(expect.stringContaining("readiness: warm"));
      expect(registryGeneration).toMatch(/^[a-f0-9]{64}$/u);
      runtimeEngines = engines();
      const portableReceipt = JSON.parse(
        fs.readFileSync(
          portableDemoLifecycleInternals.receiptPath(openclawSandbox, portableStateDir),
          "utf-8",
        ),
      ) as {
        containerId: string;
        runtimeAuthority: { socketPath: string };
        sandboxName: string;
        schemaVersion: number;
      };
      expect(portableReceipt).toMatchObject({
        containerId: exactContainerId(runtimeEngines.sandboxLifecycle, openclawSandbox),
        sandboxName: openclawSandbox,
        runtimeAuthority: { socketPath: SOCKET_PATH },
        schemaVersion: 4,
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
        const initial = inspectContainer(agentEngines.sandboxLifecycle, sandboxName);

        expect(lifecycle.stop(input, { beforeStop })).toEqual({ exitCode: 0, state: "stopped" });
        expect(beforeStop).toHaveBeenCalledExactlyOnceWith();
        const stopped = inspectContainer(agentEngines.sandboxLifecycle, sandboxName, initial.Id);
        expect(stopped.State).toMatchObject({ Paused: false, Running: false, Status: "exited" });

        expect(agentBundle.preflightDoctor.preflightLifecycle("start", input)).toBeNull();
        expect(lifecycle.start(input)).toEqual({ exitCode: 0 });
        await lifecycle.verifyStarted(
          input,
          vi.fn(async () => undefined),
        );
        const running = inspectContainer(agentEngines.sandboxLifecycle, sandboxName, initial.Id);
        expect(running.State).toMatchObject({ Paused: false, Running: true, Status: "running" });

        expect(lifecycle.stop(input, { beforeStop: vi.fn() })).toEqual({
          exitCode: 0,
          state: "stopped",
        });
        expect(lifecycle.start(input)).toEqual({ exitCode: 0 });
        const restarted = inspectContainer(agentEngines.sandboxLifecycle, sandboxName, initial.Id);
        expect(restarted.State).toMatchObject({ Paused: false, Running: true, Status: "running" });
        expect(lifecycle.stop(input, { beforeStop: vi.fn() })).toEqual({
          exitCode: 0,
          state: "stopped",
        });
        const final = inspectContainer(agentEngines.sandboxLifecycle, sandboxName, initial.Id);
        expect(final.State).toMatchObject({ Paused: false, Running: false, Status: "exited" });
      }
      progress.phase("record successful final at-rest state");
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
        shellProbe,
      });
    }
  },
);
