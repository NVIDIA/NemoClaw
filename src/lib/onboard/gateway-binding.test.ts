// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { DEFAULT_GATEWAY_PORT } from "../core/ports";
import { buildDockerDriverGatewayLaunch } from "./docker-driver-gateway-launch";
import {
  getDockerDriverGatewayRuntimeMarkerDriftForStateDir,
  getDockerDriverGatewayRuntimeMarkerPath,
  readDockerDriverGatewayRuntimeMarker,
  writeDockerDriverGatewayRuntimeMarkerForStateDir,
} from "./docker-driver-gateway-runtime-marker";
import {
  BASE_GATEWAY_COMPAT_CONTAINER_NAME,
  BASE_GATEWAY_NAME,
  BASE_GATEWAY_STATE_DIR_NAME,
  createDynamicGatewayRuntimeHelpers,
  resolveCoreOnboardGatewayBinding,
  resolveGatewayCompatContainerName,
  resolveGatewayName,
  resolveGatewayPortFromName,
  resolveGatewayStateDirName,
  resolveSandboxGatewayName,
} from "./gateway-binding";

describe("dynamic gateway runtime helpers", () => {
  it("resolves every default probe from the current process-local gateway binding", async () => {
    let gatewayName = "nemoclaw";
    let gatewayPort = 8080;
    const probeGatewayHttpReady = vi.fn(async () => true);
    const probeDockerDriverGatewayHttpReady = vi.fn(async () => true);
    const probeGatewayTcpReady = vi.fn(async () => true);
    const getGatewayClusterImageDrift = vi.fn(() => null);
    const helpers = createDynamicGatewayRuntimeHelpers({
      getGatewayName: () => gatewayName,
      getGatewayPort: () => gatewayPort,
      getDockerDriverGatewayEndpoint: (port) => `http://127.0.0.1:${port}`,
      getGatewayClusterImageDrift,
      probeGatewayHttpReady,
      probeDockerDriverGatewayHttpReady,
      waitForGatewayHttpReadyBase: vi.fn(async () => true),
      probeGatewayTcpReady,
    });

    expect(helpers.getDockerDriverGatewayEndpoint()).toBe("http://127.0.0.1:8080");
    await helpers.isGatewayHttpReady();
    await helpers.isDockerDriverGatewayHttpReady();
    await helpers.isGatewayTcpReady(250);
    helpers.getGatewayClusterImageDrift();
    expect(probeGatewayHttpReady).toHaveBeenLastCalledWith(
      undefined,
      "http://127.0.0.1:8080/",
      undefined,
      undefined,
    );
    expect(probeDockerDriverGatewayHttpReady).toHaveBeenLastCalledWith(
      undefined,
      "http://127.0.0.1:8080/openshell.v1.OpenShell/Health",
    );
    expect(probeGatewayTcpReady).toHaveBeenLastCalledWith(8080, 250);
    expect(getGatewayClusterImageDrift).toHaveBeenLastCalledWith({ gatewayName: "nemoclaw" });

    gatewayName = "nemoclaw-8081";
    gatewayPort = 8081;
    expect(helpers.getDockerDriverGatewayEndpoint()).toBe("http://127.0.0.1:8081");
    await helpers.isGatewayHttpReady();
    helpers.getGatewayClusterImageDrift();
    expect(probeGatewayHttpReady).toHaveBeenLastCalledWith(
      undefined,
      "http://127.0.0.1:8081/",
      undefined,
      undefined,
    );
    expect(getGatewayClusterImageDrift).toHaveBeenLastCalledWith({
      gatewayName: "nemoclaw-8081",
    });
  });

  it("preserves explicit probe URLs and injects the bound default wait probe", async () => {
    const probeGatewayHttpReady = vi.fn(async () => true);
    const waitForGatewayHttpReadyBase = vi.fn(async (options) => {
      expect(options.probe).toBeTypeOf("function");
      return options.probe?.();
    });
    const helpers = createDynamicGatewayRuntimeHelpers({
      getGatewayName: () => "nemoclaw-9090",
      getGatewayPort: () => 9090,
      getDockerDriverGatewayEndpoint: (port) => `http://127.0.0.1:${port}`,
      getGatewayClusterImageDrift: vi.fn(() => null),
      probeGatewayHttpReady,
      probeDockerDriverGatewayHttpReady: vi.fn(async () => true),
      waitForGatewayHttpReadyBase,
      probeGatewayTcpReady: vi.fn(async () => true),
    });

    await helpers.isGatewayHttpReady(25, "https://probe.example/health", "POST");
    expect(probeGatewayHttpReady).toHaveBeenLastCalledWith(
      25,
      "https://probe.example/health",
      "POST",
      undefined,
    );
    await expect(helpers.waitForGatewayHttpReady()).resolves.toBe(true);
    expect(probeGatewayHttpReady).toHaveBeenLastCalledWith(
      undefined,
      "http://127.0.0.1:9090/",
      undefined,
      undefined,
    );
  });

  it("forwards explicit HTTP readiness abort signals", async () => {
    const probeGatewayHttpReady = vi.fn(async () => true);
    const helpers = createDynamicGatewayRuntimeHelpers({
      getGatewayName: () => "nemoclaw-9090",
      getGatewayPort: () => 9090,
      getDockerDriverGatewayEndpoint: (port) => `http://127.0.0.1:${port}`,
      getGatewayClusterImageDrift: vi.fn(() => null),
      probeGatewayHttpReady,
      probeDockerDriverGatewayHttpReady: vi.fn(async () => true),
      waitForGatewayHttpReadyBase: vi.fn(async () => true),
      probeGatewayTcpReady: vi.fn(async () => true),
    });
    const controller = new AbortController();

    await helpers.isGatewayHttpReady(25, "https://probe.example/health", "POST", controller.signal);

    expect(probeGatewayHttpReady).toHaveBeenLastCalledWith(
      25,
      "https://probe.example/health",
      "POST",
      controller.signal,
    );
  });
});

