// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawnSync } from "node:child_process";
import { once } from "node:events";
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
import {
  PODMAN_MANAGED_LABEL,
  PODMAN_SANDBOX_CONTAINER_PREFIX,
  PODMAN_SANDBOX_ID_LABEL,
  PODMAN_SANDBOX_NAME_LABEL,
  PODMAN_SANDBOX_NAMESPACE,
  PODMAN_SANDBOX_NAMESPACE_LABEL,
  PODMAN_SANDBOX_WORKSPACE,
  PODMAN_SANDBOX_WORKSPACE_LABEL,
} from "../../../src/lib/onboard/runtime-provider/podman-lifecycle";
import type { SandboxEntry } from "../../../src/lib/state/registry/types";
import { expect, test } from "../fixtures/e2e-test.ts";
import { spawnObservedChild } from "../fixtures/observed-child-process.ts";
import type { TestProgress } from "../fixtures/progress.ts";
import { stripAnsi } from "./json-envelope.ts";

const AGENTS = [
  { agent: "openclaw", sandboxName: "podman-openclaw" },
  { agent: "hermes", sandboxName: "podman-hermes" },
  { agent: "langchain-deepagents-code", sandboxName: "podman-dcode" },
] as const;
const BASE_IMAGE =
  "docker.io/library/ubuntu@sha256:019e8eb29a85e74d64925745884f2ec79aa27e3feab36353d24656f4d6b89467";
const GATEWAY_NAME = "podman-proof";
const GATEWAY_PORT = 18_080;
const OPENSHELL_VERSION = "0.0.99";
const SUPERVISOR_IMAGE =
  "ghcr.io/nvidia/openshell/supervisor@sha256:ea3632b6e9528e2309103af5b6949606fcdc83ca1f69e8db81482a25bea84bb6";
const SOCKET_PATH = process.env.E2E_PODMAN_SOCKET ?? "";
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? "";
const E2E_PHASES = [
  "pin the exact rootless Podman endpoint",
  "qualify the Podman 5 host contract",
  "start the pinned OpenShell Podman gateway",
  "activate registered-agent identities through the pinned OpenShell CLI",
  "exercise exact-container stop and start",
  "verify production portable ownership and final at-rest state",
] as const;
const FULL_CONTAINER_ID = /^[0-9a-f]{64}$/u;

type SupportedLifecycle = Extract<RuntimeProviderLifecycleSurface, { supported: true }>;

interface ManagedContainerInspect {
  Config: {
    Cmd: string[];
    Entrypoint: string | string[];
    Labels: Record<string, string>;
  };
  Id: string;
  Name: string;
  State: { Paused: boolean; Running: boolean; Status: string };
}

interface CommandOptions {
  allowFailure?: boolean;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

interface GatewayInfo {
  compute_drivers: Array<{ name: string }>;
  status: string;
  version: string;
}

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

function executableOnPath(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep looking for the exact installed component.
    }
  }
  throw new Error(`Required executable '${name}' was not found on PATH.`);
}

function appendCommandLog(command: string, args: readonly string[], output: string): void {
  if (!ARTIFACT_DIR) return;
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true, mode: 0o700 });
  fs.appendFileSync(
    path.join(ARTIFACT_DIR, "openshell-podman-commands.log"),
    `$ ${path.basename(command)} ${args.join(" ")}\n${output}\n`,
    { encoding: "utf-8", mode: 0o600 },
  );
}

function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): string {
  const result = spawnSync(command, [...args], {
    encoding: "utf-8",
    env: options.env ?? process.env,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
    timeout:
      options.timeoutMs === 240_000 ? 240_000 : options.timeoutMs === 10_000 ? 10_000 : 60_000,
  });
  const output = `${String(result.stdout ?? "")}${String(result.stderr ?? "")}`;
  appendCommandLog(command, args, output);
  if (!options.allowFailure && (result.error || result.status !== 0)) {
    throw new Error(
      `${path.basename(command)} ${args.join(" ")} failed (exit ${String(result.status)}):\n${
        result.error?.message ?? output
      }`,
    );
  }
  return String(result.stdout ?? "").trim();
}

