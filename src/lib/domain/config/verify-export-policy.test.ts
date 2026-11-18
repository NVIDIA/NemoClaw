// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { exportSnapshots } from "../../actions/config/export-test-fixture";
import { asExportedConfig } from "../../../../test/support/config-export-document";
import { createV1ParseConsumer } from "../../../../test/support/v1-parse-consumer";
import { testTimeoutOptions } from "../../../../test/helpers/timeouts";
import { policy, snapshot } from "./export-source-test-fixture";

function restrictedPolicyDocument(): string {
  const sourcePolicy = YAML.parse(policy);
  sourcePolicy.network_policies.api.endpoints = [
    {
      host: "api.example.com",
      port: 443,
      protocol: "rest",
      enforcement: "enforce",
      rules: [{ allow: { method: "GET", path: "/read" } }],
    },
    { host: "tunnel.example.com", port: 443, tls: "passthrough" },
    {
      // OpenShell inference profiles for custom HTTPS endpoints write tls: terminate.
      host: "custom.example.com",
      port: 443,
      protocol: "rest",
      tls: "terminate",
      enforcement: "enforce",
      rules: [{ allow: { method: "POST", path: "/v1/chat/completions" } }],
    },
  ];
  sourcePolicy.network_policies.api.binaries = [{ path: "/usr/bin/curl" }];
  return YAML.stringify(sourcePolicy);
}

describe("effective policy export (#12148)", () => {
  it("retains L7 and binary restrictions and renames raw TLS for v1 in the exported policy", async () => {
    const sourcePolicy = restrictedPolicyDocument();
    const baseline = snapshot();
    const result = await exportSnapshots([
      { ...baseline, policy: { ...baseline.policy, document: sourcePolicy } },
    ]);

    expect(result.outcome).toMatchObject({ ok: true, completion: { kind: "stdout" } });
    const document = asExportedConfig(YAML.parse(result.writeStdout.mock.calls[0]![0]));
    const targetPolicy = document.spec.sandboxes.alpha!.network.policy.explicit;
    const expected = YAML.parse(sourcePolicy).network_policies;
    // v1 names a raw TLS tunnel `skip`; every other rule is unchanged.
    expected.api.endpoints[1].tls = "skip";
    // Omitting tls is v1's automatic TLS termination, which `terminate` named.
    delete expected.api.endpoints[2].tls;
    expect(targetPolicy.network_policies).toEqual(expected);
    const changes = result.outcome.ok
      ? result.outcome.omissions.filter(({ kind }) => kind === "changed")
      : [];
    expect(changes.map(({ message }) => message.split(": ")[1]?.split(" ")[0])).toEqual([
      "passthrough",
      "terminate",
    ]);
  });

  it.runIf(process.env.NEMOCLAW_RUN_V1_CONFIG_COMPATIBILITY === "1")(
    "parses a restricted raw policy export with the pinned v1 SDK",
    testTimeoutOptions(12 * 60_000),
    async () => {
      const baseline = snapshot();
      const result = await exportSnapshots([
        { ...baseline, policy: { ...baseline.policy, document: restrictedPolicyDocument() } },
      ]);
      expect(result.outcome.ok).toBe(true);
      const consumer = createV1ParseConsumer();
      try {
        const { document } = consumer.parse(result.writeStdout.mock.calls[0]![0]);
        expect(Object.keys(document.spec.sandboxes)).toEqual(["alpha"]);
      } finally {
        consumer.dispose();
      }
    },
  );

  it("refuses export when the source process principal cannot map to v1", async () => {
    const sourcePolicy = YAML.parse(policy);
    sourcePolicy.process.run_as_user = "daemon";
    const baseline = snapshot();
    const observed = {
      ...baseline,
      policy: { ...baseline.policy, document: YAML.stringify(sourcePolicy) },
    };

    const result = await exportSnapshots([observed]);
    expect(result.outcome).toMatchObject({
      ok: false,
      failure: {
        findings: [
          expect.objectContaining({
            field: "spec.sandboxes[].network.policy.explicit.process",
            category: "unsupported",
          }),
        ],
      },
    });
    expect(result.writeStdout).not.toHaveBeenCalled();
    expect(result.publish).not.toHaveBeenCalled();
  });
});