describe("gateway-binding resolver (#4422)", () => {
  it("keeps the bare nemoclaw names for the default gateway port", () => {
    expect(resolveGatewayName(DEFAULT_GATEWAY_PORT)).toBe(BASE_GATEWAY_NAME);
    expect(resolveGatewayStateDirName(DEFAULT_GATEWAY_PORT)).toBe(BASE_GATEWAY_STATE_DIR_NAME);
    expect(resolveGatewayCompatContainerName(DEFAULT_GATEWAY_PORT)).toBe(
      BASE_GATEWAY_COMPAT_CONTAINER_NAME,
    );
  });

  it("suffixes the name, state dir, and compat container for a non-default port", () => {
    expect(resolveGatewayName(8081)).toBe("nemoclaw-8081");
    expect(resolveGatewayPortFromName("nemoclaw-8081")).toBe(8081);
    expect(resolveGatewayStateDirName(8081)).toBe("openshell-docker-gateway-8081");
    expect(resolveGatewayCompatContainerName(8081)).toBe("nemoclaw-openshell-gateway-8081");
  });

  it("rejects malformed gateway names when resolving a port", () => {
    expect(resolveGatewayPortFromName("nemoclaw")).toBe(DEFAULT_GATEWAY_PORT);
    expect(resolveGatewayPortFromName("nemoclaw-0")).toBeNull();
    expect(resolveGatewayPortFromName("nemoclaw-65536")).toBeNull();
    expect(resolveGatewayPortFromName("other-8081")).toBeNull();
  });

  it("derives distinct bindings for two different gateway ports", () => {
    const a = 8080;
    const b = 8081;
    expect(resolveGatewayName(a)).not.toBe(resolveGatewayName(b));
    expect(resolveGatewayStateDirName(a)).not.toBe(resolveGatewayStateDirName(b));
    expect(resolveGatewayCompatContainerName(a)).not.toBe(resolveGatewayCompatContainerName(b));
  });
});

