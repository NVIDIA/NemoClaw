// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { PodmanBoundContainerEngine } from "../../adapters/podman";
import { createPodmanPrivilegedSandboxControl } from "./podman-privileged-sandbox-control";
import { createCurrentPodmanRuntimeProviderBundle } from "./podman";
import {
  observePodmanManagedContainer,
  PODMAN_ISOLATION_ROLE_LABEL,
  PODMAN_MANAGED_LABEL,
  PODMAN_SANDBOX_CONTAINER_PREFIX,
  PODMAN_SANDBOX_ID_LABEL,
  PODMAN_SANDBOX_NAME_LABEL,
  PODMAN_SANDBOX_NAMESPACE,
  PODMAN_SANDBOX_NAMESPACE_LABEL,
  PODMAN_SANDBOX_WORKSPACE,
  PODMAN_SANDBOX_WORKSPACE_LABEL,
} from "./podman-lifecycle";
import {
  capturePodmanDestroyIdentity,
  capturePodmanDestroyIdentityByName,
  createPodmanRuntimeProviderSnapshotSurface,
  NATIVE_PODMAN_SANDBOX_HOST_ADDRESS,
  prepareNativePodmanGatewayHostRuntime,
  resolveNativePodmanSocketPath,
} from "./podman-runtime-surfaces";

const SANDBOX_NAME = "alpha";
const SANDBOX_ID = "sandbox-alpha";
const CONTAINER_ID = "a".repeat(64);

function runtimeEngine(labels: () => Readonly<Record<string, string>>): PodmanBoundContainerEngine {
  return {
    operation: "gateway-inspection",
    engineId: "podman",
    displayName: "Podman",
    authorityId: "podman:test-runtime",
    endpointAuthorityId: "podman-path-sha256:test",
    assertAuthority: vi.fn(),
    capture: vi.fn((args: readonly string[]) => {
      const handlers: Readonly<
        Record<string, () => { status: number; stdout: string; stderr: string }>
      > = {
        ps: () => ({ status: 0, stdout: `${CONTAINER_ID}\n`, stderr: "" }),
        "container inspect": () => ({
          status: 0,
          stdout: JSON.stringify([
            {
              Id: CONTAINER_ID,
              Name: `${PODMAN_SANDBOX_CONTAINER_PREFIX}${SANDBOX_NAME}-${SANDBOX_ID}`,
              Config: { Labels: labels() },
              State: {
                Running: true,
                Paused: false,
                Status: "running",
                StartedAt: "2026-08-22T00:00:00Z",
              },
              HostConfig: {},
              Annotations: {},
            },
          ]),
          stderr: "",
        }),
      };
      const command = args[0] === "ps" ? "ps" : args.slice(0, 2).join(" ");
      return (
        handlers[command] ??
        (() => ({
          status: 125,
          stdout: "",
          stderr: "unexpected command",
        }))
      )();
    }),
    captureHost: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
  };
}

function sandbox() {
  return { name: SANDBOX_NAME, agent: "openclaw" as const, openshellDriver: "podman" };
}

function exactLabels(): Readonly<Record<string, string>> {
  return {
    [PODMAN_MANAGED_LABEL]: "true",
    [PODMAN_SANDBOX_ID_LABEL]: SANDBOX_ID,
    [PODMAN_SANDBOX_NAME_LABEL]: SANDBOX_NAME,
    [PODMAN_SANDBOX_NAMESPACE_LABEL]: PODMAN_SANDBOX_NAMESPACE,
    [PODMAN_SANDBOX_WORKSPACE_LABEL]: PODMAN_SANDBOX_WORKSPACE,
  };
}

