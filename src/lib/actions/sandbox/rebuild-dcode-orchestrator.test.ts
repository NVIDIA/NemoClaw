// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { SandboxBaseImageResolutionMetadata } from "../../sandbox-base-image";
import { createDcodeRebuildOrchestrator } from "./rebuild-dcode-orchestrator";
import {
  type PreparedDcodeReplacement,
  prepareDcodeReplacementBeforeMutation,
} from "./rebuild-dcode-preflight";
import { DCODE_AGENT_NAME } from "./rebuild-dcode-target";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import type { RebuildResumeConfig } from "./rebuild-resume-config";

vi.mock("./rebuild-dcode-preflight", async () => {
  const actual = await vi.importActual<typeof import("./rebuild-dcode-preflight")>(
    "./rebuild-dcode-preflight",
  );
  return { ...actual, prepareDcodeReplacementBeforeMutation: vi.fn() };
});

describe("DCode rebuild orchestrator", () => {
  afterEach(() => {
    vi.mocked(prepareDcodeReplacementBeforeMutation).mockReset();
  });

  it("forwards warm-cache options through the ordinary agent image preflight (#4680)", async () => {
    const ensureAgentBaseImage = vi.fn(() => true);
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });
    const orchestrator = createDcodeRebuildOrchestrator({
      sandboxName: "alpha",
      entry: {} as RebuildSandboxEntry,
      rebuildAgent: "hermes",
      log: vi.fn(),
      bail,
      deps: {
        checkGatewaySchema: vi.fn(() => true),
        preflightCredentials: vi.fn(() => true),
        ensureAgentBaseImage,
      },
    });
    const resolutionHint = { key: "sandbox-alpha" } as SandboxBaseImageResolutionMetadata;
    const baseImageOptions = { resolutionHint, forceBaseImageRefresh: true };

    await expect(
      orchestrator.prepareImage(
        {} as RebuildResumeConfig,
        null,
        "progressive",
        "disabled",
        false,
        19_080,
        baseImageOptions,
      ),
    ).resolves.toBe(true);
    expect(ensureAgentBaseImage).toHaveBeenCalledWith("hermes", bail, baseImageOptions);
  });

  it("keeps warm-cache options out of the sealed DCode image path (#6195)", async () => {
    const ensureAgentBaseImage = vi.fn(() => true);
    const bail = vi.fn((message: string): never => {
      throw new Error(message);
    });
    const replacement = {
      buildContext: { buildCtx: "/tmp/prepared-dcode" },
      gatewayName: "nemoclaw",
      dispose: vi.fn(() => true),
      verify: vi.fn(() => true),
    } as unknown as PreparedDcodeReplacement;
    vi.mocked(prepareDcodeReplacementBeforeMutation).mockResolvedValue(replacement);
    const entry = {} as RebuildSandboxEntry;
    const resumeConfig = {} as RebuildResumeConfig;
    const orchestrator = createDcodeRebuildOrchestrator({
      sandboxName: "alpha",
      entry,
      rebuildAgent: DCODE_AGENT_NAME,
      log: vi.fn(),
      bail,
      deps: {
        checkGatewaySchema: vi.fn(() => true),
        preflightCredentials: vi.fn(() => true),
        ensureAgentBaseImage,
      },
    });
    const resolutionHint = { key: "sandbox-alpha" } as SandboxBaseImageResolutionMetadata;

    await expect(
      orchestrator.prepareImage(resumeConfig, null, "progressive", "thread-opt-in", false, 19_080, {
        resolutionHint,
        forceBaseImageRefresh: true,
      }),
    ).resolves.toBe(true);

    expect(prepareDcodeReplacementBeforeMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxName: "alpha",
        entry,
        resumeConfig,
        webSearchConfig: null,
        toolDisclosure: "progressive",
        dcodeAutoApprovalMode: "thread-opt-in",
        skipLiveRoute: false,
        gatewayPort: 19_080,
      }),
    );
    expect(ensureAgentBaseImage).not.toHaveBeenCalled();
    expect(orchestrator.preparedReplacement).toBe(replacement);
  });
});
