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
  await import("../destroy-preflight");
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

async function setup(port = 19260) {
  vi.stubEnv("NEMOCLAW_GATEWAY_PORT", String(port));
  vi.resetModules();
  const session = await import("../../../state/onboard-session");
  const registry = await import("../../../state/registry");
  const docker = await import("../../../adapters/docker/run");
  const dockerTarget = await import("../../../adapters/docker/client-isolation");
  const presence = await import("../destroy-presence");
  const gateway = await import("../destroy-gateway");
  const { reconcileIdentityFreeRecovery } = await import("../destroy-preflight");
  const gatewayName = port === 8080 ? "nemoclaw" : `nemoclaw-${port}`;
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
  const runtime = vi
    .spyOn(gateway, "resolveGatewayCleanupRuntimeProviderId")
    .mockReturnValue("docker");
  const defaultDaemon = vi
    .spyOn(dockerTarget, "dockerContextIsDefaultFromBuild")
    .mockReturnValue(true);
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
    runtime,
    defaultDaemon,
    snapshot,
    run,
  };
}

describe.skipIf(process.platform !== "linux")("identity-free retained recovery", () => {
  it.each([8080, 19260])(
    "releases the retained sandbox name after verified absence on gateway port %s (#12260)",
    async (port) => {
      const h = await setup(port);
      expect(h.registry.getSandbox("alpha")?.gatewayPort).toBeUndefined();
      expect(h.record.sandboxIdentityFingerprint).toBeNull();

      expect(h.run()).toBe(true);

      expect(h.registry.getSandbox("alpha")).toBeNull();
      expect(h.session.listRetainedSandboxRecoveryRecords()).toEqual([]);
      expect(h.session.loadSession()).toMatchObject({
        status: "failed",
        sandboxName: null,
        cancellationRecovery: null,
      });
      expect(
        h.capture.mock.calls.every(([args]) => args[0] === "sandbox" && args[1] === "list"),
      ).toBe(true);
      expect(h.volumes.mock.calls.every(([args]) => args[2] === "volume" && args[3] === "ls")).toBe(
        true,
      );
      expect(
        h.registry.reserveSandboxInferenceRoute("alpha", {
          ...h.route,
          reservationSessionId: "new-session",
        }),
      ).toBe(true);
    },
  );

  it.each([
    ["failed", { status: 1, output: "", stdout: "[]", stderr: "connection refused" }],
    ["malformed", { status: 0, output: "invalid", stdout: "invalid", stderr: "" }],
    ["diagnostic", { status: 0, output: "[]", stdout: "[]", stderr: "partial result" }],
    [
      "present",
      {
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
      },
    ],
  ])("preserves state when the gateway observation is %s (#12260)", async (_label, observation) => {
    const h = await setup();
    const before = h.snapshot();
    h.capture.mockReturnValue(observation);

    expect(h.run).toThrow(/presence as/u);

    expect(h.snapshot()).toEqual(before);
  });

  it.each(["residual", "failed", "malformed"])(
    "preserves state for a %s container observation (#12260)",
    async (kind) => {
      const h = await setup();
      const before = h.snapshot();
      h.containers.mockReturnValue(
        kind === "failed"
          ? { status: "probe-failed", detail: "Docker unavailable" }
          : {
              status: "observed",
              malformedRows: kind === "malformed" ? 1 : 0,
              rows:
                kind === "residual"
                  ? [
                      {
                        id: "b".repeat(64),
                        managedBy: "openshell",
                        workspace: "default",
                        sandboxId: "sandbox-alpha",
                      },
                    ]
                  : [],
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

  it("pins container and volume observations to the default Docker daemon (#12260)", async () => {
    const h = await setup();
    h.containers.mockRestore();

    expect(h.run()).toBe(true);

    expect(
      h.volumes.mock.calls.some(
        ([args]) => args[0] === "--context" && args[1] === "default" && args[2] === "ps",
      ),
    ).toBe(true);
    expect(
      h.volumes.mock.calls.every(
        ([args]) =>
          args[0] === "--context" && args[1] === "default" && ["ps", "volume"].includes(args[2]!),
      ),
    ).toBe(true);
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

  it.each([null, "podman"])(
    "rejects unproven Docker absence for runtime %s (#12260)",
    async (runtime) => {
      const h = await setup();
      const before = h.snapshot();
      h.runtime.mockReturnValue(runtime);
      expect(h.run).toThrow(/owning Docker runtime/u);
      expect(h.snapshot()).toEqual(before);
    },
  );

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
    h.defaultDaemon.mockReturnValue(false);
    const before = h.snapshot();
    expect(h.run).toThrow(/default daemon/u);
    expect(h.snapshot()).toEqual(before);
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

  it("preserves metadata when the reservation gateway name and port conflict (#12260)", async () => {
    const h = await setup();
    expect(h.registry.updateSandbox("alpha", { gatewayPort: 8080 })).toBe(true);
    const before = h.snapshot();

    expect(h.run).toThrow(/conflicting gateway identity/u);

    expect(h.snapshot()).toEqual(before);
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.volumes).not.toHaveBeenCalled();
  });

  it("preserves a replacement session after registry retirement (#12260)", async () => {
    const h = await setup();
    h.registry.removeSandboxRouteReservationIfCurrent(h.registry.getSandbox("alpha")!);
    h.session.saveSession(
      h.session.createSession({
        sessionId: "replacement-session",
        sandboxName: "other-sandbox",
      }),
    );
    const replacement = fs.readFileSync(h.session.SESSION_FILE, "utf8");
    expect(h.run()).toBe(true);
    expect(fs.readFileSync(h.session.SESSION_FILE, "utf8")).toBe(replacement);
    expect(h.session.listRetainedSandboxRecoveryRecords()).toEqual([]);
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
    failure.mockRestore();

    expect(h.run()).toBe(true);
    expect(h.session.listRetainedSandboxRecoveryRecords()).toEqual([]);
  });
});