describe("current Podman runtime provider", () => {
  it("preserves private transport bounds while resolving the current engine", async () => {
    vi.resetModules();
    const capture = vi.fn(() => ({ status: 0, stdout: "ok", stderr: "" }));
    vi.doMock("../../adapters/podman", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../../adapters/podman")>();
      return {
        ...actual,
        capturePodmanSocketAuthority: vi.fn(() => ({})),
        createPodmanContainerEngine: vi.fn(
          () =>
            ({
              operation: "sandbox-lifecycle",
              engineId: "podman",
              displayName: "Podman",
              authorityId: "podman:test-current",
              endpointAuthorityId: "podman-path-sha256:test-current",
              capture,
              captureHost: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
              assertAuthority: vi.fn(),
            }) satisfies PodmanBoundContainerEngine,
        ),
      };
    });

    try {
      const { createCurrentPodmanOperationEngine } = await import("./podman-runtime-surfaces");
      const engine = createCurrentPodmanOperationEngine("sandbox-lifecycle", {
        HOME: "/tmp/nemoclaw-test-home",
        PATH: "/usr/bin:/bin",
        XDG_RUNTIME_DIR: "/run/user/1000",
      });
      const input = Buffer.from("private startup state", "utf8");
      const privateTransport = { maxInputBytes: 4096, maxOutputBytes: 8192 };

      expect(
        engine.capture(["container", "exec", "sandbox"], 12_345, input, privateTransport),
      ).toEqual({ status: 0, stdout: "ok", stderr: "" });
      expect(capture).toHaveBeenCalledWith(
        ["container", "exec", "sandbox"],
        12_345,
        input,
        privateTransport,
      );
    } finally {
      vi.doUnmock("../../adapters/podman");
      vi.resetModules();
    }
  });

  it("binds destroy continuity to the full Podman ownership identity", () => {
    let labels = exactLabels();
    const engine = runtimeEngine(() => labels);
    const first = capturePodmanDestroyIdentity(
      { sandbox: sandbox(), sandboxName: SANDBOX_NAME },
      engine,
    );
    labels = { ...labels, "test.identity-drift": "true" };
    const changed = capturePodmanDestroyIdentity(
      { sandbox: sandbox(), sandboxName: SANDBOX_NAME },
      engine,
    );

    expect(first.resourceHandle).toBe(CONTAINER_ID);
    expect(first.ownershipSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(changed.resourceHandle).toBe(first.resourceHandle);
    expect(changed.ownershipSha256).not.toBe(first.ownershipSha256);
    expect(capturePodmanDestroyIdentityByName(SANDBOX_NAME, engine)).toEqual(changed);
  });

  it("rejects snapshot observation outside the exact OpenShell workspace", () => {
    const labels = {
      ...exactLabels(),
      [PODMAN_SANDBOX_WORKSPACE_LABEL]: "another-workspace",
    };
    const surface = createPodmanRuntimeProviderSnapshotSurface(runtimeEngine(() => labels));
    expect(surface.supported).toBe(true);
    const supported = surface as Extract<typeof surface, { readonly supported: true }>;

    expect(() => supported.preflight("backup", sandbox())).toThrow(
      `${PODMAN_SANDBOX_WORKSPACE_LABEL}=${PODMAN_SANDBOX_WORKSPACE}`,
    );
  });

  it("does not inspect after container lookup exhausts the shared snapshot timeout", () => {
    let nowMs = 1_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const engine = runtimeEngine(() => exactLabels());
    vi.mocked(engine.capture).mockImplementation(() => {
      nowMs = 2_000;
      return { status: 0, stdout: `${CONTAINER_ID}\n`, stderr: "" };
    });
    const surface = createPodmanRuntimeProviderSnapshotSurface(engine);
    const supported = surface as Extract<typeof surface, { readonly supported: true }>;

    expect(() => supported.preflight("backup", sandbox(), 1_000)).toThrow(
      "Podman runtime observation deadline expired",
    );
    expect(engine.capture).not.toHaveBeenCalledWith(
      expect.arrayContaining(["container", "inspect"]),
      expect.anything(),
    );
    now.mockRestore();
  });

  it("does not inherit the portable Docker compatibility socket", () => {
    expect(
      resolveNativePodmanSocketPath({
        DOCKER_HOST: "unix:///tmp/portable-docker-compat.sock",
        XDG_RUNTIME_DIR: "/run/user/1000",
      }),
    ).toBe("/run/user/1000/podman/podman.sock");
  });

  it("loads the current Docker selection without a Podman host", async () => {
    const current = await import("./current");
    expect(
      current.resolveCurrentRuntimeProviderBundle("linux", "x64", undefined, {
        HOME: "/nonexistent/nemoclaw-podman-home",
        PATH: "/nonexistent/nemoclaw-podman-bin",
        OPENSHELL_PODMAN_SOCKET: "/nonexistent/run/podman/podman.sock",
      }).identity.id,
    ).toBe("docker");
  });

  it("registers without probing an absent Podman executable or socket", () => {
    const bundle = createCurrentPodmanRuntimeProviderBundle({
      HOME: "/nonexistent/nemoclaw-podman-home",
      PATH: "/nonexistent/nemoclaw-podman-bin",
      OPENSHELL_PODMAN_SOCKET: "/nonexistent/run/podman/podman.sock",
    });

    expect(bundle.identity.id).toBe("podman");
    expect(bundle.bootstrap).toMatchObject({ supported: false });
    expect(bundle.snapshot.supported).toBe(true);
    expect(bundle.recovery.supported).toBe(true);
    expect(bundle.cleanup.supported).toBe(true);
    expect(bundle.containerEngine).toMatchObject({
      supported: true,
      identities: expect.arrayContaining([
        expect.objectContaining({ operation: "host-doctor", engineId: "podman" }),
        expect.objectContaining({ operation: "external-image-preparation", engineId: "podman" }),
        expect.objectContaining({ operation: "gateway-inspection", engineId: "podman" }),
        expect.objectContaining({ operation: "host-local-inference", engineId: "podman" }),
        expect.objectContaining({ operation: "sandbox-lifecycle", engineId: "podman" }),
        expect.objectContaining({ operation: "workload-cleanup", engineId: "podman" }),
      ]),
    });
  });

  it("observes gateway topology without preparing host state (#10984)", () => {
    const environment = {
      HOME: "/nonexistent/nemoclaw-podman-home",
      PATH: "/nonexistent/nemoclaw-podman-bin",
      OPENSHELL_PODMAN_SOCKET: "/nonexistent/run/podman/podman.sock",
    };
    const bundle = createCurrentPodmanRuntimeProviderBundle(environment);
    const input = { environment, platform: "linux" as const };

    expect(bundle.gateway.observeHostRuntime(input)).toMatchObject({
      providerId: "podman",
      openShellDriver: "podman",
      portCheckHost: "0.0.0.0",
      socketPath: environment.OPENSHELL_PODMAN_SOCKET,
    });
    expect(() => bundle.gateway.prepareHostRuntime(input)).toThrow(
      /Inspecting the native Podman gateway address failed.*ENOENT/u,
    );
  });

  it("projects native gateway authority independently from the portable profile", () => {
    expect(
      prepareNativePodmanGatewayHostRuntime({
        environment: {
          OPENSHELL_PODMAN_SOCKET: "/run/user/1000/podman/podman.sock",
          NEMOCLAW_EXPERIMENTAL_PROFILE: "portable",
        },
        platform: "linux",
      }),
    ).toEqual({
      providerId: "podman",
      openShellDriver: "podman",
      bindAddress: "0.0.0.0",
      grpcHost: NATIVE_PODMAN_SANDBOX_HOST_ADDRESS,
      sshGatewayHost: "127.0.0.1",
      portCheckHost: "0.0.0.0",
      socketPath: "/run/user/1000/podman/podman.sock",
      requiredServerIpSans: [NATIVE_PODMAN_SANDBOX_HOST_ADDRESS],
      sandboxHostAddress: NATIVE_PODMAN_SANDBOX_HOST_ADDRESS,
      usesHostGatewayRoute: false,
      resourceOwnership: { label: "openshell.managed", value: "true" },
      gatewayConfig: {
        sandboxNamespace: "omitted",
        hostGatewayIp: NATIVE_PODMAN_SANDBOX_HOST_ADDRESS,
        includeSupervisorBin: false,
        driverConfigLayout: "inline-supervisor",
        processOwnership: "runtime-marker",
      },
      network: {
        sandboxSourceCidrs: expect.any(Function),
        inspect: expect.any(Function),
        usesHostGatewayRoute: expect.any(Function),
        run: expect.any(Function),
        ensureProbeImageCached: expect.any(Function),
      },
    });
  });

  it("establishes the native gateway address before projecting host runtime authority", () => {
    const order: string[] = [];
    const ip = vi
      .fn()
      .mockImplementationOnce(() => {
        order.push("inspect-absent");
        return { status: 0, stdout: "", stderr: "" };
      })
      .mockImplementationOnce(() => {
        order.push("inspect-configured");
        return { status: 0, stdout: "1: lo    inet 169.254.2.2/32 scope global lo\n", stderr: "" };
      });
    const sudo = vi.fn(() => {
      order.push("assign");
      return { status: 0, stdout: "", stderr: "" };
    });

    const runtime = prepareNativePodmanGatewayHostRuntime(
      {
        environment: { OPENSHELL_PODMAN_SOCKET: "/run/user/1000/podman/podman.sock" },
        platform: "linux",
      },
      runtimeEngine(exactLabels),
      { ip, sudo },
    );

    expect(runtime.grpcHost).toBe(NATIVE_PODMAN_SANDBOX_HOST_ADDRESS);
    expect(order).toEqual(["inspect-absent", "assign", "inspect-configured"]);
    expect(sudo).toHaveBeenCalledWith(
      ["--", "ip", "address", "replace", "169.254.2.2/32", "dev", "lo"],
      expect.any(Object),
    );
  });

  it("executes native gateway networking through the injected inspection authority", () => {
    const capture = vi.fn((args: readonly string[]) => ({
      status: 0,
      stdout:
        args[0] === "network" && args[1] === "inspect"
          ? JSON.stringify([{ subnets: [{ subnet: "10.89.0.0/24", gateway: "10.89.0.1" }] }])
          : "[]",
      stderr: "",
    }));
    const gatewayInspection = {
      operation: "gateway-inspection",
      engineId: "podman",
      displayName: "Podman",
      authorityId: "podman:test-gateway-inspection",
      endpointAuthorityId: "podman-path-sha256:test",
      capture,
      captureHost: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
      assertAuthority: vi.fn(),
    } as const satisfies PodmanBoundContainerEngine;
    const runtime = prepareNativePodmanGatewayHostRuntime(
      {
        environment: { OPENSHELL_PODMAN_SOCKET: "/run/user/1000/podman/podman.sock" },
        platform: "linux",
      },
      gatewayInspection,
    );

    expect(runtime.network.run(["network", "inspect", "openshell"], 7_500)).toMatchObject({
      status: 0,
      stdout: expect.stringContaining("10.89.0.0/24"),
    });
    expect(capture).toHaveBeenCalledWith(["network", "inspect", "openshell"], 7_500);
    expect(runtime.network.sandboxSourceCidrs()).toEqual([
      "10.89.0.0/24",
      `${NATIVE_PODMAN_SANDBOX_HOST_ADDRESS}/32`,
    ]);
    expect(capture).toHaveBeenCalledWith(["network", "inspect", "openshell-docker"], 30_000);
  });
});

