// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  buildRebuildHermesChildEnv,
  buildRebuildHermesRecreateEnv,
} from "../live/rebuild-hermes-env.ts";

const preparedRef = "nemoclaw-hermes-sandbox-base-local:e2e-current";

describe("rebuild-Hermes child environment", () => {
  it("keeps the default rebuild free of a base-image override (#10903)", () => {
    const childEnv = buildRebuildHermesChildEnv(
      {},
      buildRebuildHermesRecreateEnv("fixture-discord-token"),
    );

    expect(childEnv.NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF).toBeUndefined();
  });

  it("forwards only supported OpenShell compatibility inputs (#7144)", () => {
    const childEnv = buildRebuildHermesChildEnv(
      {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        BUILDX_BUILDER: "external-builder",
        COMPATIBLE_API_KEY: "must-not-reach-child",
        NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL: "1",
        NEMOCLAW_OPENSHELL_CHANNEL: "dev",
        NVIDIA_API_KEY: "must-not-reach-child",
        NVIDIA_INFERENCE_API_KEY: "must-not-reach-child",
      },
      {},
    );

    expect(childEnv.NEMOCLAW_ACCEPT_DEV_UNVERIFIED_INSTALL).toBe("1");
    expect(childEnv.NEMOCLAW_OPENSHELL_CHANNEL).toBe("dev");
    expect(childEnv.COMPATIBLE_API_KEY).toBeUndefined();
    expect(childEnv.NVIDIA_API_KEY).toBeUndefined();
    expect(childEnv.NVIDIA_INFERENCE_API_KEY).toBeUndefined();
    expect(childEnv.BUILDX_BUILDER).toBeUndefined();
  });

  it("forwards the Discord credential needed to replace the legacy rebuild provider (#10155)", () => {
    const childEnv = buildRebuildHermesChildEnv(
      {
        COMPATIBLE_API_KEY: "must-not-reach-child",
        NVIDIA_API_KEY: "must-not-reach-child",
        NVIDIA_INFERENCE_API_KEY: "must-not-reach-child",
      },
      buildRebuildHermesRecreateEnv("fixture-discord-token", {
        NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF: preparedRef,
      }),
    );

    expect(childEnv.DISCORD_BOT_TOKEN).toBe("fixture-discord-token");
    expect(childEnv.NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF).toBe(preparedRef);
    expect(childEnv.NEMOCLAW_REBUILD_VERBOSE).toBe("1");
    expect(childEnv.COMPATIBLE_API_KEY).toBeUndefined();
    expect(childEnv.NVIDIA_API_KEY).toBeUndefined();
    expect(childEnv.NVIDIA_INFERENCE_API_KEY).toBeUndefined();
  });
});
