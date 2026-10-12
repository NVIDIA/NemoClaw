// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let testHome: string;
const emptyDockerResult = {
  status: 0,
  stdout: "",
  stderr: "",
  pid: 0,
  output: [null, "", ""],
  signal: null,
};

beforeAll(async () => {
  // Load the shared CLI graph before timing recovery operations in each isolated state root.
  await import("../destroy");
});

beforeEach(() => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-recovery-metadata-"));
  vi.stubEnv("HOME", testHome);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(testHome, { recursive: true, force: true });
});

async function setup(port = 19260, dockerHost?: string) {
  vi.stubEnv("NEMOCLAW_GATEWAY_PORT", String(port));
  vi.stubEnv("DOCKER_HOST", dockerHost);
  vi.stubEnv("DOCKER_CONTEXT", "default");
  vi.resetModules();
  const dockerExec = await import("../../../adapters/docker/exec");
  vi.spyOn(dockerExec, "dockerSpawnSync").mockReturnValue({
    ...emptyDockerResult,
    stdout: "unix:///var/run/docker.sock",
  });
  const session = await import("../../../state/onboard-session");
  const registry = await import("../../../state/registry");
  const docker = await import("../../../adapters/docker/run");
  const presence = await import("../destroy-presence");
  const { reconcileIdentityFreeRecovery } = await import("../destroy-preflight");
  const gatewayName = port === 8080 ? "nemoclaw" : `nemoclaw-${port}`;
  const { resolveGatewayStateDirForPort } = await import("../../../onboard/gateway-binding");
  const {
    clearDockerDriverGatewayRuntimeMarker,
    writeDockerDriverGatewayRuntimeMarkerForStateDir,
  } = await import("../../../onboard/docker-driver-gateway-runtime-marker");
  const stateDir = resolveGatewayStateDirForPort({ home: testHome, port });
  const writeRuntime = (host: string | null, createdAt: string, runtimeProviderId = "docker") =>
    writeDockerDriverGatewayRuntimeMarkerForStateDir(stateDir, {
      pid: 4242,
      desiredEnv: {},
      endpoint: `https://127.0.0.1:${port}`,
      dockerHost: host,
      createdAt,
      runtimeProviderId,
    });
  writeRuntime(dockerHost ?? null, new Date(Date.now() - 1_000).toISOString());
  const route = {
    provider: "compatible-endpoint",
    model: "test-model",
    endpointUrl: null,
    credentialEnv: null,
    preferredInferenceApi: null,
    gatewayName,
    reservationSessionId: "failed-create-session",
  };
  session.saveSession(
    session.createSession({
      sessionId: route.reservationSessionId,
      sandboxName: "alpha",
      agent: "openclaw",
      provider: route.provider,
      model: route.model,
    }),
  );
  registry.reserveSandboxInferenceRoute("alpha", route);
  session.markRetainedSandboxRecovery("alpha", "identity lookup failed", undefined, {
    gatewayName,
    gatewayPort: port,
    lifecycleGeneration: "failed-generation",
    createAttemptNonce: "a".repeat(62),
  });
  const record = session.listRetainedSandboxRecoveryRecords()[0]!;
  const capture = vi
    .fn<typeof import("../../../adapters/openshell/runtime").captureOpenshell>()
    .mockReturnValue({
      status: 0,
      output: "[]",
      stdout: "[]",
      stderr: "",
    });
  const containers = vi.spyOn(presence, "observeDestroyContainerIdentity").mockReturnValue({
    status: "observed",
    rows: [],
    malformedRows: 0,
  });
  const volumes = vi.spyOn(docker, "dockerRun").mockReturnValue(emptyDockerResult);
  const files = [
    registry.REGISTRY_FILE,
    session.SESSION_FILE,
    session.RETAINED_SANDBOX_RECOVERY_FILE,
  ];
  const snapshot = () => files.map((file) => fs.readFileSync(file, "utf8"));
  const run = () =>
    reconcileIdentityFreeRecovery("alpha", session.listRetainedSandboxRecoveryRecords(), port, {
      session,
      registry,
      captureOpenshell: capture,
    });
  return {
    session,
    registry,
    route,
    record,
    capture,
    containers,
    volumes,
    clearRuntime: () => clearDockerDriverGatewayRuntimeMarker(stateDir),
    writeRuntime,
    snapshot,
    run,
  };
}

