// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import * as dockerDriverGatewayEnv from "./docker-driver-gateway-env";
import { gatewayIdForStateDir } from "./docker-driver-gateway-config";
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
          NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: `  ${stateDir}  `,
          NEMOCLAW_OPENSHELL_GATEWAY_BIN: gatewayBin,
          NEMOCLAW_OPENSHELL_SANDBOX_BIN: sandboxBin,
          OPENSHELL_DOCKER_NETWORK_NAME: "custom-openshell-docker",
        },
        () => {
          const { helpers } = makeHelpers({
            supportedOpenshellFallbackVersion: "0.0.106",
          });

          expect(helpers.getDockerDriverGatewayStateDir()).toBe(path.resolve(stateDir));
          expect(helpers.getDockerDriverGatewayPidFile()).toBe(
            path.join(path.resolve(stateDir), "openshell-gateway.pid"),
          );
          expect(helpers.resolveOpenShellGatewayBinary()).toBe(path.resolve(gatewayBin));
          expect(helpers.resolveOpenShellSandboxBinary()).toBe(path.resolve(sandboxBin));

          const env = helpers.getDockerDriverGatewayEnv(null, "linux");
          expect(env.OPENSHELL_DOCKER_NETWORK_NAME).toBe("custom-openshell-docker");
          expect(env.OPENSHELL_DOCKER_SUPERVISOR_BIN).toBe(path.resolve(sandboxBin));
          expect(env.OPENSHELL_DOCKER_SUPERVISOR_IMAGE).toBe(
            "ghcr.io/nvidia/openshell/supervisor@sha256:722f44669722961b7f432b0b81de25b91a58f34a61d6403bef967acaf2b3af01",
          );
          expect(env.OPENSHELL_GATEWAY_CONFIG).toBe(
            path.join(path.resolve(stateDir), "openshell-gateway.toml"),
          );
          expect(env.OPENSHELL_DB_URL).toBe(
            `sqlite:${path.join(path.resolve(stateDir), "openshell.db")}`,
          );
          helpers.rememberDockerDriverGatewayPid(4242);
          writeDockerDriverGatewayRuntimeMarkerForStateDir(stateDir, {
            desiredEnv: {},
            endpoint: "https://127.0.0.1:18080",
            pid: 4242,
          });
          helpers.clearDockerDriverGatewayRuntimeFiles();
          expect(fs.existsSync(path.join(stateDir, "openshell-gateway.pid"))).toBe(false);
          expect(fs.existsSync(getDockerDriverGatewayRuntimeMarkerPath(stateDir))).toBe(false);
        },
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["relative", "relative-gateway-state"],
    ["shared root", path.join(os.homedir(), ".local", "state", "nemoclaw")],
  ])(
    "rejects a %s state-directory override through the binding owner",
    (_scenario, configured) => {
      withEnv({ NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: configured }, () => {
        expect(() => makeHelpers().helpers.getDockerDriverGatewayStateDir()).toThrow(
          /absolute dedicated gateway state directory|shared NemoClaw state root/,
        );
      });
    },
  );

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

  it("pins the stable 0.0.106 supervisor default while preserving an explicit override", () => {
    const image = (fallback: string) =>
      makeHelpers({
        getBlueprintMaxOpenshellVersion: () => "0.0.106",
        supportedOpenshellFallbackVersion: fallback,
      }).helpers.getDockerDriverGatewayEnv(null, "linux").OPENSHELL_DOCKER_SUPERVISOR_IMAGE;
    const stable = withEnv({ OPENSHELL_DOCKER_SUPERVISOR_IMAGE: undefined }, () =>
      image("0.0.106"),
    );
    expect(stable).toBe(
      "ghcr.io/nvidia/openshell/supervisor@sha256:722f44669722961b7f432b0b81de25b91a58f34a61d6403bef967acaf2b3af01",
    );
    const override = "registry.example.test/supervisor@sha256:override";
    expect(withEnv({ OPENSHELL_DOCKER_SUPERVISOR_IMAGE: override }, () => image("0.0.106"))).toBe(
      override,
    );
  });

  it("pins the portable gateway config to the prepared rootless Podman socket", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-podman-runtime-"));
    try {
      withEnv(
        {
          DOCKER_HOST: "unix:///run/user/1001/podman/podman.sock",
          NEMOCLAW_EXPERIMENTAL_PROFILE: "portable",
          NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: stateDir,
        },
        () => {
          const { helpers } = makeHelpers();
          const env = helpers.getDockerDriverGatewayEnv(null, "linux");
          expect(env.OPENSHELL_PODMAN_SOCKET).toBe("/run/user/1001/podman/podman.sock");
          expect(fs.readFileSync(env.OPENSHELL_GATEWAY_CONFIG, "utf-8")).toContain(
            'socket_path = "/run/user/1001/podman/podman.sock"',
          );
        },
      );
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("refuses a portable gateway without a prepared absolute Podman socket", () => {
    withEnv(
      {
        DOCKER_HOST: undefined,
        NEMOCLAW_EXPERIMENTAL_PROFILE: "portable",
      },
      () => {
        expect(() => makeHelpers().helpers.getDockerDriverGatewayEnv(null, "linux")).toThrow(
          "requires the prepared absolute rootless Podman socket",
        );
      },
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

  it("finds a service-manager replacement that uses the selected gateway state (#8797)", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-runtime-"));
    const recordedPid = 98_760;
    const replacementPid = 98_761;
    const gatewayBin = path.join(stateDir, "openshell-gateway");
    try {
      withEnv({ NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: stateDir }, () => {
        const namespace = gatewayIdForStateDir(stateDir);
        const runCapture = vi.fn((args: string[]) =>
          args.join(" ") === `ps -p ${String(replacementPid)} -o args=` ? gatewayBin : "",
        );
        const { helpers } = makeHelpers({
          getCachedOpenshellBinary: () => path.join(stateDir, "openshell"),
          runCapture,
          runCaptureEx: vi.fn(() => ({
            stdout: `${String(replacementPid)}\n`,
            exitCode: 0,
            timedOut: false,
          })),
        });
        helpers.rememberDockerDriverGatewayPid(recordedPid);
        vi.spyOn(process, "kill").mockImplementation(((pid) =>
          pid === replacementPid
            ? true
            : (() => {
                const gone = new Error("ESRCH") as NodeJS.ErrnoException;
                gone.code = "ESRCH";
                throw gone;
              })()
        ) as typeof process.kill);
        const originalExistsSync = fs.existsSync.bind(fs);
        const originalReadFileSync = fs.readFileSync.bind(fs);
        const replacementCmdline = `/proc/${String(replacementPid)}/cmdline`;
        const replacementEnvironment = `/proc/${String(replacementPid)}/environ`;
        vi.spyOn(fs, "existsSync").mockImplementation(((candidate) =>
          candidate === gatewayBin || candidate === replacementCmdline
            ? true
            : originalExistsSync(candidate)
        ) as typeof fs.existsSync);
        vi.spyOn(fs, "readFileSync").mockImplementation(((candidate, options) =>
          candidate === replacementCmdline
            ? `${gatewayBin}\0`
            : candidate === replacementEnvironment
              ? `NEMOCLAW_OPENSHELL_SANDBOX_NAMESPACE=${namespace}\0`
              : originalReadFileSync(candidate, options as never)
        ) as typeof fs.readFileSync);

        expect(helpers.isDockerDriverGatewayStateInUse()).toBe(true);
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("fails closed when replacement-process discovery is unavailable (#8797)", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-runtime-"));
    try {
      withEnv({ NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: stateDir }, () => {
        const { helpers } = makeHelpers();
        expect(helpers.isDockerDriverGatewayStateInUse()).toBe(true);
      });
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("confirms the selected gateway state is unused after a complete empty scan (#8797)", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-runtime-"));
    try {
      withEnv({ NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: stateDir }, () => {
        const { helpers } = makeHelpers({
          runCaptureEx: vi.fn(() => ({ stdout: "", exitCode: 1, timedOut: false })),
        });
        expect(helpers.isDockerDriverGatewayStateInUse()).toBe(false);
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
          const processOutput = new Map([
            [`ps -p ${pid} -o args=`, "openshell-gateway[nemoclaw=nemoclaw-18080;port=18080]\n"],
            [
              "ps -axo pid=,ppid=,command=",
              [
                `${pid} 1 ${gatewayBin}`,
                `${pid + 1} ${pid} /usr/local/bin/openshell-driver-vm --bind-socket /tmp/vm.sock`,
              ].join("\n"),
            ],
          ]);
          const { helpers, runCapture } = makeHelpers({
            runCapture: vi.fn((args) => processOutput.get(args.join(" ")) ?? ""),
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
    const { helpers } = makeHelpers({
      runCapture: vi.fn(() => "openshell-gateway[nemoclaw=nemoclaw-18080;port=18080]\n"),
    });
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

  it("rejects a mount-enabled process when the desired capability is disabled", () => {
    const { helpers } = makeHelpers();
    expect(
      helpers.getDockerDriverGatewayRuntimeDriftFromSnapshot({
        processEnv: {
          OPENSHELL_DRIVERS: "docker",
          NEMOCLAW_DOCKER_ENABLE_BIND_MOUNTS: "1",
        },
        processExe: "/usr/bin/openshell-gateway",
        desiredEnv: { OPENSHELL_DRIVERS: "docker" },
        gatewayBin: "/usr/bin/openshell-gateway",
      })?.reason,
    ).toBe("NEMOCLAW_DOCKER_ENABLE_BIND_MOUNTS=1 (expected <unset>)");
  });

  it("reuses a systemd-owned gateway without detached cleanup identity (#6903)", () => {
    const pid = 12_350;
    const gatewayBin = "/usr/bin/openshell-gateway";
    const desiredEnv = { OPENSHELL_DRIVERS: "docker" };
    const { helpers } = makeHelpers({
      runCapture: vi.fn(() => gatewayBin),
    });
    const originalExistsSync = fs.existsSync.bind(fs);
    const originalReadFileSync = fs.readFileSync.bind(fs);
    const originalReadlinkSync = fs.readlinkSync.bind(fs);
    const existingProcPaths = new Set([
      `/proc/${pid}/cmdline`,
      `/proc/${pid}/environ`,
      `/proc/${pid}/exe`,
    ]);
    const procFileContents = new Map([
      [`/proc/${pid}/cmdline`, `${gatewayBin}\0`],
      [`/proc/${pid}/environ`, "OPENSHELL_DRIVERS=docker\0"],
    ]);
    try {
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
      vi.spyOn(fs, "readlinkSync").mockImplementation(((candidate, options) =>
        String(candidate) === `/proc/${pid}/exe`
          ? gatewayBin
          : originalReadlinkSync(candidate, options as never)) as typeof fs.readlinkSync);

      expect(
        helpers.getDockerDriverGatewayRuntimeDrift(pid, desiredEnv, gatewayBin, "linux")?.reason,
      ).toContain("lacks target-bound cleanup identity");
      expect(
        helpers.getDockerDriverGatewayReuseDrift(pid, desiredEnv, gatewayBin, pid, "linux"),
      ).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("reuses the active official Homebrew gateway without detached cleanup identity (#6903)", () => {
    const pid = 12_351;
    const gatewayBin = "/opt/homebrew/bin/openshell-gateway";
    const { helpers } = makeHelpers();

    expect(
      helpers.getDockerDriverGatewayReuseDrift(
        pid,
        { OPENSHELL_DRIVERS: "docker" },
        gatewayBin,
        pid,
        "darwin",
      ),
    ).toBeNull();
  });
});