async function startPinnedGateway(
  gatewayBin: string,
  gatewayEnv: Record<string, string>,
  progress: TestProgress,
): Promise<ChildProcess> {
  const child = spawnObservedChild(gatewayBin, [], {
    activityLabel: "command: pinned OpenShell 0.0.99 Podman gateway",
    progress,
    spawn: {
      env: { ...process.env, ...gatewayEnv },
      stdio: ["ignore", "pipe", "pipe"],
    },
  });
  let output = "";
  const recordOutput = (chunk: unknown) => {
    const text = String(chunk);
    output += text;
    if (!ARTIFACT_DIR) return;
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(ARTIFACT_DIR, "openshell-podman-gateway.log"), text, {
      encoding: "utf-8",
      mode: 0o600,
    });
  };
  child.stdout?.on("data", recordOutput);
  child.stderr?.on("data", recordOutput);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const plainOutput = stripAnsi(output);
    if (/configuration error|invalid \[openshell[.]drivers[.]podman\] table/iu.test(plainOutput)) {
      child.kill("SIGTERM");
      throw new Error(`Pinned OpenShell rejected the Podman configuration:\n${output}`);
    }
    if (child.exitCode !== null) {
      throw new Error(
        `Pinned OpenShell Podman gateway exited with ${String(child.exitCode)}:\n${output}`,
      );
    }
    // This confirms that the pinned configuration was accepted. OpenShell logs
    // it before Podman initialization and listener binding, so the caller must
    // still poll a real authenticated gateway request before creating sandboxes.
    if (/Using compute driver\s+driver=podman/u.test(plainOutput)) return child;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill("SIGTERM");
  throw new Error(`Pinned OpenShell Podman gateway did not initialize:\n${output}`);
}