async function setupDestroy(port = 19260) {
  const h = await setup(port);
  const preflight = await import("../destroy-preflight");
  const reconcile = preflight.reconcileIdentityFreeRecovery;
  vi.spyOn(preflight, "reconcileIdentityFreeRecovery").mockImplementation(
    (name, records, port, state) =>
      reconcile(name, records, port, { ...state, captureOpenshell: h.capture }),
  );
  const ordinaryDestroy = vi
    .spyOn(preflight, "prepareSandboxDestroy")
    .mockRejectedValue(new Error("Unexpected resource cleanup during metadata recovery"));
  const confirmation = await import("../destroy-confirmation");
  vi.spyOn(confirmation, "confirmSandboxDestroy").mockResolvedValue(true);
  const exit = vi.spyOn(process, "exit").mockImplementation(((code: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { destroySandbox } = await import("../destroy");
  const { resolveNemoclawStateDir } = await import("../../../state/paths");
  const { enforceRemovedImmutabilityMigrationBoundary } =
    await import("../../../state/migrations/removed-immutability");
  const stateDir = resolveNemoclawStateDir();
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  return {
    ...h,
    destroy: () => destroySandbox("alpha", { yes: true }),
    ordinaryDestroy,
    exit,
    log,
    legacyState: path.join(stateDir, "shields-alpha.json"),
    assertMigrationClear: () => enforceRemovedImmutabilityMigrationBoundary("alpha"),
  };
}

describe.skipIf(process.platform !== "linux")("identity-free retained recovery", () => {
  it.each([8080, 19260])(
    "releases the retained name through destroy on gateway port %s without resource cleanup (#12260)",
    async (port) => {
      const h = await setupDestroy(port);
      h.writeRuntime(
        "unix:///var/run/docker.sock",
        new Date(Date.parse(h.record.recordedAt) - 1_000).toISOString(),
      );
      h.containers.mockRestore();
      expect(process.env.DOCKER_HOST).toBe("unix:///var/run/docker.sock");
      expect(process.env.DOCKER_CONTEXT).toBeUndefined();
      expect(h.registry.getSandbox("alpha")?.gatewayPort).toBeUndefined();
      expect(h.record.sandboxIdentityFingerprint).toBeNull();

      await expect(h.destroy()).resolves.toBeUndefined();

      expect(h.capture).toHaveBeenCalledWith(
        ["sandbox", "list", "-g", h.record.gatewayName, "--output", "json"],
        expect.objectContaining({ ignoreError: true, includeStreams: true }),
      );
      expect(h.registry.getSandbox("alpha")).toBeNull();
      expect(h.session.listRetainedSandboxRecoveryRecords()).toEqual([]);
      expect(h.session.loadSession()).toMatchObject({
        status: "failed",
        sandboxName: null,
        cancellationRecovery: null,
      });
      expect(h.ordinaryDestroy).not.toHaveBeenCalled();
      expect(h.exit).not.toHaveBeenCalled();
      expect(h.log).toHaveBeenCalledWith(
        "  Cleared retained recovery for 'alpha'. No sandbox resources were removed.",
      );
      expect(
        h.capture.mock.calls.every(([args]) => args[0] === "sandbox" && args[1] === "list"),
      ).toBe(true);
      expect(h.volumes.mock.calls.some(([args]) => args[2] === "ps")).toBe(true);
      expect(
        h.volumes.mock.calls.every(
          ([args]) =>
            args[0] === "--context" && args[1] === "default" && ["ps", "volume"].includes(args[2]!),
        ),
      ).toBe(true);
      expect(
        h.registry.reserveSandboxInferenceRoute("alpha", {
          ...h.route,
          reservationSessionId: "new-session",
        }),
      ).toBe(true);
    },
  );

  it("preserves recovery for retry when removed Shields state retirement fails (#12260)", async () => {
    const h = await setupDestroy();
    fs.writeFileSync(h.legacyState, "{}\n", { mode: 0o600 });
    expect(h.assertMigrationClear).toThrow(/state record from the removed Shields feature/u);
    const before = h.snapshot();
    const rename = fs.renameSync;
    const failure = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) =>
      String(source) === h.legacyState
        ? (() => {
            throw new Error("legacy state retirement unavailable");
          })()
        : rename(source, destination),
    );

    await expect(h.destroy()).rejects.toThrow("process.exit(1)");

    expect(h.snapshot()).toEqual(before);
    expect(fs.existsSync(h.legacyState)).toBe(true);
    expect(h.ordinaryDestroy).not.toHaveBeenCalled();
    expect(h.log).not.toHaveBeenCalledWith(expect.stringContaining("Cleared retained recovery"));
    failure.mockRestore();

    await expect(h.destroy()).resolves.toBeUndefined();

    expect(fs.existsSync(h.legacyState)).toBe(false);
    expect(h.registry.getSandbox("alpha")).toBeNull();
    expect(h.session.listRetainedSandboxRecoveryRecords()).toEqual([]);
    expect(h.ordinaryDestroy).not.toHaveBeenCalled();
    expect(h.assertMigrationClear).not.toThrow();
  });

  it("preserves legacy state and recovery when destroy cannot verify gateway absence (#12260)", async () => {
    const h = await setupDestroy();
    fs.writeFileSync(h.legacyState, "{}\n", { mode: 0o600 });
    expect(h.assertMigrationClear).toThrow(/state record from the removed Shields feature/u);
    const before = h.snapshot();
    h.capture.mockReturnValue({ status: 1, output: "", stdout: "", stderr: "gateway unavailable" });

    await expect(h.destroy()).rejects.toThrow("process.exit(1)");

    expect(fs.existsSync(h.legacyState)).toBe(true);
    expect(h.snapshot()).toEqual(before);
    expect(h.volumes).not.toHaveBeenCalled();
    expect(h.ordinaryDestroy).not.toHaveBeenCalled();
  });

  it("preserves state when the gateway still reports the sandbox present (#12260)", async () => {
    const h = await setup();
    const before = h.snapshot();
    h.capture.mockReturnValue({
      status: 0,
      output: "",
      stdout: JSON.stringify([
        {
          id: "sandbox-alpha",
          name: "alpha",
          labels: {},
          phase: "Ready",
          created_at: "2026-10-08",
          resource_version: 1,
          current_policy_version: 1,
        },
      ]),
      stderr: "",
    });

    expect(h.run).toThrow(/presence as/u);

    expect(h.snapshot()).toEqual(before);
  });

  it.each(["residual", "failed"])(
    "preserves state for a %s container observation (#12260)",
    async (kind) => {
      const h = await setup();
      const before = h.snapshot();
      h.containers.mockReturnValue(
        kind === "failed"
          ? { status: "probe-failed", detail: "Docker unavailable" }
          : {
              status: "observed",
              malformedRows: 0,
              rows: [
                {
                  id: "b".repeat(64),
                  managedBy: "openshell",
                  workspace: "default",
                  sandboxId: "sandbox-alpha",
                },
              ],
            },
      );

      expect(h.run).toThrow(/container runtime/u);

      expect(h.snapshot()).toEqual(before);
    },
  );

  it.each(["nemoclaw-openclaw-state-v1-alpha", "nemoclaw-hermes-state-v1-alpha"])(
    "preserves the recovery record when volume %s remains (#12260)",
    async (volume) => {
      const h = await setup();
      const before = h.snapshot();
      h.volumes.mockReturnValue({ ...emptyDockerResult, stdout: `${volume}\n` });

      expect(h.run).toThrow(/volume absence/u);

      expect(h.snapshot()).toEqual(before);
    },
  );

  it("preserves state when volume inspection fails (#12260)", async () => {
    const h = await setup();
    const before = h.snapshot();
    h.volumes.mockReturnValue({ ...emptyDockerResult, status: 1, stderr: "unavailable" });
    expect(h.run).toThrow(/inspect retained volumes/u);
    expect(h.snapshot()).toEqual(before);
  });

  it("preserves sandbox-scoped provider ownership after sandbox absence (#12260)", async () => {
    const h = await setup();
    h.session.recordRetainedSandboxRecovery({
      ...h.record,
      resources: { ...h.record.resources, sandboxScopedProviders: ["alpha-provider"] },
    });
    const before = h.snapshot();
    expect(h.run).toThrow(/sandbox-scoped resources/u);
    expect(h.snapshot()).toEqual(before);
  });

  it("preserves recovery when the recorded Docker runtime marker is missing (#12260)", async () => {
    const h = await setup();
    h.registry.updateSandbox("alpha", { openshellDriver: "docker" });
    h.clearRuntime();
    const before = h.snapshot();
    expect(h.run).toThrow(/owning Docker runtime/u);
    expect(h.snapshot()).toEqual(before);
    expect(h.capture).not.toHaveBeenCalled();
  });

  it("preserves recovery owned by a different runtime provider (#12260)", async () => {
    const h = await setup();
    h.writeRuntime(null, new Date(Date.parse(h.record.recordedAt) - 1_000).toISOString(), "podman");
    const before = h.snapshot();
    expect(h.run).toThrow(/owning Docker runtime/u);
    expect(h.snapshot()).toEqual(before);
  });

  it("preserves records when more than one failed create uses the same name (#12260)", async () => {
    const h = await setup();
    h.session.recordRetainedSandboxRecovery({ ...h.record, createAttemptNonce: "b".repeat(62) });
    const before = h.snapshot();
    expect(h.run).toThrow(/exactly one/u);
    expect(h.snapshot()).toEqual(before);
  });

  it("preserves a reservation owned by another session (#12260)", async () => {
    const h = await setup();
    h.session.saveSession({ ...h.session.loadSession()!, sessionId: "replacement-session" });
    const before = h.snapshot();
    expect(h.run).toThrow(/conflicting ownership/u);
    expect(h.snapshot()).toEqual(before);
  });

  it("preserves identity-free recovery while the session is still in progress (#12260)", async () => {
    const h = await setup();
    h.session.saveSession(
      h.session.createSession({
        sessionId: h.route.reservationSessionId,
        sandboxName: "alpha",
      }),
    );
    const before = h.snapshot();
    expect(h.run).toThrow(/conflicting ownership/u);
    expect(h.snapshot()).toEqual(before);
  });

  it("preserves metadata when Docker targets another daemon (#12260)", async () => {
    const h = await setup();
    vi.stubEnv("DOCKER_HOST", "unix:///tmp/other-docker.sock");
    const before = h.snapshot();
    expect(h.run).toThrow(/default daemon/u);
    expect(h.snapshot()).toEqual(before);
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.containers).not.toHaveBeenCalled();
    expect(h.volumes).not.toHaveBeenCalled();
  });

  it("preserves recovery created on another Docker daemon (#12260)", async () => {
    const h = await setup(19260, "unix:///tmp/other-docker.sock");
    vi.stubEnv("DOCKER_HOST", "unix:///var/run/docker.sock");
    const before = h.snapshot();

    expect(h.run).toThrow(/owning Docker runtime/u);

    expect(h.snapshot()).toEqual(before);
    expect(h.capture).not.toHaveBeenCalled();
  });

  it("preserves recovery after its gateway is replaced on the default daemon (#12260)", async () => {
    const h = await setup(19260, "unix:///tmp/other-docker.sock");
    vi.stubEnv("DOCKER_HOST", "unix:///var/run/docker.sock");
    h.writeRuntime(null, new Date(Date.parse(h.record.recordedAt) + 1_000).toISOString());
    const before = h.snapshot();

    expect(h.run).toThrow(/owning Docker runtime/u);

    expect(h.snapshot()).toEqual(before);
    expect(h.capture).not.toHaveBeenCalled();
  });

  it("preserves recovery when its gateway differs from the owning registry root (#12260)", async () => {
    const h = await setup();
    const before = h.snapshot();
    const { reconcileIdentityFreeRecovery } = await import("../destroy-preflight");
    expect(() =>
      reconcileIdentityFreeRecovery("alpha", [h.record], 8080, {
        session: h.session,
        registry: h.registry,
        captureOpenshell: h.capture,
      }),
    ).toThrow(/recovery gateway/u);
    expect(h.snapshot()).toEqual(before);
  });

  it("preserves a changed recovery record after successful absence probes (#12260)", async () => {
    const h = await setup();
    h.capture.mockImplementationOnce(() => {
      h.session.recordRetainedSandboxRecovery({
        ...h.record,
        resources: {
          ...h.record.resources,
          sandboxScopedProviders: ["alpha-provider"],
        },
      });
      return { status: 0, output: "[]", stdout: "[]", stderr: "" };
    });
    expect(h.run).toThrow(/recovery record changed/u);
    expect(h.registry.getSandbox("alpha")).not.toBeNull();
    expect(
      h.session.listRetainedSandboxRecoveryRecords()[0]?.resources.sandboxScopedProviders,
    ).toEqual(["alpha-provider"]);
  });

  it("preserves recovery when its gateway changes during absence probes (#12260)", async () => {
    const h = await setup();
    const before = h.snapshot();
    h.capture.mockImplementationOnce(() => {
      h.writeRuntime(null, new Date(Date.parse(h.record.recordedAt) + 1_000).toISOString());
      return { status: 0, output: "[]", stdout: "[]", stderr: "" };
    });

    expect(h.run).toThrow(/owning Docker runtime/u);

    expect(h.capture).toHaveBeenCalledTimes(2);
    expect(h.snapshot()).toEqual(before);
  });

  it("preserves metadata when the reservation gateway name and port conflict (#12260)", async () => {
    const h = await setup();
    expect(h.registry.updateSandbox("alpha", { gatewayPort: 8080 })).toBe(true);
    const before = h.snapshot();

    expect(h.run).toThrow(/conflicting gateway identity/u);

    expect(h.snapshot()).toEqual(before);
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.volumes).not.toHaveBeenCalled();
  });

  it("preserves a registry replacement that appears during absence verification (#12260)", async () => {
    const h = await setup();
    h.capture.mockImplementationOnce(() => {
      h.registry.removeSandboxRouteReservationIfCurrent(h.registry.getSandbox("alpha")!);
      h.registry.reserveSandboxInferenceRoute("alpha", {
        ...h.route,
        model: "replacement",
        reservationSessionId: "replacement-session",
      });
      return { status: 0, output: "[]", stdout: "[]", stderr: "" };
    });
    expect(h.run).toThrow(/registry changed/u);
    expect(h.registry.getSandbox("alpha")?.model).toBe("replacement");
    expect(h.session.listRetainedSandboxRecoveryRecords()).toEqual([h.record]);
  });

  it("preserves recovery when absence cannot be confirmed again before retirement (#12260)", async () => {
    const h = await setup();
    const before = h.snapshot();
    h.capture.mockReturnValueOnce({ status: 0, output: "[]", stdout: "[]", stderr: "" });
    h.capture.mockReturnValue({ status: 1, output: "", stdout: "", stderr: "gateway lost" });
    expect(h.run).toThrow(/presence as unknown/u);
    expect(h.snapshot()).toEqual(before);
  });

  it("finishes on retry after recovery record retirement fails (#12260)", async () => {
    const h = await setup();
    const { hasIdentityFreeRetainedRecovery } = await import("../../../registry-recovery-action");
    const rename = fs.renameSync;
    const failure = vi.spyOn(fs, "renameSync").mockImplementation((source, destination) =>
      String(destination) === h.session.RETAINED_SANDBOX_RECOVERY_FILE
        ? (() => {
            throw new Error("recovery storage unavailable");
          })()
        : rename(source, destination),
    );
    expect(h.run).toThrow(/storage unavailable/u);
    expect(h.registry.getSandbox("alpha")).toBeNull();
    expect(h.session.loadSession()?.cancellationRecovery).toBeNull();
    expect(h.session.listRetainedSandboxRecoveryRecords()).toEqual([h.record]);
    expect(hasIdentityFreeRetainedRecovery("alpha")).toBe(true);
    failure.mockRestore();
    h.session.saveSession(
      h.session.createSession({ sessionId: "replacement-session", sandboxName: "other-sandbox" }),
    );
    const replacement = fs.readFileSync(h.session.SESSION_FILE, "utf8");

    expect(h.run()).toBe(true);
    expect(fs.readFileSync(h.session.SESSION_FILE, "utf8")).toBe(replacement);
    expect(h.session.listRetainedSandboxRecoveryRecords()).toEqual([]);
    expect(hasIdentityFreeRetainedRecovery("alpha")).toBe(false);
  });

  it("does not admit destroy from recovery retained in another gateway root (#12260)", async () => {
    const h = await setup(19260);
    const before = h.snapshot();
    vi.stubEnv("NEMOCLAW_GATEWAY_PORT", "8080");
    vi.resetModules();
    const { hasIdentityFreeRetainedRecovery } = await import("../../../registry-recovery-action");

    expect(hasIdentityFreeRetainedRecovery("alpha")).toBe(false);
    expect(h.snapshot()).toEqual(before);
  });
});
