// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  commandEnvironment,
  sandboxCommandEnvironment,
  testHomeEnvironment,
} from "../fixtures/environment-profiles.ts";

describe("E2E environment profiles", () => {
  it("filters the source and lets caller overrides win without mutation", () => {
    const source = {
      PATH: "/usr/bin",
      OPENSHELL_GATEWAY: "source-gateway",
      UNRELATED_SECRET: "must-not-pass",
    };
    const extra = {
      NEMOCLAW_NON_INTERACTIVE: "override",
      NVIDIA_INFERENCE_API_KEY: "test-secret-overlay",
    };

    const result = commandEnvironment(extra, source);

    expect(result).toMatchObject({
      PATH: "/usr/bin",
      NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
      NEMOCLAW_NON_INTERACTIVE: "override",
      NVIDIA_INFERENCE_API_KEY: "test-secret-overlay",
      OPENSHELL_GATEWAY: "source-gateway",
    });
    expect(result.UNRELATED_SECRET).toBeUndefined();
    expect(source).toEqual({
      PATH: "/usr/bin",
      OPENSHELL_GATEWAY: "source-gateway",
      UNRELATED_SECRET: "must-not-pass",
    });
  });

  it("centralizes test HOME CLI paths with caller precedence", () => {
    const home = path.join(path.sep, "tmp", "nemoclaw-test-home");
    const result = testHomeEnvironment(home, { HOME: "/override-home" }, { PATH: "/usr/bin" });

    expect(result.HOME).toBe("/override-home");
    expect(result.PATH?.split(path.delimiter)).toEqual([
      path.join(home, ".local", "bin"),
      path.join(home, ".npm-global", "bin"),
      "/usr/bin",
    ]);
  });

  it("composes sandbox identity and secret-bearing overlays", () => {
    const result = sandboxCommandEnvironment(
      "e2e-profile",
      {
        COMPATIBLE_API_KEY: "compatible-secret",
        NEMOCLAW_RECREATE_SANDBOX: "0",
      },
      { PATH: "/usr/bin" },
    );

    expect(result).toMatchObject({
      COMPATIBLE_API_KEY: "compatible-secret",
      NEMOCLAW_RECREATE_SANDBOX: "0",
      NEMOCLAW_SANDBOX_NAME: "e2e-profile",
      OPENSHELL_GATEWAY: "nemoclaw",
    });
  });
});
