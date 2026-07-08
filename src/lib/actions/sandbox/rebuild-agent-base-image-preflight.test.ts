// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RebuildFlowHelpersModule = typeof import("./rebuild-flow-helpers");
type AgentDefsModule = typeof import("../../agent/defs");
type AgentOnboardModule = typeof import("../../agent/onboard");
type SandboxBaseImageResolutionMetadata =
  import("../../sandbox-base-image").SandboxBaseImageResolutionMetadata;

const requireDist = createRequire(import.meta.url);
const rebuildFlowHelpersPath = "./rebuild-flow-helpers.js";
const agentDefsPath = "../../agent/defs.js";
const agentOnboardPath = "../../agent/onboard.js";
const overrideEnvVar = "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF";

function loadRebuildFlowHelpers(): RebuildFlowHelpersModule {
  delete require.cache[requireDist.resolve(rebuildFlowHelpersPath)];
  return requireDist(rebuildFlowHelpersPath);
}

// Warm the CommonJS dependency graph outside the first test's timeout. Tests
// still reload this entry module after installing dependency spies.
loadRebuildFlowHelpers();
delete require.cache[requireDist.resolve(rebuildFlowHelpersPath)];

function loadAgentDefs(): AgentDefsModule {
  return requireDist(agentDefsPath);
}

function loadAgentOnboard(): AgentOnboardModule {
  return requireDist(agentOnboardPath);
}

function makeBail(): (msg: string, code?: number) => never {
  return (msg: string) => {
    throw new Error(`bail: ${msg}`);
  };
}

describe("ensureRebuildAgentBaseImage", () => {
  const hint = { key: "sandbox-a" } as SandboxBaseImageResolutionMetadata;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubEnv(overrideEnvVar, "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function setup() {
    const agent = { name: "hermes", displayName: "Hermes" } as ReturnType<
      AgentDefsModule["loadAgent"]
    >;
    vi.spyOn(loadAgentDefs(), "loadAgent").mockReturnValue(agent);
    const ensureAgentBaseImage = vi
      .spyOn(loadAgentOnboard(), "ensureAgentBaseImage")
      .mockImplementation((_agent, options = {}) => ({
        imageTag: options.forceBaseImageRefresh
          ? "hermes:refreshed"
          : options.resolutionHint
            ? "hermes:cached"
            : "hermes:rebuilt",
        built: !options.resolutionHint,
      }));
    return { agent, ensureAgentBaseImage };
  }

  it("forwards a recorded hint for cache validation without forcing a legacy rebuild (#4680)", () => {
    const { agent, ensureAgentBaseImage } = setup();
    const { ensureRebuildAgentBaseImage } = loadRebuildFlowHelpers();

    expect(ensureRebuildAgentBaseImage("hermes", makeBail(), { resolutionHint: hint })).toEqual({
      ok: true,
      imageRef: "hermes:cached",
      overrideEnvVar,
    });
    expect(ensureAgentBaseImage).toHaveBeenCalledWith(agent, {
      forceBaseImageRebuild: false,
      resolutionHint: hint,
    });
  });

  it("preserves the forced local rebuild path for legacy sandboxes without a hint (#4680)", () => {
    const { agent, ensureAgentBaseImage } = setup();
    const { ensureRebuildAgentBaseImage } = loadRebuildFlowHelpers();

    expect(ensureRebuildAgentBaseImage("hermes", makeBail())).toEqual({
      ok: true,
      imageRef: "hermes:rebuilt",
      overrideEnvVar,
    });
    expect(ensureAgentBaseImage).toHaveBeenCalledWith(agent, {
      forceBaseImageRebuild: true,
    });
  });

  it("reports a forced Hermes base-image failure before rebuild can continue", () => {
    const { ensureAgentBaseImage } = setup();
    ensureAgentBaseImage.mockImplementation(() => {
      throw new Error("Failed to build Hermes Agent base image (exit 23)");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { ensureRebuildAgentBaseImage } = loadRebuildFlowHelpers();

    expect(() => ensureRebuildAgentBaseImage("hermes", makeBail())).toThrow(
      "Failed to build Hermes Agent base image (exit 23)",
    );

    const output = error.mock.calls.flat().join("\n");
    expect(output).toContain("Rebuild preflight failed");
    expect(output).toContain("agent base image could not be built");
    expect(output).toContain("Failed to build Hermes Agent base image (exit 23)");
    expect(output).toContain("Sandbox is untouched");
  });

  it("forwards force refresh with the sandbox-specific hint (#4680)", () => {
    const { agent, ensureAgentBaseImage } = setup();
    const { ensureRebuildAgentBaseImage } = loadRebuildFlowHelpers();

    expect(
      ensureRebuildAgentBaseImage("hermes", makeBail(), {
        resolutionHint: hint,
        forceBaseImageRefresh: true,
      }),
    ).toEqual({
      ok: true,
      imageRef: "hermes:refreshed",
      overrideEnvVar,
    });
    expect(ensureAgentBaseImage).toHaveBeenCalledWith(agent, {
      forceBaseImageRebuild: false,
      resolutionHint: hint,
      forceBaseImageRefresh: true,
    });
  });
});
