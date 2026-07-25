// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRebuildHermesCompatibleProviderArgs,
  buildRebuildHermesInferenceRouteArgs,
} from "../live/rebuild-hermes-current-fixture.ts";

const LIVE_FIXTURE = path.resolve(import.meta.dirname, "../live/rebuild-hermes.test.ts");
const CURRENT_FIXTURE = path.resolve(
  import.meta.dirname,
  "../live/rebuild-hermes-current-fixture.ts",
);
const ENDPOINT = "https://inference.example.test/v1";
const MODEL = "test/current-model";

describe("rebuild-Hermes direct-base boundary", () => {
  it("prepares the current base directly and omits the disposable phase-1 sandbox (#7144)", () => {
    const source = fs.readFileSync(LIVE_FIXTURE, "utf8");
    const currentFixtureSource = fs.readFileSync(CURRENT_FIXTURE, "utf8");

    expect(source).toContain('host.nemoclaw(["--help"]');
    expect(source).toContain("prepareRebuildHermesCurrentFixture({");
    expect(source).toContain('host.nemoclaw([SANDBOX_NAME, "rebuild", "--yes", "--verbose"]');
    expect(currentFixtureSource).toContain('ensureAgentBaseImage(loadAgent("hermes"))');
    expect(currentFixtureSource).toContain('["gateway", "start", "--name", "nemoclaw"]');
    expect(currentFixtureSource).toContain("resolveCreateSandboxDashboardPort({");
    expect(currentFixtureSource).toContain("ownerSandbox: input.sandboxName");

    expect(source).not.toContain('host.nemoclaw(["onboard", "--non-interactive"]');
    expect(source).not.toContain("phase-1-onboard-current-hermes");
    expect(source).not.toContain("phase-1-delete-current-sandbox");
    expect(source).not.toContain("phase-1-remove-initial-hermes-image");
    expect(source).not.toContain("phase-1-stop-hermes-forward");
  });

  it.each([
    [
      "create",
      [
        "provider",
        "create",
        "-g",
        "nemoclaw",
        "--name",
        "compatible-endpoint",
        "--type",
        "openai",
        "--credential",
        "COMPATIBLE_API_KEY",
        "--config",
        `OPENAI_BASE_URL=${ENDPOINT}`,
      ],
    ],
    [
      "update",
      [
        "provider",
        "update",
        "-g",
        "nemoclaw",
        "compatible-endpoint",
        "--credential",
        "COMPATIBLE_API_KEY",
        "--config",
        `OPENAI_BASE_URL=${ENDPOINT}`,
      ],
    ],
  ] as const)("keeps the exact gateway-scoped compatible provider %s route (#7144)", (action, args) => {
    expect(buildRebuildHermesCompatibleProviderArgs(action, ENDPOINT)).toEqual(args);
  });

  it("keeps inference on the named gateway and compatible provider (#7144)", () => {
    expect(buildRebuildHermesInferenceRouteArgs(MODEL)).toEqual([
      "inference",
      "set",
      "-g",
      "nemoclaw",
      "--no-verify",
      "--provider",
      "compatible-endpoint",
      "--model",
      MODEL,
      "--timeout",
      expect.stringMatching(/^\d+$/u),
    ]);
  });
});
