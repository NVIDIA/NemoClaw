// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it } from "vitest";
import {
  configureDcodeSession,
  makeDcodeSandboxEntry,
} from "../../../../test/helpers/rebuild-dcode-flow-helpers";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
  type RebuildFlowHarness,
  type RebuildFlowOverrides,
} from "../../../../test/helpers/rebuild-flow-generic-harness";

describe("shared rebuild flow harness", () => {
  installRebuildFlowTestHooks({ acceptThirdPartySoftware: true });

  it.each([
    {
      name: "generic OpenClaw",
      overrides: { sandboxEntry: {} },
      configure: (_harness: RebuildFlowHarness) => undefined,
    },
    {
      name: "Deep Agents Code",
      overrides: {
        agentName: "langchain-deepagents-code",
        sandboxEntry: makeDcodeSandboxEntry(),
      },
      configure: configureDcodeSession,
    },
  ] satisfies Array<{
    name: string;
    overrides: RebuildFlowOverrides;
    configure: (harness: RebuildFlowHarness) => unknown;
  }>)("uses the same recorded-gateway deletion and policy handoff for $name", async (fixture) => {
    let handedOffPolicy = "";
    const harness = createRebuildFlowHarness({
      ...fixture.overrides,
      onboard: (_session, options) => {
        handedOffPolicy = fs.readFileSync(String(options.rebuildPolicySourcePath), "utf8");
      },
    });
    fixture.configure(harness);

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "delete", "-g", "nemoclaw", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(handedOffPolicy).toContain("host_preserved");
  });
});
