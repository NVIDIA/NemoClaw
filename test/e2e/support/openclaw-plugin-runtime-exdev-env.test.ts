// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildOpenClawPluginRuntimeExdevBaseImageEnv,
  CURRENT_LIFECYCLE_TEST_SELECTOR,
  RELEASE_BASELINE_TEST_SELECTOR,
  RELEASE_SANDBOX_BASE_IMAGE_REF,
} from "../live/openclaw-plugin-runtime-exdev-env.ts";
import {
  currentLifecycleCommands,
  CURRENT_LIFECYCLE_PHASES,
} from "../live/openclaw-plugin-runtime-exdev-lifecycle.ts";

describe("OpenClaw plugin runtime EXDEV base image selection", () => {
  it("pins the release baseline to its matching sandbox base image", () => {
    expect(buildOpenClawPluginRuntimeExdevBaseImageEnv(RELEASE_BASELINE_TEST_SELECTOR)).toEqual({
      NEMOCLAW_SANDBOX_BASE_IMAGE_REF: RELEASE_SANDBOX_BASE_IMAGE_REF,
    });
  });

  it("does not override base-image resolution for the current-lifecycle test", () => {
    expect(buildOpenClawPluginRuntimeExdevBaseImageEnv(CURRENT_LIFECYCLE_TEST_SELECTOR)).toEqual(
      {},
    );
  });
});

describe("OpenClaw plugin runtime EXDEV current lifecycle", () => {
  it("maps the retained lifecycle to restart and recreation without a duplicate rebuild (#7917)", () => {
    expect(
      currentLifecycleCommands({
        cliEntrypoint: "/repo/bin/nemoclaw.js",
        dockerfilePath: "/fixture/Dockerfile",
        sandboxName: "e2e-openclaw-plugin-exdev",
      }),
    ).toEqual({
      onboard: {
        command: "node",
        args: [
          "/repo/bin/nemoclaw.js",
          "onboard",
          "--fresh",
          "--non-interactive",
          "--yes-i-accept-third-party-software",
          "--agent",
          "openclaw",
          "--from",
          "/fixture/Dockerfile",
        ],
      },
      recreate: {
        command: "node",
        args: [
          "/repo/bin/nemoclaw.js",
          "onboard",
          "--fresh",
          "--recreate-sandbox",
          "--non-interactive",
          "--yes",
          "--yes-i-accept-third-party-software",
          "--name",
          "e2e-openclaw-plugin-exdev",
          "--agent",
          "openclaw",
          "--from",
          "/fixture/Dockerfile",
        ],
      },
      restart: {
        command: "node",
        args: ["/repo/bin/nemoclaw.js", "e2e-openclaw-plugin-exdev", "gateway", "restart"],
      },
    });
    expect(CURRENT_LIFECYCLE_PHASES).toEqual([
      "confirm Docker CLI and clear the current plugin sandbox",
      "clone and prepare the current plugin fixture",
      "install current OpenShell and onboard plugin v1",
      "restart the gateway and confirm plugin v1",
      "recreate the sandbox with plugin v2",
      "prove cross-device runtime dependency replacement",
    ]);
  });
});
