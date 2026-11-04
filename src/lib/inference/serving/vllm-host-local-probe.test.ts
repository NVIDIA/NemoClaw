// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SpawnSyncOptions, SpawnSyncReturns } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireValue } from "../../core/require-value";
import { createSetupNimVllmHandler } from "../../onboard/setup-nim-vllm";
import {
  getLocalProviderBaseUrl,
  getLocalProviderValidationBaseUrl,
  getLocalProviderAvailabilityEndpoint,
  getLocalProviderContainerReachabilityCheck,
  getManagedVllmProviderBinding,
  probeLocalProviderHealth,
  validateLocalProvider,
} from "../local";

import { MANAGED_VLLM_API_KEY_FILE, managedVllmStateDir } from "../vllm-api-key";
import type { dockerCapture as captureDocker } from "../../adapters/docker/local-model-runtime";
import {
  DUAL_STATION_VLLM_RUNTIME_RECEIPT_FILE,
  MANAGED_CLUSTER_VLLM_RUNTIME_RECEIPT_FILE,
} from "./managed-runtime-receipts";
import { runtimeAuthFingerprint } from "./runtime-auth-fingerprint";
import {
  HOST_LOCAL_VLLM_RUNTIME_RECEIPT_FILE,
  getLegacyHostLocalManagedVllmBridgeHost,
  ManagedVllmInspectionError,
  recoverHostLocalManagedVllmEndpoint,
  resolveManagedVllmBridgeHost,
} from "./vllm-host-local-lifecycle";

const subprocess = vi.hoisted(() => ({
  spawnSync: vi.fn(
    (
      _file: string,
      _args: readonly string[],
      _options: SpawnSyncOptions,
    ): Pick<SpawnSyncReturns<string>, "status" | "stdout" | "stderr" | "error"> => ({
      status: 1,
      stdout: "",
      stderr: "",
    }),
  ),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: subprocess.spawnSync,
}));

function ownedContainer(bridge = "172.18.0.1") {
  return {
    Id: "a".repeat(64),
    Name: "/nemoclaw-vllm",
    State: { Running: true },
    Config: {
      Labels: { "com.nvidia.nemoclaw.managed-vllm": "true" } as Record<string, string>,
      Env: [] as string[],
    },
    NetworkSettings: {
      Ports: {
        "8000/tcp": [
          { HostIp: "127.0.0.1", HostPort: "18080" },
          { HostIp: bridge, HostPort: "18080" },
        ],
      },
    },
  };
}

function dockerCapture(row: ReturnType<typeof ownedContainer>, gateway = "172.18.0.1") {
  interceptDocker(row);
  return vi.fn<typeof captureDocker>((argv, _options) =>
    argv[0] === "container" ? JSON.stringify([row]) : JSON.stringify([{ Gateway: gateway }]),
  );
}

function interceptDocker(
  local: ReturnType<typeof ownedContainer> | null,
  remote: ReturnType<typeof ownedContainer> | null = null,
) {
  vi.stubEnv("DOCKER_CONTEXT", "remote-builder");
  vi.stubEnv("DOCKER_HOST", "ssh://remote.example.test");
  vi.stubEnv("DOCKER_CONFIG", "/tmp/remote-docker-config");
  vi.stubEnv("DOCKER_CERT_PATH", "/tmp/remote-docker-certs");
  vi.stubEnv("DOCKER_TLS", "1");
  vi.stubEnv("DOCKER_TLS_VERIFY", "1");
  vi.stubEnv("DOCKER_API_VERSION", "1.48");
  vi.stubEnv("UNRELATED_SECRET", "must-not-cross");
  subprocess.spawnSync.mockReset();
  subprocess.spawnSync.mockImplementation((file, args, options) => {
    expect(file).toBe("docker");
    const isLocal = options.env?.DOCKER_CONTEXT === "default" && !options.env?.DOCKER_HOST;
    const row = isLocal ? local : remote;
    const responses = new Map([
      [
        "container inspect nemoclaw-vllm",
        { status: row ? 0 : 1, stdout: row ? JSON.stringify([row]) : "", stderr: "" },
      ],
      [
        "network inspect --format {{json .IPAM.Config}} openshell-docker",
        {
          status: 0,
          stdout: JSON.stringify([{ Gateway: isLocal ? "172.18.0.1" : "172.19.0.1" }]),
          stderr: "",
        },
      ],
    ]);
    return responses.get(args.join(" ")) ?? { status: 1, stdout: "", stderr: "" };
  });
}

