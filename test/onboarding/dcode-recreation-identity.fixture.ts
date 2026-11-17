// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type * as DcodeDrift from "../../src/lib/onboard/dcode-selection-drift";

/** Keep production drift parsing and replace only the running sandbox's identity command. */
export function installDcodeRecreationIdentityFixture(
  dcode: typeof DcodeDrift,
  providerChanged: boolean,
  sourceDeleted: () => boolean,
): void {
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
}