describe("Podman split workload discovery", () => {
  it("excludes the supervisor companion before requiring one workload", () => {
    const engine = runtimeEngine(() => ({
      ...exactLabels(),
      [PODMAN_ISOLATION_ROLE_LABEL]: "sandbox",
    }));
    const capture = engine.capture;
    vi.mocked(engine.capture).mockImplementationOnce((args) => ({
      status: 0,
      stdout: args.includes("label!=openshell.ai/isolation-role=supervisor")
        ? CONTAINER_ID + "\n"
        : CONTAINER_ID + "\n" + "b".repeat(64) + "\n",
      stderr: "",
    }));
    expect(observePodmanManagedContainer(engine, SANDBOX_NAME)?.containerId).toBe(CONTAINER_ID);
    expect(capture).toHaveBeenCalledWith(
      ["container", "inspect", CONTAINER_ID],
      expect.any(Number),
    );
  });

  it("retains discovery of legacy workloads without an isolation role", () => {
    const engine = runtimeEngine(exactLabels);
    expect(observePodmanManagedContainer(engine, SANDBOX_NAME)?.containerId).toBe(CONTAINER_ID);
  });

  it.each(["supervisor", "unknown", ""])("rejects an inspected role of %j", (role) => {
    const engine = runtimeEngine(() => ({
      ...exactLabels(),
      [PODMAN_ISOLATION_ROLE_LABEL]: role,
    }));
    expect(() => observePodmanManagedContainer(engine, SANDBOX_NAME)).toThrow(
      "unexpected isolation role",
    );
  });

  it("rejects multiple workloads after excluding supervisors", () => {
    const engine = runtimeEngine(exactLabels);
    vi.mocked(engine.capture).mockReturnValueOnce({
      status: 0,
      stdout: CONTAINER_ID + "\n" + "b".repeat(64) + "\n",
      stderr: "",
    });
    expect(() => observePodmanManagedContainer(engine, SANDBOX_NAME)).toThrow(
      "has 2 managed containers",
    );
    expect(engine.capture).toHaveBeenCalledTimes(1);
  });
});