describe("resolveSandboxGatewayName", () => {
  it("returns the persisted gatewayName when present", () => {
    expect(resolveSandboxGatewayName({ gatewayName: "nemoclaw-9090", gatewayPort: 9090 })).toBe(
      "nemoclaw-9090",
    );
  });

  it("derives from gatewayPort when a valid persisted gatewayName conflicts", () => {
    expect(resolveSandboxGatewayName({ gatewayName: "nemoclaw-9090", gatewayPort: 8081 })).toBe(
      "nemoclaw-8081",
    );
  });

  it("derives the gateway name from gatewayPort when gatewayName is absent", () => {
    expect(resolveSandboxGatewayName({ gatewayPort: 8081 })).toBe("nemoclaw-8081");
    expect(resolveSandboxGatewayName({ gatewayPort: 8080 })).toBe(BASE_GATEWAY_NAME);
  });

  it("falls back to the bare base name for legacy sandbox entries with neither field set", () => {
    expect(resolveSandboxGatewayName({})).toBe(BASE_GATEWAY_NAME);
    expect(resolveSandboxGatewayName(null)).toBe(BASE_GATEWAY_NAME);
    expect(resolveSandboxGatewayName(undefined)).toBe(BASE_GATEWAY_NAME);
  });

  it("ignores null persisted values and falls back through the resolution chain", () => {
    expect(resolveSandboxGatewayName({ gatewayName: null, gatewayPort: 8081 })).toBe(
      "nemoclaw-8081",
    );
    expect(resolveSandboxGatewayName({ gatewayName: null, gatewayPort: null })).toBe(
      BASE_GATEWAY_NAME,
    );
  });

  it("returns distinct names for sandboxes on different non-default ports", () => {
    expect(resolveSandboxGatewayName({ gatewayPort: 8081 })).not.toBe(
      resolveSandboxGatewayName({ gatewayPort: 8090 }),
    );
  });

  it("falls through to a valid port when only the persisted gatewayName is out-of-namespace", () => {
    // A tampered name with a still-valid port resolves from the port so the
    // operation lands on a real NemoClaw gateway rather than the tampered string.
    expect(resolveSandboxGatewayName({ gatewayName: "rogue-gateway", gatewayPort: 8081 })).toBe(
      "nemoclaw-8081",
    );
  });

  it("throws on an invalid persisted gatewayName when no valid port is present", () => {
    // Refuse to silently rewrite destroy/snapshot to the default gateway when
    // the persisted binding is present but unusable.
    expect(() => resolveSandboxGatewayName({ gatewayName: "../etc/passwd" })).toThrow(
      /Invalid persisted sandbox gateway binding/,
    );
    expect(() => resolveSandboxGatewayName({ gatewayName: "nemoclaw evil" })).toThrow(
      /Invalid persisted sandbox gateway binding/,
    );
    expect(() => resolveSandboxGatewayName({ gatewayName: "nemoclaw-0" })).toThrow(
      /Invalid persisted sandbox gateway binding/,
    );
    expect(() => resolveSandboxGatewayName({ gatewayName: "nemoclaw-65536" })).toThrow(
      /Invalid persisted sandbox gateway binding/,
    );
  });

  it("throws on an out-of-range or non-integer persisted gatewayPort", () => {
    expect(() => resolveSandboxGatewayName({ gatewayPort: 0 })).toThrow(
      /Invalid persisted sandbox gateway binding/,
    );
    expect(() => resolveSandboxGatewayName({ gatewayPort: -1 })).toThrow(
      /Invalid persisted sandbox gateway binding/,
    );
    expect(() => resolveSandboxGatewayName({ gatewayPort: 65536 })).toThrow(
      /Invalid persisted sandbox gateway binding/,
    );
    expect(() => resolveSandboxGatewayName({ gatewayPort: 8081.5 })).toThrow(
      /Invalid persisted sandbox gateway binding/,
    );
    expect(() => resolveSandboxGatewayName({ gatewayPort: Number.NaN })).toThrow(
      /Invalid persisted sandbox gateway binding/,
    );
  });

  it("accepts the canonical bare base gateway name", () => {
    expect(resolveSandboxGatewayName({ gatewayName: "nemoclaw" })).toBe(BASE_GATEWAY_NAME);
  });

  it("rejects the non-canonical default-port suffix form", () => {
    // `nemoclaw-8080` matches the namespace regex but is not what
    // resolveGatewayName(8080) emits (it emits the bare `nemoclaw`). A
    // sandbox registered against the non-canonical form would target a
    // gateway name that does not exist.
    expect(() => resolveSandboxGatewayName({ gatewayName: "nemoclaw-8080" })).toThrow(
      /Invalid persisted sandbox gateway binding/,
    );
  });
});

