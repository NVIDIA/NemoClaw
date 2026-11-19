// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
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

/**
 * The effective policy as OpenShell returns it for a sandbox with the native NVIDIA provider
 * attached: the base rules plus the entry OpenShell composes from that provider's profile.
 * OpenShell keys it `provider_rule_name("nemoclaw-nvidia-prod-v1")`, copies the profile's
 * endpoints and binaries (`ProviderTypeProfile::network_policy_rule`), and stamps the endpoint
 * `provider_credentialed`. The profile is the checked-in one V0 registers.
 */
function providerComposedPolicyDocument(): string {
  const profile = YAML.parse(
    readFileSync(
      new URL(
        "../../../../managed-inference/provider-profiles/nemoclaw-nvidia-inference-v1.yaml",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { endpoints: Record<string, unknown>[]; binaries: string[] };
  const sourcePolicy = YAML.parse(policy);
  sourcePolicy.network_policies._provider_nemoclaw_nvidia_prod_v1 = {
    name: "_provider_nemoclaw_nvidia_prod_v1",
    endpoints: profile.endpoints.map((endpoint) => ({ ...endpoint, provider_credentialed: true })),
    binaries: profile.binaries.map((path) => ({ path })),
  };
  return YAML.stringify(sourcePolicy);
}

describe("image-specific policy sections (#14580)", () => {
  it("keeps every network rule and leaves out the V0 image's filesystem, process and Landlock", async () => {
    const baseline = snapshot();
    const sourcePolicy = YAML.parse(policy);
    sourcePolicy.landlock = { compatibility: "best_effort" };
    const result = await exportSnapshots([
      { ...baseline, policy: { ...baseline.policy, document: YAML.stringify(sourcePolicy) } },
    ]);

    expect(result.outcome).toMatchObject({ ok: true, completion: { kind: "stdout" } });
    const raw = result.writeStdout.mock.calls[0]![0];
    const explicit = asExportedConfig(YAML.parse(raw)).spec.sandboxes.alpha!.network.policy
      .explicit as Record<string, unknown>;
    // V0's run_as identity and writable paths describe the V0 image, which v1 replaces.
    expect(explicit).not.toHaveProperty("filesystem_policy");
    expect(explicit).not.toHaveProperty("process");
    expect(explicit).not.toHaveProperty("landlock");
    expect(explicit.network_policies).toEqual(sourcePolicy.network_policies);
    expect(raw).toContain("\n# omitted network.policy.explicit.filesystem_policy value=");
    expect(raw).toContain("\n# omitted network.policy.explicit.process value=");
    expect(raw).toContain("\n# omitted network.policy.explicit.landlock value=");
    expect(raw).toContain(
      `\n# review network_policies[].binaries value=${JSON.stringify(["/usr/bin/curl"])}: `,
    );
  });
});

describe("provider-composed policy entries (#14580)", () => {
  it("leaves out every OpenShell _provider_ entry and reports each one", async () => {
    const baseline = snapshot();
    const sourcePolicy = providerComposedPolicyDocument();
    const result = await exportSnapshots([
      { ...baseline, policy: { ...baseline.policy, document: sourcePolicy } },
    ]);

    expect(result.outcome).toMatchObject({ ok: true, completion: { kind: "stdout" } });
    const raw = result.writeStdout.mock.calls[0]![0];
    const document = asExportedConfig(YAML.parse(raw));
    const exported = Object.keys(
      document.spec.sandboxes.alpha!.network.policy.explicit.network_policies as object,
    );
    // OpenShell rejects a submitted key with its reserved prefix and rebuilds the entry from the
    // provider the destination attaches.
    expect(exported.filter((key) => key.startsWith("_provider_"))).toEqual([]);
    const base = Object.keys(YAML.parse(policy).network_policies);
    expect(exported).toEqual(base);
    expect(raw).toContain("\n# omitted network_policies._provider_nemoclaw_nvidia_prod_v1: ");
  });
});

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

  it("exports a source without a filesystem policy, with nothing to report for it (#14580)", async () => {
    const sourcePolicy = YAML.parse(policy);
    delete sourcePolicy.filesystem_policy;
    const baseline = snapshot();
    const observed = {
      ...baseline,
      policy: { ...baseline.policy, document: YAML.stringify(sourcePolicy) },
    };

    // filesystem_policy is not exported, so its absence no longer blocks migration.
    const result = await exportSnapshots([observed]);
    expect(result.outcome).toMatchObject({ ok: true, completion: { kind: "stdout" } });
    const raw = result.writeStdout.mock.calls[0]![0];
    expect(raw).not.toContain("# omitted network.policy.explicit.filesystem_policy");
  });

  it("exports a source whose process principal v1 cannot use, and reports it (#14580)", async () => {
    const sourcePolicy = YAML.parse(policy);
    sourcePolicy.process = { run_as_user: "daemon", run_as_group: "daemon" };
    const baseline = snapshot();
    const observed = {
      ...baseline,
      policy: { ...baseline.policy, document: YAML.stringify(sourcePolicy) },
    };

    // process is not exported, so the source principal no longer blocks migration.
    const result = await exportSnapshots([observed]);
    expect(result.outcome).toMatchObject({ ok: true, completion: { kind: "stdout" } });
    const raw = result.writeStdout.mock.calls[0]![0];
    expect(raw).toContain(
      '\n# omitted network.policy.explicit.process value={"run_as_group":"daemon","run_as_user":"daemon"}: ',
    );
  });
});
