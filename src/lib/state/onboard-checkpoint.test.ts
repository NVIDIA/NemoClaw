// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { inspectCheckpoint, serializeCheckpoint } from "./onboard-checkpoint";
import {
  decisionDeclined,
  decisionFromLegacyNullable,
  decisionSelected,
  decisionsEqual,
  decisionUnset,
  isDecisionDeclined,
  isDecisionSelected,
  isDecisionUnset,
} from "./onboard-checkpoint-decision";
import {
  CHECKPOINT_SCHEMA_VERSION,
  type CheckpointSandboxRecreateTransaction,
  type OnboardCheckpoint,
} from "./onboard-checkpoint-types";

const ISO = "2026-01-01T00:00:00.000Z";

function baseCheckpoint(overrides: Partial<OnboardCheckpoint> = {}): OnboardCheckpoint {
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    profile: { kind: "selected", value: "default" },
    runtimeAuthority: { kind: "unset" },
    sessionId: "s1",
    machineState: "sandbox",
    updatedAt: ISO,
    sandboxIdentity: decisionSelected({ name: "my-sandbox", agent: "openclaw" }),
    webSearch: decisionUnset(),
    messaging: decisionUnset(),
    resourceProfile: decisionDeclined(),
    gatewayAuthority: decisionUnset(),
    effectGroups: { sandbox_create: { completedAt: ISO, fingerprint: "fp-create" } },
    bindings: {
      credentialEnvs: ["OPENAI_API_KEY"],
      registeredProviders: [
        { name: "web-search-p", type: "brave", credentialEnv: "BRAVE_API_KEY" },
      ],
    },
    sandboxRecreate: null,
    ...overrides,
  };
}

function recreateTransaction(): CheckpointSandboxRecreateTransaction {
  return {
    version: 1,
    id: "11111111-1111-4111-8111-111111111111",
    revision: 2,
    sandboxName: "my-sandbox",
    gatewayName: "nemoclaw-31818",
    gatewayPort: 31818,
    sourceRegistryFingerprint: "a".repeat(64),
    sourceLiveIdentityFingerprint: "b".repeat(64),
    sourceWorkload: {
      openshellDriver: "docker",
      imageTag: "openshell/sandbox-from:old",
      workload: {
        kind: "legacy-dockerfile",
        reference: "openshell/sandbox-from:old",
        shared: false,
      },
    },
    targetIntentFingerprint: "c".repeat(64),
    targetGeneration: "22222222-2222-4222-8222-222222222222",
    targetLiveIdentityFingerprint: null,
    phase: "creating",
    startedAt: ISO,
    updatedAt: ISO,
  };
}

function serializedRecreateCheckpoint(): Record<string, unknown> {
  return serializeCheckpoint(
    baseCheckpoint({
      gatewayAuthority: decisionSelected({
        gatewayName: "nemoclaw-31818",
        gatewayPort: 31818,
        mode: "nemoclaw-managed",
        source: "standalone",
        endpoint: null,
        stateDir: null,
        supervisor: null,
        requiredCapabilities: [],
      }),
      sandboxRecreate: recreateTransaction(),
    }),
  );
}

describe("checkpoint decision tri-state", () => {
  it("distinguishes unset, declined, and selected", () => {
    expect(isDecisionUnset(decisionUnset())).toBe(true);
    expect(isDecisionDeclined(decisionDeclined())).toBe(true);
    const selected = decisionSelected("v");
    expect(isDecisionSelected(selected)).toBe(true);
    expect(selected.kind === "selected" && selected.value).toBe("v");
  });

  it("collapses legacy null using the completion marker (#6227/#5783)", () => {
    const parse = (raw: string): string | null => (raw.length > 0 ? raw : null);
    // never reached -> unset
    expect(decisionFromLegacyNullable(false, null, parse)).toEqual(decisionUnset());
    expect(decisionFromLegacyNullable(false, "x", parse)).toEqual(decisionUnset());
    // completed with an explicit null -> declined
    expect(decisionFromLegacyNullable(true, null, parse)).toEqual(decisionDeclined());
    // completed with a valid value -> selected
    expect(decisionFromLegacyNullable(true, "value", parse)).toEqual(decisionSelected("value"));
    // completed with an invalid value -> declined, never a false selection
    expect(decisionFromLegacyNullable(true, "", parse)).toEqual(decisionDeclined());
  });

  it("compares decisions by kind and value", () => {
    expect(decisionsEqual(decisionUnset(), decisionUnset())).toBe(true);
    expect(decisionsEqual(decisionUnset(), decisionDeclined())).toBe(false);
    expect(decisionsEqual(decisionSelected("a"), decisionSelected("a"))).toBe(true);
    expect(decisionsEqual(decisionSelected("a"), decisionSelected("b"))).toBe(false);
  });
});