function workspaceFixture() {
  const wanted = { uid: 998, gid: 998, mode: 0o755 };
  const state = {
    labels: exactLabels(),
    metadata: { uid: 0, gid: 0, mode: 0o700, dev: "1", ino: "2", mtime: 100 },
    copyStatus: 0,
  };
  const observe = vi.fn();
  const engine = { ...runtimeEngine(() => state.labels), operation: "sandbox-lifecycle" as const };
  const capture = engine.capture;
  engine.capture = vi.fn((args, timeoutMs, input) => {
    switch (args.slice(0, 2).join(" ")) {
      case "container exec": {
        const stdout = JSON.stringify(state.metadata);
        observe();
        return { status: 0, stdout, stderr: "" };
      }
      case "container cp":
        state.metadata = { ...state.metadata, ...wanted };
        return { status: state.copyStatus, stdout: "", stderr: "" };
      default:
        return capture(args, timeoutMs, input);
    }
  });
  const control = createPodmanPrivilegedSandboxControl(engine);
  const prepare = () =>
    control.prepareManagedStartupWorkspace!({
      sandbox: sandbox(),
      sandboxName: SANDBOX_NAME,
      registeredSandboxNames: [SANDBOX_NAME],
      expectedResourceHandle: CONTAINER_ID,
      timeoutMs: 2000,
      workspace: wanted,
    });
  return { engine, state, wanted, prepare, observe };
}

