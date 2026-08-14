// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { decisionUnset } from "../../state/onboard-checkpoint-decision";
import {
  CHECKPOINT_SCHEMA_VERSION,
  type OnboardCheckpoint,
} from "../../state/onboard-checkpoint-types";
import { prepare } from "./locked-runtime";

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
});