describe("checkpoint schema inspection", () => {
  it("returns none for absent payloads", () => {
    expect(inspectCheckpoint(undefined)).toEqual({ status: "none" });
    expect(inspectCheckpoint(null)).toEqual({ status: "none" });
  });

  it("fails safe on an unknown future schema version instead of treating it as fresh (#6228)", () => {
    const result = inspectCheckpoint({
      ...serializeCheckpoint(baseCheckpoint()),
      schemaVersion: 99,
    });
    expect(result).toEqual({ status: "unsupported_future", foundVersion: 99 });
  });

  it("treats malformed version or payload as corrupt, not missing", () => {
    expect(inspectCheckpoint({ schemaVersion: 0 })).toEqual({ status: "corrupt" });
    expect(inspectCheckpoint({ schemaVersion: "1" })).toEqual({ status: "corrupt" });
    expect(inspectCheckpoint("nope")).toEqual({ status: "corrupt" });
    expect(inspectCheckpoint({ schemaVersion: CHECKPOINT_SCHEMA_VERSION })).toEqual({
      status: "corrupt",
    });
  });

  it("loads and round-trips a valid current checkpoint", () => {
    const checkpoint = baseCheckpoint();
    const result = inspectCheckpoint(serializeCheckpoint(checkpoint));
    expect(result).toEqual({ status: "loaded", checkpoint });
  });

  it("round-trips the single portable profile and current-user Podman authority", () => {
    const checkpoint = baseCheckpoint({
      profile: { kind: "selected", value: "portable" },
      runtimeAuthority: {
        kind: "selected",
        value: {
          schemaVersion: 1,
          kind: "podman",
          ownership: "current-user",
          uid: 1000,
          homeDir: "/home/alice",
          configHome: "/home/alice/.config",
          runtimeDir: "/run/user/1000",
          socketPath: "/run/user/1000/podman/podman.sock",
        },
      },
    });

    expect(inspectCheckpoint(serializeCheckpoint(checkpoint))).toEqual({
      status: "loaded",
      checkpoint,
    });
  });

  it("rejects a portable configuration root outside the canonical OS home (#9035)", () => {
    const checkpoint = baseCheckpoint({
      profile: { kind: "selected", value: "portable" },
      runtimeAuthority: {
        kind: "selected",
        value: {
          schemaVersion: 1,
          kind: "podman",
          ownership: "current-user",
          uid: 1000,
          homeDir: "/home/alice",
          configHome: "/srv/alice-config",
          runtimeDir: "/run/user/1000",
          socketPath: "/run/user/1000/podman/podman.sock",
        },
      },
    });

    expect(inspectCheckpoint(serializeCheckpoint(checkpoint))).toEqual({ status: "corrupt" });
  });

  it.each([
    {
      label: "default profile with selected runtime authority",
      mutate: (checkpoint: Record<string, unknown>) => {
        checkpoint.runtimeAuthority = {
          kind: "selected",
          value: {
            schemaVersion: 1,
            kind: "podman",
            ownership: "current-user",
            uid: 1000,
            homeDir: "/home/alice",
            configHome: "/home/alice/.config",
            runtimeDir: "/run/user/1000",
            socketPath: "/run/user/1000/podman/podman.sock",
          },
        };
      },
    },
    {
      label: "portable profile without runtime authority",
      mutate: (checkpoint: Record<string, unknown>) => {
        checkpoint.profile = { kind: "selected", value: "portable" };
      },
    },
    {
      label: "socket outside the recorded runtime root",
      mutate: (checkpoint: Record<string, unknown>) => {
        checkpoint.profile = { kind: "selected", value: "portable" };
        checkpoint.runtimeAuthority = {
          kind: "selected",
          value: {
            schemaVersion: 1,
            kind: "podman",
            ownership: "current-user",
            uid: 1000,
            homeDir: "/home/alice",
            configHome: "/home/alice/.config",
            runtimeDir: "/run/user/1000",
            socketPath: "/run/user/10000/podman.sock",
          },
        };
      },
    },
    {
      label: "unknown nested key",
      mutate: (checkpoint: Record<string, unknown>) => {
        checkpoint.sandboxIdentity = {
          kind: "selected",
          value: { name: "my-sandbox", agent: "openclaw", unexpected: true },
        };
      },
    },
    {
      label: "unknown effect group",
      mutate: (checkpoint: Record<string, unknown>) => {
        checkpoint.effectGroups = { unexpected_effect: { completedAt: ISO, fingerprint: "x" } };
      },
    },
  ])("rejects invalid v4 cross-field authority: $label", ({ mutate }) => {
    const serialized = serializeCheckpoint(baseCheckpoint());
    mutate(serialized);
    expect(inspectCheckpoint(serialized)).toEqual({ status: "corrupt" });
  });

  it("classifies a v2 checkpoint as legacy without inventing runtime authority", () => {
    const serialized = serializeCheckpoint(baseCheckpoint());
    serialized.schemaVersion = 2;
    delete serialized.sandboxRecreate;

    const result = inspectCheckpoint(serialized);

    expect(result).toEqual({ status: "legacy", foundVersion: 2 });
  });

  it("classifies a v1 checkpoint as legacy without inventing runtime authority", () => {
    const serialized = serializeCheckpoint(baseCheckpoint());
    serialized.schemaVersion = 1;
    delete serialized.gatewayAuthority;

    const result = inspectCheckpoint(serialized);

    expect(result).toEqual({ status: "legacy", foundVersion: 1 });
  });

  it("round-trips a selected externally supervised gateway authority", () => {
    const checkpoint = baseCheckpoint({
      gatewayAuthority: decisionSelected({
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        mode: "externally-supervised",
        source: "declared",
        endpoint: "https://127.0.0.1:8080",
        stateDir: "/var/lib/openshell/gateway",
        supervisor: {
          kind: "systemd-system",
          serviceName: "openshell-gateway.service",
          execPath: "/usr/local/bin/openshell-gateway",
        },
        requiredCapabilities: ["gateway.health"],
      }),
    });

    expect(inspectCheckpoint(serializeCheckpoint(checkpoint))).toEqual({
      status: "loaded",
      checkpoint,
    });
  });

  it("round-trips a journal bound to the selected sandbox and non-default gateway", () => {
    const checkpoint = baseCheckpoint({
      gatewayAuthority: decisionSelected({
        gatewayName: "nemoclaw-31818",
        gatewayPort: 31818,
        mode: "nemoclaw-managed",
        source: "standalone",
        endpoint: null,
        stateDir: null,
        supervisor: null,
        requiredCapabilities: [],
      }),
      sandboxRecreate: recreateTransaction(),
    });

    expect(inspectCheckpoint(serializeCheckpoint(checkpoint))).toEqual({
      status: "loaded",
      checkpoint,
    });
  });

  it("rejects a current recreate journal without its source workload receipt", () => {
    const serialized = serializedRecreateCheckpoint();
    delete (serialized.sandboxRecreate as Record<string, unknown>).sourceWorkload;

    const result = inspectCheckpoint(serialized);

    expect(result).toEqual({ status: "corrupt" });
  });

  it("rejects a source-workload cleanup receipt whose reference does not match its image", () => {
    const serialized = serializedRecreateCheckpoint();
    const transaction = serialized.sandboxRecreate as Record<string, unknown>;
    transaction.sourceWorkload = {
      openshellDriver: "docker",
      imageTag: "openshell/sandbox-from:old",
      workload: {
        kind: "legacy-dockerfile",
        reference: "openshell/sandbox-from:different",
        shared: false,
      },
    };

    expect(inspectCheckpoint(serialized)).toEqual({ status: "corrupt" });
  });

  it("rejects a source-workload cleanup receipt without a boolean sharing state", () => {
    const serialized = serializedRecreateCheckpoint();
    const transaction = serialized.sandboxRecreate as Record<string, unknown>;
    transaction.sourceWorkload = {
      openshellDriver: "docker",
      imageTag: "openshell/sandbox-from:old",
      workload: {
        kind: "legacy-dockerfile",
        reference: "openshell/sandbox-from:old",
      },
    };

    expect(inspectCheckpoint(serialized)).toEqual({ status: "corrupt" });
  });

  it.each([
    {
      label: "sandbox",
      mutate: (serialized: Record<string, unknown>) => {
        serialized.sandboxIdentity = decisionSelected({ name: "other", agent: "openclaw" });
      },
    },
    {
      label: "gateway",
      mutate: (serialized: Record<string, unknown>) => {
        serialized.gatewayAuthority = decisionSelected({
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          mode: "nemoclaw-managed",
          source: "standalone",
          endpoint: null,
          stateDir: null,
          supervisor: null,
          requiredCapabilities: [],
        });
      },
    },
  ])("rejects a recreate journal copied under a different $label binding", ({ mutate }) => {
    const serialized = serializedRecreateCheckpoint();
    mutate(serialized);

    expect(inspectCheckpoint(serialized)).toEqual({ status: "corrupt" });
  });

  it("rejects malformed recreate journal fingerprints", () => {
    const serialized = serializedRecreateCheckpoint();
    (serialized.sandboxRecreate as Record<string, unknown>).targetIntentFingerprint = "bad";

    expect(inspectCheckpoint(serialized)).toEqual({ status: "corrupt" });
  });

  it.each([
    "sourceLiveIdentityFingerprint",
    "targetLiveIdentityFingerprint",
  ])("rejects a malformed nullable recreate journal field: %s", (field) => {
    const serialized = serializedRecreateCheckpoint();
    (serialized.sandboxRecreate as Record<string, unknown>)[field] = 42;

    expect(inspectCheckpoint(serialized)).toEqual({ status: "corrupt" });
  });

  it("rejects a checkpoint whose external authority targets a different port", () => {
    const serialized = serializeCheckpoint(
      baseCheckpoint({
        gatewayAuthority: decisionSelected({
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          mode: "externally-supervised",
          source: "declared",
          endpoint: "http://127.0.0.1:9443",
          stateDir: "/var/lib/openshell/gateway",
          supervisor: {
            kind: "systemd-system",
            serviceName: "openshell-gateway.service",
            execPath: "/usr/local/bin/openshell-gateway",
          },
          requiredCapabilities: [],
        }),
      }),
    );

    expect(inspectCheckpoint(serialized)).toEqual({ status: "corrupt" });
  });

  it("rejects a checkpoint whose sandbox identity value is malformed", () => {
    const checkpoint = serializeCheckpoint(baseCheckpoint());
    (checkpoint as Record<string, unknown>).sandboxIdentity = {
      kind: "selected",
      value: { name: "Invalid Name", agent: "openclaw" },
    };
    expect(inspectCheckpoint(checkpoint)).toEqual({ status: "corrupt" });
  });

  it("rejects a malformed effect group record instead of silently dropping it", () => {
    const checkpoint = serializeCheckpoint(baseCheckpoint());
    (checkpoint as Record<string, unknown>).effectGroups = {
      sandbox_create: { completedAt: ISO, fingerprint: 42 },
    };
    expect(inspectCheckpoint(checkpoint)).toEqual({ status: "corrupt" });
  });

  it("rejects a non-object effect groups container instead of defaulting to empty", () => {
    const checkpoint = serializeCheckpoint(baseCheckpoint());
    (checkpoint as Record<string, unknown>).effectGroups = "not-an-object";
    expect(inspectCheckpoint(checkpoint)).toEqual({ status: "corrupt" });
  });

  it("rejects non-string entries inside checkpoint bindings instead of silently dropping them", () => {
    const checkpoint = serializeCheckpoint(baseCheckpoint());
    (checkpoint as Record<string, unknown>).bindings = {
      credentialEnvs: ["OPENAI_API_KEY", 42],
      registeredProviders: [
        { name: "web-search-p", type: "brave", credentialEnv: "BRAVE_API_KEY" },
      ],
    };
    expect(inspectCheckpoint(checkpoint)).toEqual({ status: "corrupt" });
  });

  it("rejects a provider binding missing its type or credential environment instead of silently dropping it", () => {
    const checkpoint = serializeCheckpoint(baseCheckpoint());
    (checkpoint as Record<string, unknown>).bindings = {
      credentialEnvs: ["OPENAI_API_KEY"],
      registeredProviders: [{ name: "web-search-p", type: "brave" }],
    };
    expect(inspectCheckpoint(checkpoint)).toEqual({ status: "corrupt" });
  });

  it("rejects a non-object bindings container instead of defaulting to empty", () => {
    const checkpoint = serializeCheckpoint(baseCheckpoint());
    (checkpoint as Record<string, unknown>).bindings = "not-an-object";
    expect(inspectCheckpoint(checkpoint)).toEqual({ status: "corrupt" });
  });
});