describe("Podman managed workspace preparation", () => {
  it("restores only directory metadata through the pinned provider engine", () => {
    const { engine, state, wanted, prepare } = workspaceFixture();
    prepare();
    const copies = vi.mocked(engine.capture).mock.calls.filter(([args]) => args[1] === "cp");
    expect(copies).toHaveLength(1);
    expect(copies[0]?.[0]).toEqual([
      "container",
      "cp",
      "--archive=false",
      "-",
      `${CONTAINER_ID}:/`,
    ]);
    expect(copies[0]?.[1]).toBe(2000);
    const archive = copies[0]![2]!;
    expect(archive.length).toBe(1536);
    expect(archive.subarray(0, 8).toString()).toBe("sandbox/");
    expect(archive.subarray(512).equals(Buffer.alloc(1024))).toBe(true);
    expect(state.metadata).toEqual({ ...wanted, dev: "1", ino: "2", mtime: 100 });
  });

  it("leaves a workspace with matching metadata unchanged", () => {
    const { engine, state, wanted, prepare } = workspaceFixture();
    state.metadata = { ...state.metadata, ...wanted };
    prepare();
    expect(vi.mocked(engine.capture).mock.calls.some(([args]) => args[1] === "cp")).toBe(false);
  });

  it("rejects a failed metadata repair", () => {
    const { state, prepare } = workspaceFixture();
    state.copyStatus = 125;
    expect(prepare).toThrow(/could not be restored/u);
  });

  it("rechecks runtime ownership before the directory write", () => {
    const { engine, state, prepare, observe } = workspaceFixture();
    observe.mockImplementationOnce(() => {
      state.labels = { ...state.labels, [PODMAN_SANDBOX_WORKSPACE_LABEL]: "other" };
    });
    expect(prepare).toThrow();
    expect(vi.mocked(engine.capture).mock.calls.some(([args]) => args[1] === "cp")).toBe(false);
  });
});
