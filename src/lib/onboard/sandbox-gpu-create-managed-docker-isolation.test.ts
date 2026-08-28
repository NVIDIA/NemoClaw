// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  streamSandboxCreate: vi.fn(),
  waitForCreatedSandboxReadyWithTrace: vi.fn(),
  printReadinessFailure: vi.fn(),
  enforceDockerGpuPatchPreserveNetwork: vi.fn(),
  verifyGpuSandboxAccessAfterReady: vi.fn(),
  createDockerGpuSandboxCreatePatch: vi.fn(),
  printSandboxCreateFailureDiagnostics: vi.fn(),
  collectDockerGpuPatchDiagnostics: vi.fn(),
  queryOpenShellDockerSandboxContainers: vi.fn(),
  queryOpenShellDockerSandboxRuntimeSnapshot: vi.fn(),
  helperResponds: vi.fn(),
  dockerSpawnSync: vi.fn(),
}));

vi.mock("../sandbox/create-stream", () => ({
  streamSandboxCreate: mocks.streamSandboxCreate,
}));

vi.mock("./sandbox-readiness-tracing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./sandbox-readiness-tracing")>()),
  waitForCreatedSandboxReadyWithTrace: mocks.waitForCreatedSandboxReadyWithTrace,
  printReadinessFailure: mocks.printReadinessFailure,
}));

vi.mock("./docker-gpu-local-inference", () => ({
  enforceDockerGpuPatchPreserveNetwork: mocks.enforceDockerGpuPatchPreserveNetwork,
  verifyGpuSandboxAccessAfterReady: mocks.verifyGpuSandboxAccessAfterReady,
}));

vi.mock("./docker-gpu-sandbox-create", () => ({
  createDockerGpuSandboxCreatePatch: mocks.createDockerGpuSandboxCreatePatch,
}));

vi.mock("./sandbox-create-failure", () => ({
  printSandboxCreateFailureDiagnostics: mocks.printSandboxCreateFailureDiagnostics,
}));

vi.mock("./docker-gpu-patch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./docker-gpu-patch")>()),
  collectDockerGpuPatchDiagnostics: mocks.collectDockerGpuPatchDiagnostics,
}));

vi.mock("./openshell-docker-sandbox-containers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openshell-docker-sandbox-containers")>()),
  queryOpenShellDockerSandboxContainers: mocks.queryOpenShellDockerSandboxContainers,
  queryOpenShellDockerSandboxRuntimeSnapshot: mocks.queryOpenShellDockerSandboxRuntimeSnapshot,
}));

vi.mock("../adapters/docker/credential-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/docker/credential-store")>()),
  dockerDesktopCredentialHelperResponds: mocks.helperResponds,
}));

vi.mock("../adapters/docker/exec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/docker/exec")>()),
  dockerSpawnSync: mocks.dockerSpawnSync,
}));

vi.mock("../platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform")>()),
  isWsl: (opts: { env?: NodeJS.ProcessEnv; isWsl?: boolean } = {}) =>
    typeof opts.isWsl === "boolean" ? opts.isWsl : Boolean(opts.env?.WSL_DISTRO_NAME),
}));

import {
  createGpuFlowDeps as createDeps,
  createGpuFlowInput as createInput,
  createGpuPatchFixture as createPatch,
  resetGpuFlowMocks,
  setupGpuFlowMocks,
} from "./__test-helpers__/sandbox-gpu-create-flow";
import type { ManagedBootstrapRuntimeCreateLifecycleInput } from "./managed-bootstrap/runtime-create";
import { runSandboxGpuCreateFlow, type SandboxGpuCreateFlowInput } from "./sandbox-gpu-create-flow";

const temporaryDirectories: string[] = [];

function writeDesktopCredsStore(): string {
  const dockerConfig = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wsl-docker-config-"));
  temporaryDirectories.push(dockerConfig);
  fs.writeFileSync(
    path.join(dockerConfig, "config.json"),
    JSON.stringify({ credsStore: "desktop.exe" }),
  );
  return dockerConfig;
}

function attachManagedBootstrap(input: SandboxGpuCreateFlowInput): void {
  input.sandboxGpuConfig = {
    mode: "0",
    hostGpuDetected: false,
    hostGpuPlatform: null,
    sandboxGpuEnabled: false,
    sandboxGpuDevice: null,
    errors: [],
  };
  input.gpuRoutePlan = "none";
  input.initialGpuRoute = "none";
  input.managedBootstrap = {
    bootstrapIdentity: "e".repeat(64),
    stateRoot: "/tmp/nemoclaw-managed-bootstrap",
    runtimeProvider: {
      identity: { id: "mxc" },
      bootstrap: {
        createOnboardRouting: () => ({ nativeFallbackHasCleanBaseline: false }),
        createLifecycle: (options: ManagedBootstrapRuntimeCreateLifecycleInput) => ({
          launchArgv: options.launchArgv,
          patch: createPatch(),
          recoverUnfinished: async () => null,
          prepareNetwork: async () => undefined,
          runCreate: async <T>(
            start: (held: {
              readonly heldWorkloadArgv: readonly string[];
              readonly bootstrapIdentity: string;
            }) => Promise<{ readonly value: T }>,
          ): Promise<T> =>
            (
              await start({
                heldWorkloadArgv: options.heldWorkloadArgv,
                bootstrapIdentity: options.bootstrapIdentity,
              })
            ).value,
        }),
      },
    },
  } as unknown as NonNullable<SandboxGpuCreateFlowInput["managedBootstrap"]>;
}

