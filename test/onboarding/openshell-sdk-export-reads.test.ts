// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { createProviders } from "../../src/lib/adapters/openshell/providers";
import { createSandboxes } from "../../src/lib/adapters/openshell/sandboxes";
import { createSandboxConfig } from "../../src/lib/adapters/openshell/sandbox-config";
import type { OpenShellReadClient } from "../../src/lib/adapters/openshell/sdk-read";

// CI stages the reviewed optional SDK artifact. Source-only checkouts can run
// the deterministic adapter tests without that artifact.
function hasSdkArtifact(): boolean {
  try {
    import.meta.resolve("@nvidia/openshell-sdk/raw");
    return true;
  } catch {
    return false;
  }
}

describe("released OpenShell SDK export reads", () => {
  it.skipIf(!hasSdkArtifact())(
    "accepts generated responses without losing identity or uint64 revisions",
    async () => {
      const sdkPackage = "@nvidia/openshell-sdk/raw";
      const protobufPackage = "@bufbuild/protobuf";
      const [raw, { create, toBinary, fromBinary }] = await Promise.all([
        import(sdkPackage),
        import(protobufPackage),
      ]);
      const metadata = {
        id: "resource-id",
        name: "alpha",
        workspace: "default",
        resourceVersion: 18446744073709551615n,
      };
      // Binary round trips exercise the released wire schemas and their defaults.
      const roundTrip = (schema: unknown, input: unknown) =>
        fromBinary(schema, toBinary(schema, create(schema, input)));
      const client: OpenShellReadClient = {
        raw: {
          getProvider: async () =>
            roundTrip(raw.OpenShell.method.getProvider.output, {
              provider: {
                metadata,
                type: "openai",
                credentials: { API_KEY: "REDACTED" },
                config: { OPENAI_BASE_URL: "https://api.example/v1" },
              },
            }),
          getSandbox: async () =>
            roundTrip(raw.OpenShell.method.getSandbox.output, {
              sandbox: {
                metadata,
                spec: { template: { image: "image@sha256:" + "a".repeat(64) } },
                status: { currentPolicyVersion: 3 },
              },
            }),
          getSandboxConfig: async () =>
            roundTrip(raw.GetSandboxConfigResponseSchema, {
              workspace: "default",
              version: 3,
              policyHash: "a".repeat(64),
              policySource: 1,
              configRevision: 9007199254740993n,
              providerEnvRevision: 18446744073709551615n,
            }),
        },
      };
      const connect = async () => client;
      const request = {
        target: { kind: "named", gatewayName: "nemoclaw" } as const,
        workspace: "default",
        name: "alpha",
        signal: new AbortController().signal,
      };
      expect(
        await createProviders(connect).get({ ...request, configKeys: ["OPENAI_BASE_URL"] }),
      ).toMatchObject({
        workspace: "default",
        resourceVersion: "18446744073709551615",
        config: { OPENAI_BASE_URL: "https://api.example/v1" },
      });
      expect(await createSandboxes(connect).get(request)).toMatchObject({
        id: "resource-id",
        policyVersion: 3,
        providers: [],
      });
      expect(
        await createSandboxConfig(connect).get({ ...request, sandboxId: "resource-id" }),
      ).toMatchObject({
        policySource: "sandbox",
        globalPolicyVersion: 0,
        configRevision: "9007199254740993",
        providerEnvRevision: "18446744073709551615",
      });
    },
  );
});
