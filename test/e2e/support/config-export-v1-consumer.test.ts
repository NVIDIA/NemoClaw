// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { exportSnapshots } from "../../../src/lib/actions/config/export-test-fixture.ts";
import {
  hermesSnapshot,
  snapshot,
  tunedSnapshot,
} from "../../../src/lib/domain/config/export-source-test-fixture.ts";
import { testTimeoutOptions } from "../../helpers/timeouts.ts";
import { validateWithRevisionMatchedV1Consumer } from "../fixtures/revision-matched-v1-consumer.ts";

async function rawExport(source: ReturnType<typeof snapshot>): Promise<string> {
  const exported = await exportSnapshots([source]);
  expect(exported.outcome.ok).toBe(true);
  return exported.writeStdout.mock.calls[0]![0];
}

afterEach(() => vi.unstubAllEnvs());

describe("revision-matched v1 config consumer", () => {
  it(
    "preserves exported defaults through parsing and native generation (#12132)",
    testTimeoutOptions(12 * 60 * 1_000),
    async () => {
      vi.stubEnv("NVIDIA_INFERENCE_API_KEY", "must-not-reach-consumer");
      vi.stubEnv("GH_TOKEN", "must-not-reach-consumer");
      const openclaw = await rawExport(snapshot());
      const openclawTuned = await rawExport(tunedSnapshot());
      const hermesDisabled = await rawExport(hermesSnapshot());
      const openClawSource = {
        contextWindow: 131_072,
        maxTokens: 4096,
        reasoning: false,
        timeoutSeconds: 600,
        heartbeatEvery: null,
        dashboardEnabled: true,
        dashboardPort: 18_789,
        dashboardBind: "loopback",
        toolDisclosure: "progressive",
        explicitAgentOwnership: true,
        reasoningEffort: "default",
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
          name: "openclaw-tuned",
          harness: "openclaw",
          raw: openclawTuned,
          agentName: "primary",
          source: {
            ...openClawSource,
            contextWindow: 65_536,
            maxTokens: 8192,
            reasoning: true,
            timeoutSeconds: 900,
            heartbeatEvery: "30m",
            reasoningEffort: "high",
          },
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
      expect(evidence.documents).toHaveLength(3);
      expect(evidence.documents.map(({ harness, sha256 }) => ({ harness, sha256 }))).toEqual(
        [
          ["openclaw", openclaw],
          ["openclaw", openclawTuned],
          ["hermes", hermesDisabled],
        ].map(([harness, raw]) => ({
          harness,
          sha256: createHash("sha256").update(raw).digest("hex"),
        })),
      );
    },
  );
});
