// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, describe, expect, it } from "vitest";
import { exportSnapshots } from "../../actions/config/export-test-fixture";
import { V1_IMAGE_REF_PLACEHOLDER } from "./export-document";
import {
  createV1ParseConsumer,
  summarizeV1Parse,
} from "../../../../test/support/v1-parse-consumer";
import { testTimeoutOptions } from "../../../../test/helpers/timeouts";
import {
  braveSnapshot,
  dcodeSnapshot,
  hermesManagedAuthSnapshot,
  hermesSnapshot,
  proxySnapshot,
  snapshot,
  tavilySnapshot,
  tunedSnapshot,
} from "./export-source-test-fixture";

const consumer = createV1ParseConsumer();
afterAll(consumer.dispose);

// The v1 example at the pinned revision that declares each agent's Fabric adapter.
const V1_EXAMPLE = {
  openclaw: "examples/fabric-openclaw.yaml",
  hermes: "examples/fabric-hermes.yaml",
  deepagents: "examples/fabric.yaml",
} as const;

const cases = [
  { name: "openclaw", source: snapshot, example: V1_EXAMPLE.openclaw },
  { name: "hermes", source: hermesSnapshot, example: V1_EXAMPLE.hermes },
  { name: "deepagents", source: dcodeSnapshot, example: V1_EXAMPLE.deepagents },
  { name: "openclaw tuned", source: tunedSnapshot, example: V1_EXAMPLE.openclaw },
  { name: "openclaw brave", source: braveSnapshot, example: V1_EXAMPLE.openclaw },
  {
    name: "openclaw tavily",
    source: () => tavilySnapshot("openclaw"),
    example: V1_EXAMPLE.openclaw,
  },
  { name: "hermes tavily", source: () => tavilySnapshot("hermes"), example: V1_EXAMPLE.hermes },
  { name: "openclaw proxy", source: proxySnapshot, example: V1_EXAMPLE.openclaw },
  { name: "hermes managed auth", source: hermesManagedAuthSnapshot, example: V1_EXAMPLE.hermes },
];

describe("parsed web-search shape (#14580)", () => {
  it.runIf(process.env.NEMOCLAW_RUN_V1_CONFIG_COMPATIBILITY === "1")(
    "exposes the Brave integration and the agent's reference to it",
    testTimeoutOptions(15 * 60_000),
    async () => {
      const exported = await exportSnapshots([braveSnapshot()]);
      const summary = summarizeV1Parse(consumer.parse(exported.writeStdout.mock.calls[0]![0]));
      expect(summary.integrations).toEqual({
        "brave-search": { provider: "brave", credentialReference: "BRAVE_API_KEY" },
      });
      expect(summary.sandboxes.alpha!.integrationRefs).toEqual(["brave-search"]);
    },
  );
});

describe("config export parses on current v1 (#14580)", () => {
  it.runIf(process.env.NEMOCLAW_RUN_V1_CONFIG_COMPATIBILITY === "1").each(cases)(
    "$name export passes Document::parse and names the Fabric adapter v1's example declares",
    testTimeoutOptions(15 * 60_000),
    async ({ source, example }) => {
      const exported = await exportSnapshots([source()]);
      expect(exported.outcome.ok).toBe(true);
      const { document } = consumer.parse(exported.writeStdout.mock.calls[0]![0]);
      const sandboxes = Object.values(document.spec.sandboxes) as Array<{
        harness: { kind: string };
        image: { ref: string };
      }>;
      expect(sandboxes).toHaveLength(1);
      // v1 accepts any nonempty kind, so a parse alone does not prove the adapter ID. Compare it
      // with the kind v1's own example for this agent declares at the pinned revision.
      const declared = consumer.exampleHarnessKinds(example);
      expect(declared).toHaveLength(1);
      expect(sandboxes[0]!.harness.kind).toBe(declared[0]);
      // No V0 agent image ships Fabric and v1 publishes none, so every export carries the placeholder.
      expect(sandboxes[0]!.image.ref).toBe(V1_IMAGE_REF_PLACEHOLDER);
    },
  );
});