describe("resolveCoreOnboardGatewayBinding", () => {
  const currentGateway = { name: "nemoclaw", port: DEFAULT_GATEWAY_PORT };

  it("prefers the authoritative rebuild handoff when the registry row is gone", () => {
    expect(
      resolveCoreOnboardGatewayBinding({
        authoritativeGateway: { name: "nemoclaw-9090", port: 9090 },
        currentGateway,
        resume: true,
        sandbox: null,
      }),
    ).toEqual({ name: "nemoclaw-9090", port: 9090 });
  });

  it("uses the registered sandbox binding for an ordinary resume", () => {
    expect(
      resolveCoreOnboardGatewayBinding({
        currentGateway,
        resume: true,
        sandbox: { gatewayName: "nemoclaw-9090", gatewayPort: 9090 },
      }),
    ).toEqual({ name: "nemoclaw-9090", port: 9090 });
  });

  it("keeps the requested gateway for fresh or pre-registration flows", () => {
    expect(
      resolveCoreOnboardGatewayBinding({
        currentGateway: { name: "nemoclaw-9191", port: 9191 },
        resume: false,
        sandbox: { gatewayPort: 9090 },
      }),
    ).toEqual({ name: "nemoclaw-9191", port: 9191 });
    expect(
      resolveCoreOnboardGatewayBinding({
        currentGateway: { name: "nemoclaw-9191", port: 9191 },
        resume: true,
        sandbox: null,
      }),
    ).toEqual({ name: "nemoclaw-9191", port: 9191 });
  });

  it("uses the default for legacy rows and rejects invalid persisted bindings", () => {
    expect(resolveCoreOnboardGatewayBinding({ currentGateway, resume: true, sandbox: {} })).toEqual(
      { name: BASE_GATEWAY_NAME, port: DEFAULT_GATEWAY_PORT },
    );
    expect(() =>
      resolveCoreOnboardGatewayBinding({
        currentGateway,
        resume: true,
        sandbox: { gatewayName: "../other" },
      }),
    ).toThrow(/Invalid persisted sandbox gateway binding/);
  });
});

