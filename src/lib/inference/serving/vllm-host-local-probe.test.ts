// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SpawnSyncOptions } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { dockerCapture as captureDocker } from "../../adapters/docker/local-model-runtime";
import { runtimeAuthFingerprint } from "./runtime-auth-fingerprint";
import {
  getLegacyHostLocalManagedVllmBridgeHost,
  recoverHostLocalManagedVllmEndpoint,
  resolveManagedVllmBridgeHost,
} from "./vllm-host-local-lifecycle";

const subprocess = vi.hoisted(() => ({
  spawnSync: vi.fn((_file: string, _args: readonly string[], _options: SpawnSyncOptions) => ({
    status: 1,
    stdout: "",
    stderr: "",
  })),
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
  afterEach(() => {
    vi.unstubAllEnvs();
    subprocess.spawnSync.mockReset();
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
      "different name",
      (row) => {
        row.Name = "/other-vllm";
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

  it("preserves the legacy probe when Docker inspection is unavailable", () => {
    interceptDocker(null, ownedContainer());
    expect(getLegacyHostLocalManagedVllmBridgeHost(18080)).toBeNull();
    expectLocalSpawns(1);
  });
});
