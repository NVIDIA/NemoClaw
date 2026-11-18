// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { exportSnapshots } from "../../actions/config/export-test-fixture";
import {
  dcodeSnapshot,
  hermesSnapshot,
  proxySnapshot,
  snapshot,
  tunedSnapshot,
} from "./export-source-test-fixture";

async function omittedFields(source: Parameters<typeof exportSnapshots>[0][number]) {
  const result = await exportSnapshots([source]);
  expect(result.outcome.ok).toBe(true);
  return (result.outcome as unknown as { omissions: { field: string }[] }).omissions.map(
    ({ field }) => field,
  );
}

describe("export omissions (#14580)", () => {
  it("reports each tuned setting v1 cannot represent, once per field", async () => {
    expect(await omittedFields(tunedSnapshot())).toEqual([
      "tools.disclosure",
      "inference.contextWindow",
      "inference.reasoning",
      "inference.reasoningEffort",
      "execution.heartbeatEvery",
      "interfaces",
      "image.ref",
      "network.policy.explicit.filesystem_policy",
      "network.policy.explicit.process",
      "network_policies[].binaries",
    ]);
  });

  it("reports the managed proxy", async () => {
    expect(await omittedFields(proxySnapshot())).toContain("proxy");
  });

  it.each([
    { agent: "OpenClaw", source: snapshot },
    { agent: "Hermes", source: hermesSnapshot },
  ])("reports the placeholder image and interfaces for $agent", async ({ source }) => {
    expect(await omittedFields(source())).toEqual(
      expect.arrayContaining(["interfaces", "image.ref"]),
    );
  });

  it("stays quiet about fields a Deep Agents source does not have", async () => {
    const fields = await omittedFields(dcodeSnapshot());
    expect(fields).not.toContain("interfaces");
    // Its image ships no Fabric adapter either.
    expect(fields).toContain("image.ref");
  });
});

describe("export omissions for always-reported settings (#14580)", () => {
  it("warns about tuning, tool disclosure and interfaces even when v0 holds its own defaults", async () => {
    const fields = await omittedFields(snapshot());
    expect(fields).toEqual(
      expect.arrayContaining([
        "tools.disclosure",
        "inference.contextWindow",
        "inference.reasoning",
        "inference.reasoningEffort",
        "interfaces",
      ]),
    );
    expect(fields).not.toContain("execution.heartbeatEvery");
    expect(fields).not.toContain("proxy");
  });
});
