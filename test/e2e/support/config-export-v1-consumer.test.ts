// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { exportSnapshots } from "../../../src/lib/actions/config/export-test-fixture.ts";
import {
  hermesSnapshot,
  snapshot,
} from "../../../src/lib/domain/config/export-source-test-fixture.ts";
import { testTimeoutOptions } from "../../helpers/timeouts.ts";
import { validateWithRevisionMatchedV1Consumer } from "./v1-config-consumer.ts";

async function rawExport(source: ReturnType<typeof snapshot>): Promise<string> {
  const exported = await exportSnapshots([source]);
  expect(exported.outcome.ok).toBe(true);
  return exported.writeStdout.mock.calls[0]![0];
}

describe("revision-matched v1 config consumer", () => {
  it(
    "preserves exported defaults through parsing and native generation (#12132)",
    testTimeoutOptions(12 * 60 * 1_000),
    async () => {
      const openclaw = await rawExport(snapshot());
      const hermesDisabled = await rawExport(hermesSnapshot());
      const openClawSource = {
        contextWindow: 131_072,
        maxTokens: 4096,
        reasoning: false,
        timeoutSeconds: 600,
        heartbeatPresent: false,
        dashboardEnabled: true,
        dashboardPort: 18_789,
        dashboardBind: "loopback",
        toolDisclosure: "progressive",
        explicitAgentOwnership: true,
        thinkingDefaultPresent: false,
      };
      const evidence = validateWithRevisionMatchedV1Consumer([
        {
          name: "openclaw",
          harness: "openclaw",
          raw: openclaw,
          agentName: "primary",
          source: openClawSource,
        },
        {
          name: "hermes-disabled",
          harness: "hermes",
          raw: hermesDisabled,
          source: {
            apiPort: 8642,
            dashboard: {
              enabled: false,
              port: 18_789,
              internalPort: 19_119,
              tui: { enabled: true },
            },
          },
        },
      ]);

      expect(evidence.revision).toBe("88c6600c06b0937907290362eef86912052c4ad0");
      expect(evidence.documents).toHaveLength(2);
      expect(evidence.documents.map(({ harness, sha256 }) => ({ harness, sha256 }))).toEqual(
        [
          ["openclaw", openclaw],
          ["hermes", hermesDisabled],
        ].map(([harness, raw]) => ({
          harness,
          sha256: createHash("sha256").update(raw).digest("hex"),
        })),
      );
    },
  );
});
