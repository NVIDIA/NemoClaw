// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { buildSnapshotCommandEnv } from "../live/snapshot-commands-helpers.ts";

const HOSTED_FLAG = "NEMOCLAW_E2E_USE_HOSTED_INFERENCE";
const SANDBOX_NAME = "e2e-snapshot";

const INFERENCE = {
  apiKey: "nvapi-snapshot-commands-fixture-credential",
  endpointUrl: "http://host.openshell.internal:31337/v1",
  model: "snapshot-commands-model",
};

const HOSTED_CREDENTIAL_ENVS = ["NVIDIA_INFERENCE_API_KEY", "NVIDIA_API_KEY"] as const;

afterEach(() => {
  delete process.env[HOSTED_FLAG];
  for (const name of HOSTED_CREDENTIAL_ENVS) delete process.env[name];
});

describe("snapshot commands live env helper", () => {
  it("forwards an ambient hosted-inference flag through the shared probe env", () => {
    process.env[HOSTED_FLAG] = "1";

    // Negative control. The strip below only matters while the flag is
    // allowlisted for forwarding; if this ever stops holding, the strip
    // assertion would pass vacuously and the hermeticity guard would rot.
    expect(buildAvailabilityProbeEnv()[HOSTED_FLAG]).toBe("1");
  });

  it("strips an ambient hosted-inference flag so the target stays hermetic", () => {
    process.env[HOSTED_FLAG] = "1";

    const env = buildSnapshotCommandEnv(SANDBOX_NAME, INFERENCE);

    expect(env[HOSTED_FLAG]).toBeUndefined();
    expect(Object.hasOwn(env, HOSTED_FLAG)).toBe(false);
  });

  it("strips the hosted-inference flag even when no inference fixture is staged", () => {
    process.env[HOSTED_FLAG] = "1";

    expect(buildSnapshotCommandEnv(SANDBOX_NAME)[HOSTED_FLAG]).toBeUndefined();
  });

  it("stages the compatible endpoint against the custom provider", () => {
    const env = buildSnapshotCommandEnv(SANDBOX_NAME, INFERENCE);

    expect(env).toMatchObject({
      COMPATIBLE_API_KEY: INFERENCE.apiKey,
      NEMOCLAW_COMPAT_MODEL: INFERENCE.model,
      NEMOCLAW_ENDPOINT_URL: INFERENCE.endpointUrl,
      NEMOCLAW_MODEL: INFERENCE.model,
      NEMOCLAW_PREFERRED_API: "openai-completions",
      NEMOCLAW_PROVIDER: "custom",
      NEMOCLAW_SANDBOX_NAME: SANDBOX_NAME,
    });
  });

  it("leaves inference selection unset when no fixture is staged", () => {
    const env = buildSnapshotCommandEnv(SANDBOX_NAME);

    expect(env.COMPATIBLE_API_KEY).toBeUndefined();
    expect(env.NEMOCLAW_ENDPOINT_URL).toBeUndefined();
    expect(env.NEMOCLAW_PROVIDER).toBeUndefined();
  });

  it("never exposes an ambient hosted NVIDIA inference credential to the child env", () => {
    process.env[HOSTED_FLAG] = "1";
    for (const name of HOSTED_CREDENTIAL_ENVS) {
      process.env[name] = "nvapi-ambient-credential-that-must-not-leak";
    }

    const env = buildSnapshotCommandEnv(SANDBOX_NAME, INFERENCE);

    for (const name of HOSTED_CREDENTIAL_ENVS) {
      // Guard against the assertion below going vacuous: the credential really
      // is present in the ambient env this helper builds from.
      expect(process.env[name]).toBe("nvapi-ambient-credential-that-must-not-leak");
      expect(env[name]).toBeUndefined();
    }
  });
});
