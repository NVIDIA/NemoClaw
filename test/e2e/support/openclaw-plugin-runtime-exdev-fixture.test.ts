// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  CURRENT_LIFECYCLE_TEST_SELECTOR,
  RELEASE_BASELINE_TEST_SELECTOR,
  RELEASE_SANDBOX_BASE_IMAGE_REF,
  resolveOpenClawPluginRuntimeExdevFixture,
} from "../live/openclaw-plugin-runtime-exdev-fixture.ts";
import {
  CURRENT_LIFECYCLE_PHASES,
  currentLifecycleCommands,
} from "../live/openclaw-plugin-runtime-exdev-lifecycle.ts";

describe("OpenClaw plugin runtime EXDEV fixture selection", () => {
  it("keeps the release baseline on its matching source and sandbox base image", () => {
    expect(resolveOpenClawPluginRuntimeExdevFixture(RELEASE_BASELINE_TEST_SELECTOR)).toEqual({
      selector: RELEASE_BASELINE_TEST_SELECTOR,
      source: "release",
      baseImageEnv: {
        NEMOCLAW_SANDBOX_BASE_IMAGE_REF: RELEASE_SANDBOX_BASE_IMAGE_REF,
      },
      openClawModulePath: "/usr/local/lib/node_modules/openclaw",
    });
  });

  it("uses checkout source with CLI-selected base-image resolution and the managed OpenClaw module path", () => {
    expect(resolveOpenClawPluginRuntimeExdevFixture(CURRENT_LIFECYCLE_TEST_SELECTOR)).toEqual({
      selector: CURRENT_LIFECYCLE_TEST_SELECTOR,
      source: "current",
      baseImageEnv: {},
      openClawModulePath: "/usr/local/lib/nemoclaw/openclaw-runtime/node_modules/openclaw",
    });
  });
});

describe("OpenClaw plugin runtime EXDEV current lifecycle", () => {
  it("maps the retained lifecycle to restart and recreation without a duplicate rebuild (#7917)", () => {
    expect(
      currentLifecycleCommands({
        cliEntrypoint: "/repo/bin/nemoclaw.js",
        dockerfilePath: "/fixture/Dockerfile",
        sandboxName: "e2e-oc-exdev",
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
          "e2e-oc-exdev",
          "--agent",
          "openclaw",
          "--from",
          "/fixture/Dockerfile",
        ],
      },
      restart: {
        command: "node",
        args: ["/repo/bin/nemoclaw.js", "e2e-oc-exdev", "gateway", "restart"],
      },
    });
    expect(CURRENT_LIFECYCLE_PHASES).toEqual([
      "confirm Docker CLI and clear the current plugin sandbox",
      "clone and prepare the current plugin fixture",
      "install and validate current OpenShell",
      "build and onboard plugin v1",
      "restart the gateway and confirm plugin v1",
      "recreate the sandbox with plugin v2",
      "prove cross-device runtime dependency replacement",
    ]);
  });
});
