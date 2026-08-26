// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { decisionUnset } from "../../state/onboard-checkpoint-decision";
import {
  CHECKPOINT_SCHEMA_VERSION,
  type OnboardCheckpoint,
} from "../../state/onboard-checkpoint-types";
import { prepare } from "./locked-runtime";

vi.mock("../session-bootstrap", async (importOriginal) => {
  const original = await importOriginal<typeof import("../session-bootstrap")>();
  return { ...original, assertLockedResumeIntentSnapshot: vi.fn() };
});

const portableAuthority = {
  schemaVersion: 1 as const,
  kind: "podman" as const,
  ownership: "current-user" as const,
  uid: 1000,
  homeDir: "/home/alice",
  configHome: "/home/alice/.config",
  runtimeDir: "/run/user/1000",
  socketPath: "/run/user/1000/podman/podman.sock",
};

const portableCheckpointWithoutAuthority: OnboardCheckpoint = {
  schemaVersion: CHECKPOINT_SCHEMA_VERSION,
  profile: { kind: "selected", value: "portable" },
  runtimeAuthority: { kind: "unset" },
  sessionId: "portable-missing-authority",
  machineState: "preflight",
  updatedAt: "2026-08-13T20:00:00.000Z",
  sandboxIdentity: decisionUnset(),
  webSearch: decisionUnset(),
  messaging: decisionUnset(),
  resourceProfile: decisionUnset(),
  gatewayAuthority: decisionUnset(),
  effectGroups: {},
  bindings: { credentialEnvs: [], registeredProviders: [] },
  sandboxRecreate: null,
};

describe("locked onboarding runtime preparation", () => {
  it("rejects portable resume without selected authority before host preparation (#9035)", async () => {
    const preparePortableHost = vi.fn();

    await expect(
      prepare(
        {
          resume: true,
          experimentalProfile: "portable",
          preparePortableHost,
        },
        true,
        true,
        () => ({ checkpoint: portableCheckpointWithoutAuthority }),
      ),
    ).rejects.toThrow(/requires recorded runtime authority.*--fresh/su);
    expect(preparePortableHost).not.toHaveBeenCalled();
  });

  it("rejects persisted portable host mounts before host preparation (#8343)", async () => {
    const preparePortableHost = vi.fn();
    const checkpoint: OnboardCheckpoint = {
      ...portableCheckpointWithoutAuthority,
      runtimeAuthority: { kind: "selected", value: portableAuthority },
    };

    await expect(
      prepare(
        {
          resume: true,
          experimentalProfile: "portable",
          preparePortableHost,
          resumeIntentSnapshot: {
            fingerprint: "a".repeat(64),
            sessionId: checkpoint.sessionId,
            checkpointUpdatedAt: checkpoint.updatedAt,
            machineRevision: 1,
            profile: "portable",
          },
        },
        true,
        true,
        () => ({
          checkpoint,
          metadata: {
            hostMounts: [{ source: "/srv/project", target: "/sandbox/project", readOnly: true }],
          },
        }),
      ),
    ).rejects.toThrow(/provider 'podman'.*does not support read-only host mounts/su);
    expect(preparePortableHost).not.toHaveBeenCalled();
  });
});
