// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import type * as SandboxState from "../../src/lib/state/sandbox";
import type * as DcodeDrift from "../../src/lib/onboard/dcode-selection-drift";

/** Keep production drift parsing and replace only the running sandbox's identity command. */
export function installDcodeRecreationIdentityFixture(
  dcode: typeof DcodeDrift,
  providerChanged: boolean,
  sourceDeleted: () => boolean,
  sandboxState: typeof SandboxState,
  fixtureRoot: string,
): { preflight: boolean } {
  const observed = { preflight: false };
  fs.mkdirSync(path.join(fixtureRoot, ".deepagents"), { recursive: true });
  sandboxState.inspectNativeSandboxState = (_backup, inspect, member) => {
    if (_backup !== "/tmp/fake-backup-path" || member !== ".deepagents") {
      throw new Error("Unexpected native-state inspection in recreation fixture");
    }
    observed.preflight = true;
    return inspect(fixtureRoot);
  };
  const realReader = dcode.createDcodeSelectionDriftReader;
  dcode.createDcodeSelectionDriftReader =
    (_executor, getGatewayName) =>
    async (...args) => {
      const selected = dcode.getExpectedDcodeInferenceIdentity(
        args[1],
        args[2],
        args[3],
        args[4],
        args[5],
      );
      const identity =
        providerChanged && !sourceDeleted()
          ? {
              route: "inference",
              provider: "nvidia-prod",
              model: "openai:gpt-5.4",
              endpoint: "https://integrate.api.nvidia.com/v1",
            }
          : selected;
      return realReader(
        {
          runBuffered: async () => ({
            outcome: { kind: "completed", exitCode: 0 },
            stdout: Object.entries(identity ?? {})
              .map(([key, value]) => key[0].toUpperCase() + key.slice(1) + ": " + value)
              .join("\n"),
            stderr: "",
          }),
        },
        getGatewayName,
      )(...args);
    };
  return observed;
}

export const RECREATION_RESTORE_CASES: readonly {
  scenario: string;
  force?: boolean;
  marked?: boolean;
  primary?: string;
  agent?: string;
  drift?: boolean;
}[] = [
  { scenario: "forced recreation", force: true, marked: false, primary: "openai/gpt-4o" },
  {
    scenario: "marked recreation resume",
    force: false,
    marked: true,
    primary: "inference/gpt-5.4",
  },
  {
    scenario: "unmarked recreation resume",
    force: false,
    marked: false,
    primary: "openai/gpt-4o",
  },
  { scenario: "Deep Agents provider change", agent: "langchain-deepagents-code", drift: true },
  { scenario: "Deep Agents marked resume", agent: "langchain-deepagents-code", marked: true },
  { scenario: "unchanged Deep Agents selection", agent: "langchain-deepagents-code" },
  { scenario: "Hermes recreation", agent: "hermes" },
];