function retainManagedState(file: string): void {
  fs.writeFileSync(file, "retained", { mode: 0o600 });
}

function expectLocalSpawns(count: number) {
  expect(subprocess.spawnSync).toHaveBeenCalledTimes(count);
  for (const [file, _args, options] of subprocess.spawnSync.mock.calls) {
    expect(file).toBe("docker");
    expect(options).toMatchObject({ shell: false, timeout: 10_000 });
    expect(options.env).toMatchObject({ DOCKER_CONTEXT: "default", PATH: process.env.PATH });
    for (const name of [
      "DOCKER_HOST",
      "DOCKER_CONFIG",
      "DOCKER_CERT_PATH",
      "DOCKER_TLS",
      "DOCKER_TLS_VERIFY",
      "DOCKER_API_VERSION",
      "UNRELATED_SECRET",
    ]) {
      expect(options.env).not.toHaveProperty(name);
    }
  }
}

describe("host-local managed vLLM container probe", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "vllm-probe-"));
    vi.spyOn(os, "homedir").mockReturnValue(home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    subprocess.spawnSync.mockReset();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it.each([
    ["0.0.0.0", "absent"],
    ["0.0.0.0", "safe"],
    ["::", "absent"],
    ["::", "safe"],
  ])("rejects local publication on %s despite a %s remote container (#14083)", (host, remote) => {
    const row = ownedContainer();
    row.NetworkSettings.Ports["8000/tcp"] = [{ HostIp: host, HostPort: "18080" }];
    interceptDocker(row, remote === "safe" ? ownedContainer("172.19.0.1") : null);
    expect(() => getLegacyHostLocalManagedVllmBridgeHost(18080)).toThrow(
      "Managed bearerless vLLM has unsafe host bindings. Follow 'Handle a Running vLLM Server' in the vLLM setup guide before recreating the owned `nemoclaw-vllm` container. Preserve the original model and port settings.",
    );
    expectLocalSpawns(2);
  });

  it("inspects the default local daemon and its bridge despite ambient Docker selectors (#14083)", () => {
    interceptDocker(ownedContainer(), ownedContainer("172.19.0.1"));
    expect(getLegacyHostLocalManagedVllmBridgeHost(18080)).toBe("172.18.0.1");
    expectLocalSpawns(2);
    expect(subprocess.spawnSync.mock.calls[1]?.[2].env).toEqual(
      subprocess.spawnSync.mock.calls[0]?.[2].env,
    );
  });

  it("pins standalone host-local bridge discovery to the same local daemon", () => {
    interceptDocker(ownedContainer());
    expect(resolveManagedVllmBridgeHost()).toBe("172.18.0.1");
    expectLocalSpawns(1);
  });

  it.each([
    ["unavailable daemon", "docker", "", { status: 1, stderr: "Cannot connect to Docker" }],
    [
      "unavailable daemon under portable Podman",
      "podman",
      "portable",
      { status: 1, stderr: "Cannot connect to Docker" },
    ],
    [
      "partial Docker inspection under Podman",
      "podman",
      "",
      { status: 1, stdout: JSON.stringify([ownedContainer()]), stderr: "inspection failed" },
    ],
    [
      "denied Docker executable",
      "docker",
      "",
      { status: null, error: Object.assign(new Error("denied Docker"), { code: "EACCES" }) },
    ],
    [
      "denied Docker executable under Podman",
      "podman",
      "",
      { status: null, error: Object.assign(new Error("denied Docker"), { code: "EACCES" }) },
    ],
  ] as const)(
    "stops Docker-managed routes before probing with %s",
    (_label, runtime, profile, failure) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      vi.stubEnv("NEMOCLAW_GATEWAY_RUNTIME", runtime);
      vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", profile);
      interceptDocker(null);
      const inspect = subprocess.spawnSync.getMockImplementation()!;
      subprocess.spawnSync.mockImplementation((file, args, options) =>
        args.join(" ") === "container inspect nemoclaw-vllm"
          ? { stdout: "", stderr: "", ...failure }
          : inspect(file, args, options),
      );
      const probe = vi.fn();
      expect(() => getManagedVllmProviderBinding()).toThrow(ManagedVllmInspectionError);
      expect(getLocalProviderBaseUrl("vllm-local")).toBeNull();
      expect(getLocalProviderValidationBaseUrl("vllm-local")).toBeNull();
      expect(getLocalProviderAvailabilityEndpoint("vllm-local")).toBeNull();
      expect(getLocalProviderContainerReachabilityCheck("vllm-local")).toBeNull();
      expect(probeLocalProviderHealth("vllm-local", { runCurlProbeImpl: probe })).toMatchObject({
        ok: false,
        detail:
          "Managed vLLM container inspection failed. Verify access to Docker's default local daemon before retrying.",
      });
      expect(validateLocalProvider("vllm-local", probe).ok).toBe(false);
      expect(probe).not.toHaveBeenCalled();
    },
  );

  it.each([
    { runtime: "docker", profile: "", model: null },
    { runtime: "docker", profile: "", model: "served/model" },
    { runtime: "podman", profile: "", model: null },
    { runtime: "podman", profile: "", model: "served/model" },
    { runtime: "podman", profile: "portable", model: null },
    { runtime: "podman", profile: "portable", model: "served/model" },
    { runtime: "podman", profile: "", model: null, daemonUnavailable: true },
    { runtime: "podman", profile: "", model: "served/model", daemonUnavailable: true },
  ])(
    "selects and health-checks existing vLLM with unavailable Docker ($runtime, $profile, model=$model, daemon=$daemonUnavailable) (#14083)",
    async ({ runtime, profile, model, daemonUnavailable }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      vi.stubEnv("NEMOCLAW_GATEWAY_RUNTIME", runtime);
      vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", profile);
      interceptDocker(null);
      subprocess.spawnSync.mockReturnValue(
        daemonUnavailable
          ? { status: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" }
          : {
              status: null,
              stdout: "",
              stderr: "",
              error: Object.assign(new Error("spawnSync docker ENOENT"), { code: "ENOENT" }),
            },
      );
      expect(getManagedVllmProviderBinding()).toBeNull();
      const inventory = JSON.stringify({ data: [{ id: "served/model" }] });
      const query = vi.fn(() => inventory);
      const validate = vi.fn(async () => ({ ok: true, api: "openai-completions" }));
      const handler = createSetupNimVllmHandler({
        VLLM_PORT: 8000,
        getManagedVllmProviderBinding,
        getLocalProviderBaseUrl,
        getLocalProviderValidationBaseUrl,
        runCapture: query,
        queryVllmModels: vi.fn(() => inventory),
        isSafeModelId: () => true,
        requireValue,
        validateOpenAiLikeSelection: validate,
        applyVllmRuntimeContextWindow: vi.fn(),
        isDgxSparkHost: () => false,
        isNemoClawManagedVllmRunning: () => false,
        persistConfiguredManagedVllmRuntimeReceipt: vi.fn(async () => ({
          ok: true as const,
          persisted: true,
        })),
        exitProcess: (code) => {
          throw new Error(`exit ${code}`);
        },
      });
      const selection = {
        model,
        provider: "vllm-local",
        endpointUrl: null,
        credentialEnv: null,
        hermesAuthMethod: null,
        hermesToolGateways: [],
        preferredInferenceApi: null,
        nimContainer: null,
        allowToolsIncompatible: false,
      };
      await expect(handler(selection)).resolves.toBe("selected");
      expect(selection).toMatchObject({
        model: "served/model",
        endpointUrl: "http://host.openshell.internal:8000/v1",
      });
      expect(query).toHaveBeenCalledExactlyOnceWith(
        ["curl", "-sf", "http://127.0.0.1:8000/v1/models"],
        { ignoreError: true },
      );
      expect(validate).toHaveBeenCalledWith(
        "Local vLLM",
        "http://127.0.0.1:8000/v1",
        "served/model",
        null,
      );
      expect(getLocalProviderAvailabilityEndpoint("vllm-local")).toBe(
        "http://127.0.0.1:8000/v1/models",
      );
      expect(getLocalProviderContainerReachabilityCheck("vllm-local")?.at(-1)).toBe(
        "http://host.openshell.internal:8000/v1/models",
      );
      const probe = vi.fn(() => ({
        ok: true,
        httpStatus: 200,
        curlStatus: 0,
        body: inventory,
        stderr: "",
        message: "HTTP 200",
      }));
      expect(
        probeLocalProviderHealth("vllm-local", {
          model: "served/model",
          runCurlProbeImpl: probe,
        }),
      ).toMatchObject({ ok: true, endpoint: "http://127.0.0.1:8000/v1/models" });
      expect(probe).toHaveBeenCalledOnce();
    },
  );

  it.each(
    (
      [
        ["receipt", HOST_LOCAL_VLLM_RUNTIME_RECEIPT_FILE, retainManagedState],
        ["key", MANAGED_VLLM_API_KEY_FILE, retainManagedState],
        ["Station receipt", DUAL_STATION_VLLM_RUNTIME_RECEIPT_FILE, retainManagedState],
        ["cluster receipt", MANAGED_CLUSTER_VLLM_RUNTIME_RECEIPT_FILE, retainManagedState],
        [
          "receipt symlink",
          HOST_LOCAL_VLLM_RUNTIME_RECEIPT_FILE,
          (file) => fs.symlinkSync(path.join(home, "absent"), file),
        ],
        [
          "unreadable state",
          HOST_LOCAL_VLLM_RUNTIME_RECEIPT_FILE,
          () => {
            vi.spyOn(fs, "lstatSync").mockImplementation(() => {
              throw Object.assign(new Error("denied"), { code: "EACCES" });
            });
          },
        ],
      ] satisfies Array<[string, string, (file: string) => unknown]>
    ).flatMap(([state, file, prepare]) =>
      [false, true].map((missingDocker) => ({ state, file, prepare, missingDocker })),
    ),
  )(
    "refuses unvalidated managed $state with missing Docker=$missingDocker under native Podman",
    ({ file, prepare, missingDocker }) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      vi.stubEnv("NEMOCLAW_GATEWAY_RUNTIME", "podman");
      vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "");
      fs.mkdirSync(managedVllmStateDir(), { recursive: true });
      prepare(path.join(managedVllmStateDir(), file));
      interceptDocker(null);
      subprocess.spawnSync.mockReturnValue(
        missingDocker
          ? {
              status: null,
              stdout: "",
              stderr: "",
              error: Object.assign(new Error("missing"), { code: "ENOENT" }),
            }
          : { status: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" },
      );
      const probe = vi.fn();
      expect(() => getLegacyHostLocalManagedVllmBridgeHost(8000)).toThrow(
        ManagedVllmInspectionError,
      );
      expect(() => getManagedVllmProviderBinding()).toThrow();
      expect(probeLocalProviderHealth("vllm-local", { runCurlProbeImpl: probe })).toMatchObject({
        ok: false,
      });
      expect(probe).not.toHaveBeenCalled();
    },
  );

  it("rejects unsafe Docker-managed publication even when native Podman is selected (#14083)", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.stubEnv("NEMOCLAW_GATEWAY_RUNTIME", "podman");
    vi.stubEnv("NEMOCLAW_EXPERIMENTAL_PROFILE", "");
    const row = ownedContainer();
    row.NetworkSettings.Ports["8000/tcp"] = [{ HostIp: "0.0.0.0", HostPort: "18080" }];
    interceptDocker(row);
    expect(() => getManagedVllmProviderBinding({ legacyServingPort: 18080 })).toThrow(
      "unsafe host bindings",
    );
    const probe = vi.fn();
    expect(probeLocalProviderHealth("vllm-local", { runCurlProbeImpl: probe })).toMatchObject({
      ok: false,
      detail: expect.stringContaining("Handle a Running vLLM Server"),
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it("preserves an explicitly selected bridge environment for generic installation", () => {
    interceptDocker(null);
    const env = { DOCKER_CONTEXT: "requested-builder", PATH: "/usr/bin" };
    expect(resolveManagedVllmBridgeHost(undefined, env)).toBe("172.19.0.1");
    expect(subprocess.spawnSync).toHaveBeenCalledExactlyOnceWith(
      "docker",
      ["network", "inspect", "--format", "{{json .IPAM.Config}}", "openshell-docker"],
      expect.objectContaining({ env, shell: false, timeout: 10_000 }),
    );
  });

  it("preserves local daemon authority for authenticated recovery too", () => {
    const apiKey = "b".repeat(64);
    const row = ownedContainer();
    row.Config.Labels["com.nvidia.nemoclaw.managed-vllm-auth"] = runtimeAuthFingerprint(apiKey);
    row.Config.Env = [`VLLM_API_KEY=${apiKey}`];
    interceptDocker(row);
    expect(recoverHostLocalManagedVllmEndpoint({ loadApiKey: () => apiKey })).toEqual({
      baseUrl: "http://127.0.0.1:18080",
      apiKey,
      containerId: row.Id,
    });
    expectLocalSpawns(2);
  });

  it.each([
    [
      "foreign container",
      (row) => {
        row.Config.Labels = {};
      },
    ],
    [
      "stopped container",
      (row) => {
        row.State.Running = false;
      },
    ],
    [
      "authenticated container",
      (row) => {
        row.Config.Labels["com.nvidia.nemoclaw.managed-vllm-auth"] = "a".repeat(64);
      },
    ],
    [
      "distributed container",
      (row) => {
        row.Config.Labels["com.nvidia.nemoclaw.vllm-role"] = "head";
      },
    ],
  ] satisfies Array<[string, (row: ReturnType<typeof ownedContainer>) => void]>)(
    "does not select the bridge for a %s",
    (_label, change) => {
      const row = ownedContainer();
      change(row);
      expect(getLegacyHostLocalManagedVllmBridgeHost(18080, dockerCapture(row))).toBeNull();
    },
  );

  it.each([
    ["a public second binding", { HostIp: "0.0.0.0", HostPort: "18080" }],
    ["a mismatched host port", { HostIp: "172.18.0.1", HostPort: "19000" }],
  ] as const)("rejects an owned container with %s", (_label, binding) => {
    const row = ownedContainer();
    row.NetworkSettings.Ports["8000/tcp"][1] = binding;
    expect(() => getLegacyHostLocalManagedVllmBridgeHost(18080, dockerCapture(row))).toThrow(
      "unsafe host bindings",
    );
  });

  it("rejects a public OpenShell gateway", () => {
    expect(() =>
      getLegacyHostLocalManagedVllmBridgeHost(
        18080,
        dockerCapture(ownedContainer(), "203.0.113.1"),
      ),
    ).toThrow("requires one private OpenShell bridge address");
  });

  it("preserves the legacy probe when the local container is confirmed absent", () => {
    interceptDocker(null, ownedContainer());
    const capture = subprocess.spawnSync.getMockImplementation()!;
    subprocess.spawnSync.mockImplementation((file, args, options) =>
      args.join(" ") === "container inspect nemoclaw-vllm"
        ? { status: 1, stdout: "[]", stderr: "Error: No such object: nemoclaw-vllm" }
        : capture(file, args, options),
    );
    expect(getLegacyHostLocalManagedVllmBridgeHost(18080)).toBeNull();
    expectLocalSpawns(1);
  });

  it.each([
    { state: "unavailable daemon", status: 1, stdout: "", stderr: "Cannot connect to Docker" },
    { state: "malformed JSON", status: 0, stdout: "{", stderr: "" },
    { state: "empty inspection", status: 0, stdout: "[]", stderr: "" },
    {
      state: "an unexpected container identity",
      status: 0,
      stdout: JSON.stringify([{ ...ownedContainer(), Name: "/other-vllm" }]),
      stderr: "",
    },
    { state: "missing process status", status: null, stdout: "", stderr: "" },
  ])("rejects an inspection with $state instead of treating it as absence", (result) => {
    interceptDocker(null, ownedContainer());
    subprocess.spawnSync.mockReturnValue(result as ReturnType<typeof subprocess.spawnSync>);
    expect(() => getLegacyHostLocalManagedVllmBridgeHost(18080)).toThrow(
      "Managed vLLM container inspection failed",
    );
    expectLocalSpawns(1);
  });
});