describe("docker-driver compat container is gateway-port scoped (#4422)", () => {
  function withTempState<T>(
    fn: (paths: { gatewayBin: string; sandboxBin: string; stateDir: string }) => T,
  ): T {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-binding-"));
    const gatewayBin = path.join(dir, "openshell-gateway");
    const sandboxBin = path.join(dir, "openshell-sandbox");
    const stateDir = path.join(dir, "state");
    try {
      fs.writeFileSync(gatewayBin, "GLIBC_2.39\n", { mode: 0o755 });
      fs.writeFileSync(sandboxBin, "#!/bin/sh\n", { mode: 0o755 });
      fs.mkdirSync(stateDir);
      return fn({ gatewayBin, sandboxBin, stateDir });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it("names the compat container per gateway port so a second sandbox does not target the first container", () => {
    withTempState(({ gatewayBin, sandboxBin, stateDir }) => {
      const launch = buildDockerDriverGatewayLaunch({
        gatewayBin,
        sandboxBin,
        stateDir,
        platform: "linux",
        env: { NEMOCLAW_OPENSHELL_GATEWAY_CONTAINER_PATCH: "1" },
        gatewayEnv: { OPENSHELL_DRIVERS: "docker" },
        compatContainerName: resolveGatewayCompatContainerName(8081),
      });

      expect(launch.mode).toBe("container");
      expect(launch.containerName).toBe("nemoclaw-openshell-gateway-8081");
      const nameIdx = launch.args.indexOf("--name");
      expect(nameIdx).toBeGreaterThanOrEqual(0);
      expect(launch.args[nameIdx + 1]).toBe("nemoclaw-openshell-gateway-8081");
    });
  });

  it("lets the per-port name win over a process-wide env override", () => {
    withTempState(({ gatewayBin, sandboxBin, stateDir }) => {
      const launch = buildDockerDriverGatewayLaunch({
        gatewayBin,
        sandboxBin,
        stateDir,
        platform: "linux",
        env: {
          NEMOCLAW_OPENSHELL_GATEWAY_CONTAINER_PATCH: "1",
          NEMOCLAW_OPENSHELL_GATEWAY_COMPAT_CONTAINER_NAME: "custom-gw",
        },
        gatewayEnv: { OPENSHELL_DRIVERS: "docker" },
        compatContainerName: resolveGatewayCompatContainerName(8081),
      });

      // The per-port name must win so the env var cannot collapse isolation (#4422).
      expect(launch.containerName).toBe("nemoclaw-openshell-gateway-8081");
    });
  });

  it("honors the env container name override when no per-port name is supplied", () => {
    withTempState(({ gatewayBin, sandboxBin, stateDir }) => {
      const launch = buildDockerDriverGatewayLaunch({
        gatewayBin,
        sandboxBin,
        stateDir,
        platform: "linux",
        env: {
          NEMOCLAW_OPENSHELL_GATEWAY_CONTAINER_PATCH: "1",
          NEMOCLAW_OPENSHELL_GATEWAY_COMPAT_CONTAINER_NAME: "custom-gw",
        },
        gatewayEnv: { OPENSHELL_DRIVERS: "docker" },
      });

      expect(launch.containerName).toBe("custom-gw");
    });
  });
});

describe("per-port gateway runtime markers stay isolated (#4422)", () => {
  // Regression for the singleton state dir teardown: two sandboxes onboarded
  // on distinct NEMOCLAW_GATEWAY_PORT values resolve to distinct state dirs, so
  // creating the second neither overwrites nor invalidates the first sandbox's
  // runtime marker.
  function markerInput(port: number, pid: number) {
    return {
      pid,
      desiredEnv: { OPENSHELL_GATEWAY_PORT: String(port) },
      endpoint: `https://127.0.0.1:${port}`,
      gatewayBin: "/usr/bin/openshell-gateway",
      openshellVersion: "0.0.44",
      dockerHost: null,
    };
  }

  it("preserves the first sandbox gateway marker when a second sandbox onboards on another port", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-marker-"));
    try {
      const firstPort = 8080;
      const secondPort = 8081;
      const firstDir = path.join(root, resolveGatewayStateDirName(firstPort));
      const secondDir = path.join(root, resolveGatewayStateDirName(secondPort));

      // First sandbox writes its gateway marker (port 8080, pid 1111).
      writeDockerDriverGatewayRuntimeMarkerForStateDir(firstDir, markerInput(firstPort, 1111));

      // Second sandbox onboards on port 8081 — it writes to its own state dir.
      writeDockerDriverGatewayRuntimeMarkerForStateDir(secondDir, markerInput(secondPort, 2222));

      // The two markers live in distinct files.
      expect(getDockerDriverGatewayRuntimeMarkerPath(firstDir)).not.toBe(
        getDockerDriverGatewayRuntimeMarkerPath(secondDir),
      );

      // The first sandbox's marker is untouched: still port 8080, pid 1111.
      const firstMarker = readDockerDriverGatewayRuntimeMarker(
        getDockerDriverGatewayRuntimeMarkerPath(firstDir),
      );
      expect(firstMarker?.endpoint).toBe("https://127.0.0.1:8080");
      expect(firstMarker?.pid).toBe(1111);

      // And it still validates against what the first sandbox expects — no drift,
      // i.e. the second onboard did not tear down or retarget the first gateway.
      expect(
        getDockerDriverGatewayRuntimeMarkerDriftForStateDir(firstDir, markerInput(firstPort, 1111)),
      ).toBeNull();

      // The second sandbox's marker reflects its own port/pid independently.
      const secondMarker = readDockerDriverGatewayRuntimeMarker(
        getDockerDriverGatewayRuntimeMarkerPath(secondDir),
      );
      expect(secondMarker?.endpoint).toBe("https://127.0.0.1:8081");
      expect(secondMarker?.pid).toBe(2222);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
