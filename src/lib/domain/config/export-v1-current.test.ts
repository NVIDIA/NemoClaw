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

const FABRIC_KIND = {
  openclaw: "nvidia.fabric.openclaw",
  hermes: "nvidia.fabric.hermes",
  deepagents: "nvidia.fabric.deepagents",
} as const;

const cases = [
  { name: "openclaw", source: snapshot, kind: FABRIC_KIND.openclaw },
  { name: "hermes", source: hermesSnapshot, kind: FABRIC_KIND.hermes },
  { name: "deepagents", source: dcodeSnapshot, kind: FABRIC_KIND.deepagents },
  { name: "openclaw tuned", source: tunedSnapshot, kind: FABRIC_KIND.openclaw },
  { name: "openclaw brave", source: braveSnapshot, kind: FABRIC_KIND.openclaw },
  { name: "openclaw tavily", source: () => tavilySnapshot("openclaw"), kind: FABRIC_KIND.openclaw },
  { name: "hermes tavily", source: () => tavilySnapshot("hermes"), kind: FABRIC_KIND.hermes },
  { name: "openclaw proxy", source: proxySnapshot, kind: FABRIC_KIND.openclaw },
  { name: "hermes managed auth", source: hermesManagedAuthSnapshot, kind: FABRIC_KIND.hermes },
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
    "$name export passes Document::parse and names a Fabric adapter",
    testTimeoutOptions(15 * 60_000),
    async ({ source, kind }) => {
      const exported = await exportSnapshots([source()]);
      expect(exported.outcome.ok).toBe(true);
      const { document } = consumer.parse(exported.writeStdout.mock.calls[0]![0]);
      const sandboxes = Object.values(document.spec.sandboxes) as Array<{
        harness: { kind: string };
        image: { ref: string };
      }>;
      expect(sandboxes).toHaveLength(1);
      // v1 accepts any nonempty kind, so a parse alone does not prove the adapter ID.
      expect(sandboxes[0]!.harness.kind).toBe(kind);
      // No V0 agent image ships Fabric and v1 publishes none, so every export carries the placeholder.
      expect(sandboxes[0]!.image.ref).toBe(V1_IMAGE_REF_PLACEHOLDER);
    },
  );
});
