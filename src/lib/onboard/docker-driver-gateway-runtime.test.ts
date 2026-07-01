// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import * as dockerDriverGatewayEnv from "./docker-driver-gateway-env";
import {
  createDockerDriverGatewayRuntimeHelpers,
  type DockerDriverGatewayRuntimeDeps,
} from "./docker-driver-gateway-runtime";
import {
  getDockerDriverGatewayRuntimeMarkerPath,
  writeDockerDriverGatewayRuntimeMarkerForStateDir,
} from "./docker-driver-gateway-runtime-marker";

function parseVersion(versionOutput: string | null | undefined): string | null {
  return String(versionOutput ?? "").match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

function makeHelpers(overrides: Partial<DockerDriverGatewayRuntimeDeps> = {}): {
  helpers: ReturnType<typeof createDockerDriverGatewayRuntimeHelpers>;
  runCapture: ReturnType<
    typeof vi.fn<(args: string[], opts?: { ignoreError?: boolean }) => string>
  >;
} {
  const runCapture = vi.fn(() => "");
  const deps: DockerDriverGatewayRuntimeDeps = {
    gatewayPort: 18080,
    getCachedOpenshellBinary: () => null,
    getBlueprintMaxOpenshellVersion: () => null,
    getInstalledOpenshellVersion: parseVersion,
    isOpenshellDevVersion: () => false,
    loadDockerDriverGatewayEnv: () => dockerDriverGatewayEnv,
    runCapture,
    shouldUseOpenshellDevChannel: () => false,
    supportedOpenshellFallbackVersion: "0.0.44",
    ...overrides,
  };
  return {
    helpers: createDockerDriverGatewayRuntimeHelpers(deps),
    runCapture: deps.runCapture as typeof runCapture,
  };
}

function withEnv<T>(values: Record<string, string | undefined>, callback: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(values)) {
    previous.set(key, process.env[key]);
    if (values[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = values[key];
    }
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("docker-driver gateway runtime helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses env-configured state, gateway, sandbox, network, and fallback version values", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-runtime-"));
    const stateDir = path.join(tempDir, "state");
    const gatewayBin = path.join("relative-tools", "openshell-gateway");
    const sandboxBin = path.join("relative-tools", "openshell-sandbox");
    try {
      withEnv(
        {
          NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: stateDir,
          NEMOCLAW_OPENSHELL_GATEWAY_BIN: gatewayBin,
          NEMOCLAW_OPENSHELL_SANDBOX_BIN: sandboxBin,
          OPENSHELL_DOCKER_NETWORK_NAME: "custom-openshell-docker",
        },
        () => {
          const { helpers } = makeHelpers({
            supportedOpenshellFallbackVersion: "0.0.99",
          });

          expect(helpers.getDockerDriverGatewayStateDir()).toBe(path.resolve(stateDir));
          expect(helpers.resolveOpenShellGatewayBinary()).toBe(path.resolve(gatewayBin));
          expect(helpers.resolveOpenShellSandboxBinary()).toBe(path.resolve(sandboxBin));

          const env = helpers.getDockerDriverGatewayEnv(null, "linux");
          expect(env.OPENSHELL_DOCKER_NETWORK_NAME).toBe("custom-openshell-docker");
          expect(env.OPENSHELL_DOCKER_SUPERVISOR_BIN).toBe(path.resolve(sandboxBin));
          expect(env.OPENSHELL_DOCKER_SUPERVISOR_IMAGE).toBe(
            "ghcr.io/nvidia/openshell/supervisor:0.0.99",
          );
          expect(env.OPENSHELL_GATEWAY_CONFIG).toBe(
            path.join(path.resolve(stateDir), "openshell-gateway.toml"),
          );
          expect(env.OPENSHELL_DB_URL).toBe(
            `sqlite:${path.join(path.resolve(stateDir), "openshell.db")}`,
          );
        },
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses the moving dev supervisor image for an explicit or detected dev runtime", () => {
    const explicit = makeHelpers({ shouldUseOpenshellDevChannel: () => true });
    expect(
      explicit.helpers.getDockerDriverGatewayEnv("openshell 0.0.72", "linux")
        .OPENSHELL_DOCKER_SUPERVISOR_IMAGE,
    ).toBe("ghcr.io/nvidia/openshell/supervisor:dev");

    const detected = makeHelpers({
      isOpenshellDevVersion: (versionOutput) => String(versionOutput).includes("-dev."),
    });
    expect(
      detected.helpers.getDockerDriverGatewayEnv("openshell 0.0.72-dev.8+g7bce1223", "linux")
        .OPENSHELL_DOCKER_SUPERVISOR_IMAGE,
    ).toBe("ghcr.io/nvidia/openshell/supervisor:dev");
  });

  it("pins the stable 0.0.72 supervisor default while preserving an explicit override", () => {
    const image = (fallback: string) =>
      makeHelpers({
        getBlueprintMaxOpenshellVersion: () => "0.0.72",
        supportedOpenshellFallbackVersion: fallback,
      }).helpers.getDockerDriverGatewayEnv(null, "linux").OPENSHELL_DOCKER_SUPERVISOR_IMAGE;
    const stable = withEnv({ OPENSHELL_DOCKER_SUPERVISOR_IMAGE: undefined }, () => image("0.0.72"));
    expect(stable).toBe(
      "ghcr.io/nvidia/openshell/supervisor@sha256:80ed9cda5bf672fefdb9dcd4604b40a8b09c0891b6eb9d03e10227c7e3dfb49d",
    );
    const override = "registry.example.test/supervisor@sha256:override";
    expect(withEnv({ OPENSHELL_DOCKER_SUPERVISOR_IMAGE: override }, () => image("0.0.72"))).toBe(
      override,
    );
  });

  it("clears custom state-dir PID and marker files when the recorded PID is not the gateway", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-runtime-"));
    const pid = 9_876_543;
    try {
      withEnv({ NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: stateDir }, () => {
        const { helpers, runCapture } = makeHelpers({
          runCapture: vi.fn(() => "node /tmp/not-openshell-gateway\n"),
        });
        const desiredEnv = { OPENSHELL_DRIVERS: "docker" };
        helpers.rememberDockerDriverGatewayPid(pid);
        writeDockerDriverGatewayRuntimeMarkerForStateDir(stateDir, {
          pid,
          desiredEnv,
          endpoint: "https://127.0.0.1:8080",
          platform: "linux",
          arch: process.arch,
        });
        const pidFile = path.join(stateDir, "openshell-gateway.pid");
        const markerPath = getDockerDriverGatewayRuntimeMarkerPath(stateDir);
        expect(fs.existsSync(pidFile)).toBe(true);
        expect(fs.existsSync(markerPath)).toBe(true);

        const originalExistsSync = fs.existsSync;
        vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);
        vi.spyOn(fs, "existsSync").mockImplementation(((candidate) => {
          if (String(candidate) === `/proc/${pid}/cmdline`) return false;
          return originalExistsSync(candidate);
        }) as typeof fs.existsSync);

        expect(helpers.isDockerDriverGatewayProcessAlive()).toBe(false);

        expect(runCapture).toHaveBeenCalledWith(["ps", "-p", String(pid), "-o", "args="], {
          ignoreError: true,
        });
        expect(fs.existsSync(pidFile)).toBe(false);
        expect(fs.existsSync(markerPath)).toBe(false);
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reports macOS VM-driver child drift after the runtime marker matches", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-runtime-"));
    const pid = 98_765;
    const gatewayBin = path.join(stateDir, "openshell-gateway");
    try {
      withEnv(
        {
          DOCKER_HOST: "unix:///tmp/docker.sock",
          NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: stateDir,
        },
        () => {
          const { helpers, runCapture } = makeHelpers({
            runCapture: vi.fn((args) =>
              args.join(" ") === "ps -axo pid=,ppid=,command="
                ? [
                    `${pid} 1 ${gatewayBin}`,
                    `${pid + 1} ${pid} /usr/local/bin/openshell-driver-vm --bind-socket /tmp/vm.sock`,
                  ].join("\n")
                : "",
            ),
          });
          const desiredEnv = helpers.getDockerDriverGatewayEnv(null, "darwin");
          writeDockerDriverGatewayRuntimeMarkerForStateDir(stateDir, {
            pid,
            desiredEnv,
            endpoint: desiredEnv.OPENSHELL_GRPC_ENDPOINT,
            gatewayBin,
            dockerHost: process.env.DOCKER_HOST,
            platform: "darwin",
            arch: process.arch,
          });

          expect(
            helpers.getDockerDriverGatewayRuntimeDrift(pid, desiredEnv, gatewayBin, "darwin")
              ?.reason,
          ).toContain("VM driver child process is still attached");
          expect(runCapture).toHaveBeenCalledWith(["ps", "-axo", "pid=,ppid=,command="], {
            ignoreError: true,
          });
        },
      );
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects an openshell port listener when the injected gateway identity check fails", () => {
    const { helpers } = makeHelpers();
    const isDockerDriverGatewayProcessFn = vi.fn(() => false);

    expect(
      helpers.getDockerDriverGatewayPortListenerPid(
        { ok: false, process: "openshell-gateway", pid: 1234 },
        {
          platform: "linux",
          gatewayBin: "/opt/openshell/openshell-gateway",
          isPidAliveFn: () => true,
          isDockerDriverGatewayProcessFn,
        },
      ),
    ).toBeNull();

    expect(isDockerDriverGatewayProcessFn).toHaveBeenCalledWith(
      1234,
      "/opt/openshell/openshell-gateway",
    );
  });

  it("does not match process args that only contain openshell-gateway as a suffix", () => {
    const pid = 12_345;
    const { helpers, runCapture } = makeHelpers({
      runCapture: vi.fn(() => "node /tmp/not-openshell-gateway\n"),
    });
    const originalExistsSync = fs.existsSync;
    vi.spyOn(fs, "existsSync").mockImplementation(((candidate) => {
      if (String(candidate) === `/proc/${pid}/cmdline`) return false;
      return originalExistsSync(candidate);
    }) as typeof fs.existsSync);

    expect(
      helpers.isDockerDriverGatewayProcess(pid, "/opt/openshell/openshell-gateway", {
        requireDockerDriverEnv: false,
      }),
    ).toBe(false);
    expect(runCapture).toHaveBeenCalledWith(["ps", "-p", String(pid), "-o", "args="], {
      ignoreError: true,
    });
  });

  it("does not match process args that contain openshell-gateway as a later argument", () => {
    const pid = 12_346;
    const { helpers, runCapture } = makeHelpers({
      runCapture: vi.fn(() => "node app.js /tmp/openshell-gateway\n"),
    });
    const originalExistsSync = fs.existsSync;
    vi.spyOn(fs, "existsSync").mockImplementation(((candidate) => {
      if (String(candidate) === `/proc/${pid}/cmdline`) return false;
      return originalExistsSync(candidate);
    }) as typeof fs.existsSync);

    expect(
      helpers.isDockerDriverGatewayProcess(pid, "/opt/openshell/openshell-gateway", {
        requireDockerDriverEnv: false,
      }),
    ).toBe(false);
    expect(runCapture).toHaveBeenCalledWith(["ps", "-p", String(pid), "-o", "args="], {
      ignoreError: true,
    });
  });

  it("does not match process args that contain the exact gateway path as a later argument", () => {
    const pid = 12_347;
    const gatewayBin = "/opt/openshell/openshell-gateway";
    const { helpers, runCapture } = makeHelpers({
      runCapture: vi.fn(() => `python worker.py '${gatewayBin}'\n`),
    });
    const originalExistsSync = fs.existsSync;
    vi.spyOn(fs, "existsSync").mockImplementation(((candidate) => {
      if (String(candidate) === `/proc/${pid}/cmdline`) return false;
      return originalExistsSync(candidate);
    }) as typeof fs.existsSync);

    expect(
      helpers.isDockerDriverGatewayProcess(pid, gatewayBin, {
        requireDockerDriverEnv: false,
      }),
    ).toBe(false);
    expect(runCapture).toHaveBeenCalledWith(["ps", "-p", String(pid), "-o", "args="], {
      ignoreError: true,
    });
  });

  it("falls back to /opt/homebrew/bin for the standalone gateway binary (#5334)", () => {
    withEnv({ NEMOCLAW_OPENSHELL_GATEWAY_BIN: undefined }, () => {
      const { helpers } = makeHelpers({
        // A cached CLI binary in a directory with no sibling gateway forces the
        // resolver past sibling resolution into the prefix fallback list.
        getCachedOpenshellBinary: () => "/nonexistent/dir/openshell",
      });
      vi.spyOn(fs, "existsSync").mockImplementation(
        ((candidate) =>
          String(candidate) === "/opt/homebrew/bin/openshell-gateway") as typeof fs.existsSync,
      );

      expect(helpers.resolveOpenShellGatewayBinary()).toBe("/opt/homebrew/bin/openshell-gateway");
    });
  });

  it("falls back to /opt/homebrew/bin for the standalone sandbox binary (#5334)", () => {
    withEnv({ NEMOCLAW_OPENSHELL_SANDBOX_BIN: undefined }, () => {
      const { helpers } = makeHelpers({
        getCachedOpenshellBinary: () => "/nonexistent/dir/openshell",
      });
      vi.spyOn(fs, "existsSync").mockImplementation(
        ((candidate) =>
          String(candidate) === "/opt/homebrew/bin/openshell-sandbox") as typeof fs.existsSync,
      );

      expect(helpers.resolveOpenShellSandboxBinary()).toBe("/opt/homebrew/bin/openshell-sandbox");
    });
  });

  it("matches the docker compatibility gateway parent process", () => {
    const pid = 12_348;
    const { helpers, runCapture } = makeHelpers({
      runCapture: vi.fn(
        () =>
          "docker run --rm --name nemoclaw-openshell-gateway image /opt/nemoclaw/openshell-gateway\n",
      ),
    });
    const originalExistsSync = fs.existsSync;
    vi.spyOn(fs, "existsSync").mockImplementation(((candidate) => {
      if (String(candidate) === `/proc/${pid}/cmdline`) return false;
      return originalExistsSync(candidate);
    }) as typeof fs.existsSync);

    expect(
      helpers.isDockerDriverGatewayProcess(pid, "/opt/openshell/openshell-gateway", {
        requireDockerDriverEnv: false,
      }),
    ).toBe(true);
    expect(runCapture).toHaveBeenCalledWith(["ps", "-p", String(pid), "-o", "args="], {
      ignoreError: true,
    });
  });

  it("detects a replaced executable against the compatibility identity gateway binary", () => {
    const pid = 12_349;
    const identityGatewayBin = "/opt/openshell/openshell-gateway";
    const replacementGatewayBin = "/opt/openshell/replaced/openshell-gateway";
    const desiredEnv = { OPENSHELL_DRIVERS: "docker" };
    const { helpers } = makeHelpers();
    const originalExistsSync = fs.existsSync.bind(fs);
    const originalReadFileSync = fs.readFileSync.bind(fs);
    const originalReadlinkSync = fs.readlinkSync.bind(fs);
    const existingProcPaths = new Set([`/proc/${pid}/environ`, `/proc/${pid}/exe`]);
    const procFileContents = new Map([[`/proc/${pid}/environ`, "OPENSHELL_DRIVERS=docker\0"]]);
    const procLinks = new Map([[`/proc/${pid}/exe`, replacementGatewayBin]]);
    vi.spyOn(fs, "existsSync").mockImplementation(
      ((candidate) =>
        existingProcPaths.has(String(candidate)) ||
        originalExistsSync(candidate)) as typeof fs.existsSync,
    );
    vi.spyOn(fs, "readFileSync").mockImplementation(
      ((candidate, options) =>
        procFileContents.get(String(candidate)) ??
        originalReadFileSync(candidate, options as never)) as typeof fs.readFileSync,
    );
    vi.spyOn(fs, "readlinkSync").mockImplementation(
      ((candidate, options) =>
        procLinks.get(String(candidate)) ??
        originalReadlinkSync(candidate, options as never)) as typeof fs.readlinkSync,
    );

    expect(
      helpers.getDockerDriverGatewayRuntimeDrift(pid, desiredEnv, identityGatewayBin, "linux")
        ?.reason,
    ).toBe(`executable=${replacementGatewayBin} (expected ${identityGatewayBin})`);
  });
});
