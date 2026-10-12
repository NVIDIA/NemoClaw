// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";
import { describe, expect, it } from "vitest";
import { exportSnapshots } from "../../actions/config/export-test-fixture";
import { parseAndValidateSandboxPolicy } from "../../policy/sandbox-policy-validation";
import { asExportedConfig } from "../../../../test/support/config-export-document";
import { validateConfigExportWithPinnedV1 } from "../../../../test/support/v1-config-consumer";
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
  ];
  sourcePolicy.network_policies.api.binaries = [{ path: "/usr/bin/curl" }];
  return YAML.stringify(sourcePolicy);
}

describe("effective policy export (#12148)", () => {
  it("retains L7, raw TLS, and binary restrictions in the exported policy", async () => {
    const sourcePolicy = restrictedPolicyDocument();
    const baseline = snapshot();
    const result = await exportSnapshots([
      { ...baseline, policy: { ...baseline.policy, document: sourcePolicy } },
    ]);

    expect(result.outcome).toEqual({ ok: true, completion: { kind: "stdout" } });
    const document = asExportedConfig(YAML.parse(result.writeStdout.mock.calls[0]![0]));
    const targetPolicy = document.spec.sandboxes[0]!.network.policy.explicit;
    expect(parseAndValidateSandboxPolicy(YAML.stringify(targetPolicy))).toEqual(targetPolicy);
    expect(targetPolicy.network_policies).toEqual(YAML.parse(sourcePolicy).network_policies);
  });

  it.runIf(process.env.NEMOCLAW_RUN_V1_CONFIG_COMPATIBILITY === "1")(
    "parses a restricted raw policy export with the pinned v1 consumer",
    testTimeoutOptions(12 * 60_000),
    async () => {
      const baseline = snapshot();
      const result = await exportSnapshots([
        { ...baseline, policy: { ...baseline.policy, document: restrictedPolicyDocument() } },
      ]);
      expect(result.outcome.ok).toBe(true);
      expect(validateConfigExportWithPinnedV1(result.writeStdout.mock.calls[0]![0])).toMatchObject({
        compiledSandboxes: 1,
      });
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
