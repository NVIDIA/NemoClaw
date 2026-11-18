// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import YAML from "yaml";
import { afterAll, describe, expect, it } from "vitest";
import { exportSnapshots } from "../../actions/config/export-test-fixture";
import { asExportedConfig } from "../../../../test/support/config-export-document";
import { createV1ParseConsumer } from "../../../../test/support/v1-parse-consumer";
import { testTimeoutOptions } from "../../../../test/helpers/timeouts";
import { dcodeSnapshot, snapshot, tunedSnapshot } from "./export-source-test-fixture";

const consumer = createV1ParseConsumer();
afterAll(consumer.dispose);

function explicitOpenClawDefaultsSnapshot() {
  return tunedSnapshot({
    NEMOCLAW_CONTEXT_WINDOW: "131072",
    NEMOCLAW_MAX_TOKENS: "4096",
    NEMOCLAW_REASONING: "false",
    NEMOCLAW_REASONING_EFFORT: "default",
    NEMOCLAW_AGENT_TIMEOUT: "600",
  });
}

describe("effective v1alpha1 export defaults (#12132)", () => {
  it.runIf(process.env.NEMOCLAW_RUN_V1_CONFIG_COMPATIBILITY === "1")(
    "rejects the proposed Gemini contract at the pinned V1 revision (#12551)",
    testTimeoutOptions(12 * 60_000),
    () => {
      const fixture = readFileSync(
        new URL(
          "../../../../test/fixtures/v1-config-consumer/pending-gemini.yaml",
          import.meta.url,
        ),
        "utf8",
      );
      // The fixture uses the current export shape, so only the Google provider can be rejected.
      expect(() => consumer.parse(fixture)).toThrow(
        /configuration violates schema at spec\.inferenceProviders\.hosted-gemini-api\.provider/u,
      );
      const withSupportedProvider = fixture.replace("provider: google", "provider: openai");
      expect(withSupportedProvider).not.toBe(fixture);
      expect(consumer.parse(withSupportedProvider).document.spec.inferenceProviders).toHaveProperty(
        "hosted-gemini-api",
      );
    },
  );

  it("preserves source values whether their startup inputs were explicit or omitted", async () => {
    const baseline = await exportSnapshots([snapshot()]);
    const explicit = await exportSnapshots([explicitOpenClawDefaultsSnapshot()]);
    expect(explicit.outcome.ok).toBe(true);
    expect(explicit.writeStdout.mock.calls).toEqual(baseline.writeStdout.mock.calls);
    const config = asExportedConfig(YAML.parse(explicit.writeStdout.mock.calls[0]![0]));
    const sandbox = config.spec.sandboxes.alpha!;
    // contextWindow has no v1 route-override home, so only the model carries over.
    // maxTokens and the timeout are always exported; the other tuning has no v1 home.
    expect(sandbox.agent.inference.routes[0]!.overrides).toEqual({
      model: "gpt-5",
      maxTokens: 4096,
    });
    expect(sandbox.harness).toEqual({
      kind: "nvidia.fabric.openclaw",
      runtime: { timeout_seconds: 600 },
    });
  });

  it.runIf(process.env.NEMOCLAW_RUN_V1_CONFIG_COMPATIBILITY === "1")(
    "parses strict Deep Agents policy with the pinned v1 SDK",
    testTimeoutOptions(12 * 60_000),
    async () => {
      const dcode = dcodeSnapshot();
      const strictDcode = {
        ...dcode,
        policy: {
          ...dcode.policy,
          document: dcode.policy.document + "landlock:\n  compatibility: strict\n",
        },
      };
      const result = await exportSnapshots([strictDcode]);
      expect(result.outcome.ok).toBe(true);
      const { document } = consumer.parse(result.writeStdout.mock.calls[0]![0]);
      expect(Object.keys(document.spec.sandboxes)).toEqual(["alpha"]);
    },
  );
});