function captureCreateEnv(): { env: NodeJS.ProcessEnv; configExisted: boolean } {
  const captured = { env: {} as NodeJS.ProcessEnv, configExisted: false };
  mocks.streamSandboxCreate.mockImplementation((_exe, _args, env: NodeJS.ProcessEnv) => {
    captured.env = env;
    captured.configExisted = fs.existsSync(String(env.DOCKER_CONFIG));
    return Promise.resolve({
      status: 0,
      output: "Created sandbox: alpha",
      sawProgress: true,
    });
  });
  return captured;
}

beforeEach(() => {
  setupGpuFlowMocks(mocks);
  mocks.helperResponds.mockReturnValue(false);
  mocks.dockerSpawnSync.mockReturnValue({
    status: 0,
    error: undefined,
    stdout: "default\n",
    stderr: "",
  });
});

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
  resetGpuFlowMocks();
});

describe("managed Docker bootstrap create credential isolation", () => {
  it("passes an isolated DOCKER_CONFIG to streamSandboxCreate when the Desktop helper does not respond (#10349)", async () => {
    const dockerConfig = writeDesktopCredsStore();
    const input = createInput();
    attachManagedBootstrap(input);
    input.sandboxEnv = {
      PATH: "/usr/bin",
      OPENSHELL_GATEWAY: "1",
      WSL_DISTRO_NAME: "Ubuntu",
      DOCKER_CONFIG: dockerConfig,
      DOCKER_HOST: "unix:///var/run/docker.sock",
    };
    const captured = captureCreateEnv();
    const deps = createDeps();
    vi.mocked(deps.runCaptureOpenshell).mockImplementation((args) =>
      args[1] === "get" ? "ID: alpha-sandbox-id\nState: Ready\n" : "alpha Ready",
    );

    await runSandboxGpuCreateFlow(input, deps);

    expect(captured.env.DOCKER_CONFIG).toContain("nemoclaw-wsl-buildkit-docker-config-");
    expect(captured.env.DOCKER_CONFIG).not.toBe(dockerConfig);
    expect(captured.env.PATH).toBe("/usr/bin");
    expect(captured.env.OPENSHELL_GATEWAY).toBe("1");
    expect(captured.configExisted).toBe(true);
    expect(fs.existsSync(String(captured.env.DOCKER_CONFIG))).toBe(false);
    expect(mocks.streamSandboxCreate).toHaveBeenCalledOnce();
  });

  it.each([
    {
      title: "the Desktop helper responds",
      helperResponds: true,
      dockerHost: "unix:///var/run/docker.sock",
      contextStdout: "default\n",
    },
    {
      title: "the Docker context is not default",
      helperResponds: false,
      dockerHost: undefined,
      contextStdout: "remote-builder\n",
    },
  ])(
    "keeps the caller Docker config on managed sandbox create when $title (#10349)",
    async (row) => {
      const dockerConfig = writeDesktopCredsStore();
      mocks.helperResponds.mockReturnValue(row.helperResponds);
      mocks.dockerSpawnSync.mockReturnValue({
        status: 0,
        error: undefined,
        stdout: row.contextStdout,
        stderr: "",
      });
      const input = createInput();
      attachManagedBootstrap(input);
      input.sandboxEnv = {
        PATH: "/usr/bin",
        OPENSHELL_GATEWAY: "1",
        WSL_DISTRO_NAME: "Ubuntu",
        DOCKER_CONFIG: dockerConfig,
        ...(row.dockerHost === undefined ? {} : { DOCKER_HOST: row.dockerHost }),
      };
      const captured = captureCreateEnv();
      const deps = createDeps();
      vi.mocked(deps.runCaptureOpenshell).mockImplementation((args) =>
        args[1] === "get" ? "ID: alpha-sandbox-id\nState: Ready\n" : "alpha Ready",
      );

      await runSandboxGpuCreateFlow(input, deps);

      expect(captured.env.DOCKER_CONFIG).toBe(dockerConfig);
      expect(captured.env.PATH).toBe("/usr/bin");
      expect(captured.env.OPENSHELL_GATEWAY).toBe("1");
      expect(captured.configExisted).toBe(true);
      expect(fs.existsSync(dockerConfig)).toBe(true);
    },
  );
});
