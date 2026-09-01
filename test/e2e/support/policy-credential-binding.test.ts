// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

const policyMocks = vi.hoisted(() => ({
  inspectPolicyMutationContext: vi.fn(),
  setPolicyDocument: vi.fn(),
}));

vi.mock("../../../src/lib/policy/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/lib/policy/index.ts")>()),
  inspectPolicyMutationContext: policyMocks.inspectPolicyMutationContext,
  setPolicyDocument: policyMocks.setPolicyDocument,
}));

import { requireSuccessfulPolicyBoundaryBuild } from "../fixtures/hermes-discord-policy-boundary-build.ts";
import { policyDocumentWithEndpointCredentialBinding } from "../fixtures/policy-credential-binding.ts";
import { applyPolicyCredentialBinding } from "../live/policy-credential-binding.ts";

const TYPESCRIPT = path.resolve("node_modules/typescript/bin/tsc");
const POLICY_BOUNDARY_CONFIG = path.resolve("nemoclaw/tsconfig.shared.json");

function endpointPolicy(protocols: string[]): string {
  return [
    "version: 1",
    "network_policies:",
    "  fake:",
    "    endpoints:",
    ...protocols.flatMap((protocol) => [
      "      - host: host.openshell.internal",
      "        port: 43117",
      `        protocol: ${protocol}`,
    ]),
    "",
  ].join("\n");
}

function policyWithBinding(provider: string): string {
  const policy = YAML.parse(endpointPolicy(["rest", "websocket"]));
  policy.network_policies.fake.endpoints[0].credential_binding = { provider };
  return YAML.stringify(policy);
}

describe("binds a credential to exactly one policy endpoint", () => {
  beforeAll(async () => {
    const result = spawnSync(process.execPath, [TYPESCRIPT, "-p", POLICY_BOUNDARY_CONFIG], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      timeout: 15_000,
    });
    await requireSuccessfulPolicyBoundaryBuild(result);
  });

  beforeEach(() => {
    policyMocks.inspectPolicyMutationContext.mockReset();
    policyMocks.setPolicyDocument.mockReset();
  });

  it("strips OpenShell revision metadata before binding the fake Gateway endpoint", () => {
    const result = policyDocumentWithEndpointCredentialBinding(
      [
        "Config rev:   15880558010371530494",
        "---",
        "version: 1",
        "network_policies:",
        "  discord_gateway:",
        "    endpoints:",
        "      - host: host.openshell.internal",
        "        port: 43117",
        "        protocol: websocket",
        "      - host: discord.com",
        "        port: 443",
        "",
      ].join("\n"),
      "e2e-hermes-discord-discord-bridge",
      "host.openshell.internal",
      43117,
      "websocket",
    );

    expect(YAML.parse(result)).toEqual({
      version: 1,
      network_policies: {
        discord_gateway: {
          endpoints: [
            {
              host: "host.openshell.internal",
              port: 43117,
              protocol: "websocket",
              credential_binding: { provider: "e2e-hermes-discord-discord-bridge" },
            },
            { host: "discord.com", port: 443 },
          ],
        },
      },
    });
  });

  it.each(["rest", "websocket"] as const)(
    "binds only the requested %s endpoint when host and port are shared",
    (protocol) => {
      const result = policyDocumentWithEndpointCredentialBinding(
        endpointPolicy(["rest", "websocket"]),
        "e2e-policy-provider",
        "host.openshell.internal",
        43117,
        protocol,
      );
      const endpoints = YAML.parse(result).network_policies.fake.endpoints as Array<
        Record<string, unknown>
      >;

      expect(endpoints.find((endpoint) => endpoint.protocol === protocol)).toHaveProperty(
        "credential_binding",
        { provider: "e2e-policy-provider" },
      );
      expect(endpoints.find((endpoint) => endpoint.protocol !== protocol)).not.toHaveProperty(
        "credential_binding",
      );
    },
  );

  it("rejects a missing endpoint", () => {
    expect(() =>
      policyDocumentWithEndpointCredentialBinding(
        endpointPolicy(["websocket"]),
        "e2e-policy-provider",
        "host.openshell.internal",
        43117,
        "rest",
      ),
    ).toThrow("fake endpoint host.openshell.internal:43117/rest is missing from the base policy");
  });

  it("rejects duplicate endpoint ownership across network policies", () => {
    const duplicate = YAML.parse(endpointPolicy(["websocket"]));
    duplicate.network_policies.second = duplicate.network_policies.fake;

    expect(() =>
      policyDocumentWithEndpointCredentialBinding(
        YAML.stringify(duplicate),
        "e2e-policy-provider",
        "host.openshell.internal",
        43117,
        "websocket",
      ),
    ).toThrow("matches 2 base policy entries; expected exactly one");
  });

  it("rejects a conflicting credential binding", () => {
    expect(() =>
      policyDocumentWithEndpointCredentialBinding(
        policyWithBinding("external-policy-provider"),
        "e2e-policy-provider",
        "host.openshell.internal",
        43117,
        "rest",
      ),
    ).toThrow("already has a conflicting credential binding");
  });

  it("delegates the transformed policy and binding invariant to the production mutation owner", () => {
    const basePolicy = endpointPolicy(["rest", "websocket"]);
    const context = {
      gatewayName: "nemoclaw",
      inspection: {},
      basePolicyDocument: basePolicy,
    };
    policyMocks.inspectPolicyMutationContext.mockReturnValue(context);
    policyMocks.setPolicyDocument.mockImplementation(
      (sandboxName: string, requestedDocument: string, options: Record<string, unknown>) => {
        expect(sandboxName).toBe("e2e-policy-transaction");
        expect(options).toMatchObject({ context, nonFatal: true });
        expect(YAML.parse(requestedDocument).network_policies.fake.endpoints[0]).toHaveProperty(
          "credential_binding",
          { provider: "e2e-policy-provider" },
        );
        const validate = options.reconciledDocumentIsAcceptable as (document: string) => boolean;
        expect(validate(requestedDocument)).toBe(true);
        expect(validate(policyWithBinding("external-policy-provider"))).toBe(false);
        return true;
      },
    );

    applyPolicyCredentialBinding({
      sandboxName: "e2e-policy-transaction",
      providerName: "e2e-policy-provider",
      endpointHost: "host.openshell.internal",
      endpointPort: 43117,
      protocol: "rest",
    });

    expect(policyMocks.setPolicyDocument).toHaveBeenCalledOnce();
  });

  it("reports a production mutation failure to the live caller", () => {
    policyMocks.inspectPolicyMutationContext.mockReturnValue({
      gatewayName: "nemoclaw",
      inspection: {},
      basePolicyDocument: endpointPolicy(["rest"]),
    });
    policyMocks.setPolicyDocument.mockReturnValue(false);

    expect(() =>
      applyPolicyCredentialBinding({
        sandboxName: "e2e-policy-transaction",
        providerName: "e2e-policy-provider",
        endpointHost: "host.openshell.internal",
        endpointPort: 43117,
        protocol: "rest",
      }),
    ).toThrow("failed to bind the e2e-policy-provider credential provider");
  });
});