async function waitForHealthyGateway(
  openshellBin: string,
  cliEnv: NodeJS.ProcessEnv,
  child: ChildProcess,
): Promise<GatewayInfo> {
  const deadline = Date.now() + 120_000;
  let lastFailure = "gateway info was not attempted";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Pinned OpenShell Podman gateway exited before its authenticated endpoint became healthy ` +
          `(exit ${String(child.exitCode)}, signal ${String(child.signalCode)}).`,
      );
    }
    try {
      const info = JSON.parse(
        runCommand(openshellBin, ["gateway", "info", "-g", GATEWAY_NAME, "-o", "json"], {
          env: cliEnv,
          timeoutMs: 10_000,
        }),
      ) as GatewayInfo;
      const hasPodman = info.compute_drivers?.some((driver) => driver.name === "podman") ?? false;
      if (info.status === "healthy" && info.version === OPENSHELL_VERSION && hasPodman) {
        return info;
      }
      lastFailure = `status=${String(info.status)}, version=${String(info.version)}, podman=${String(
        hasPodman,
      )}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Pinned OpenShell Podman gateway did not become healthy within 120 seconds: ${lastFailure}`,
  );
}

async function stopGateway(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "close"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function exactContainerId(engine: ContainerEngine, sandboxName: string): string {
  const result = engine.capture([
    "ps",
    "--all",
    "--quiet",
    "--no-trunc",
    "--filter",
    `label=${PODMAN_MANAGED_LABEL}=true`,
    "--filter",
    `label=${PODMAN_SANDBOX_NAME_LABEL}=${sandboxName}`,
    "--filter",
    `label=${PODMAN_SANDBOX_WORKSPACE_LABEL}=${PODMAN_SANDBOX_WORKSPACE}`,
  ]);
  expect(result).toMatchObject({ status: 0, stderr: "" });
  const rows = result.stdout
    .split(/\r?\n/u)
    .map((row) => row.trim())
    .filter(Boolean);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatch(FULL_CONTAINER_ID);
  return rows[0]!;
}

function inspectContainer(
  engine: ContainerEngine,
  sandboxName: string,
  expectedAgent: string,
  expectedId?: string,
): ManagedContainerInspect {
  const containerId = exactContainerId(engine, sandboxName);
  if (expectedId) expect(containerId).toBe(expectedId);
  const result = engine.capture(["container", "inspect", containerId]);
  expect(result).toMatchObject({ status: 0, stderr: "" });
  const entries = JSON.parse(result.stdout) as ManagedContainerInspect[];
  expect(entries).toHaveLength(1);
  const entry = entries[0]!;
  const labels = entry.Config.Labels;
  const sandboxId = labels[PODMAN_SANDBOX_ID_LABEL];
  expect(entry.Id).toBe(containerId);
  expect(entry.Id).toMatch(FULL_CONTAINER_ID);
  expect(sandboxId).toBeTruthy();
  expect(entry.Name).toBe(`${PODMAN_SANDBOX_CONTAINER_PREFIX}${sandboxName}-${sandboxId}`);
  expect(labels).toMatchObject({
    [PODMAN_MANAGED_LABEL]: "true",
    [PODMAN_SANDBOX_NAME_LABEL]: sandboxName,
    [PODMAN_SANDBOX_NAMESPACE_LABEL]: PODMAN_SANDBOX_NAMESPACE,
    [PODMAN_SANDBOX_WORKSPACE_LABEL]: PODMAN_SANDBOX_WORKSPACE,
    "nemoclaw.agent": expectedAgent,
  });
  expect(entry.Config.Cmd).toEqual(["--workdir", "/sandbox"]);
  const entrypoint = Array.isArray(entry.Config.Entrypoint)
    ? entry.Config.Entrypoint
    : [entry.Config.Entrypoint];
  expect(entrypoint).toEqual(["/opt/openshell/bin/openshell-sandbox"]);
  return entry;
}

function captureFailureContainerDiagnostics(
  engine: ContainerEngine,
  sandboxNames: readonly string[],
): void {
  if (!ARTIFACT_DIR) return;
  const diagnosticDir = path.join(ARTIFACT_DIR, "failure-containers");
  fs.mkdirSync(diagnosticDir, { recursive: true, mode: 0o700 });
  for (const sandboxName of sandboxNames) {
    const discovery = engine.capture([
      "ps",
      "--all",
      "--quiet",
      "--no-trunc",
      "--filter",
      `label=${PODMAN_MANAGED_LABEL}=true`,
      "--filter",
      `label=${PODMAN_SANDBOX_NAME_LABEL}=${sandboxName}`,
      "--filter",
      `label=${PODMAN_SANDBOX_WORKSPACE_LABEL}=${PODMAN_SANDBOX_WORKSPACE}`,
    ]);
    const containerIds = discovery.stdout
      .split(/\r?\n/u)
      .map((row) => row.trim())
      .filter((row) => FULL_CONTAINER_ID.test(row));
    for (const containerId of containerIds) {
      for (const [suffix, args] of [
        ["inspect.json", ["container", "inspect", containerId]],
        ["log", ["logs", containerId]],
      ] as const) {
        const result = engine.capture(args, 30_000);
        fs.writeFileSync(
          path.join(diagnosticDir, `${sandboxName}-${containerId}-${suffix}`),
          `${result.stdout}${result.stderr}`,
          { encoding: "utf-8", mode: 0o600 },
        );
      }
    }
  }
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
    if (!completed) {
      try {
        captureFailureContainerDiagnostics(runtimeEngines.sandboxLifecycle, createdSandboxes);
      } catch {
        // Diagnostics are best effort; lifecycle cleanup must still run.
      }
    }
    for (const sandboxName of createdSandboxes.reverse()) {
      runCommand(openshellBin, ["sandbox", "delete", "-g", GATEWAY_NAME, sandboxName], {
        allowFailure: true,
        env: cliEnv,
      });
    }
    await stopGateway(gateway);
    if (previousPortableProfile === undefined) {
      delete process.env.NEMOCLAW_EXPERIMENTAL_PROFILE;
    } else {
      process.env.NEMOCLAW_EXPERIMENTAL_PROFILE = previousPortableProfile;
    }
    fs.rmSync(root, { force: true, recursive: true });
  }
});
