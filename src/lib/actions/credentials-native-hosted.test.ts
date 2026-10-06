// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NATIVE_HOSTED_PROFILES } from "../inference/native-hosted/profiles";
import { providerAdapter } from "../../../test/helpers/credentials-provider-adapter";
import { runCredentialsAddAction } from "./credentials-add";
import { setGlobalCliActionRuntimeHooksForTest } from "./global";

vi.mock("../onboard/gateway-teardown-authority", () => ({
  resolveGatewayCredentialMutationAuthority: vi.fn(() => ({})),
}));
vi.mock("../state/mcp-lifecycle-lock/credential-ownership", () => ({
  withMcpCredentialOwnershipLock: <T>(operation: () => Promise<T> | T) => operation(),
}));

describe("native hosted credential registration", () => {
  beforeEach(() => {
    setGlobalCliActionRuntimeHooksForTest({
      recoverNamedGatewayRuntime: async () => ({ recovered: true }),
      recordExtraProvider: () => true,
      forgetExtraProvider: () => true,
    });
  });
  afterEach(() => {
    setGlobalCliActionRuntimeHooksForTest({});
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  it.each(NATIVE_HOSTED_PROFILES.filter((profile) => profile.logicalProvider !== "nvidia-prod"))(
    "records standalone $label ownership after confirmed registration",
    async (profile) => {
      const recordExtraProvider = vi
        .spyOn(await import("./global"), "recordExtraProvider")
        .mockReturnValue(true);
      vi.stubEnv(profile.credentialEnv, "host-only-test-value");
      let present = false;
      const adapter = providerAdapter({
        getProvider: vi.fn(async () =>
          present
            ? {
                ok: true as const,
                value: {
                  name: profile.providerName,
                  type: profile.profileId,
                  credentialKeys: [profile.credentialEnv],
                  configKeys: [],
                  revision: { id: "registered-id", resourceVersion: 1 },
                },
              }
            : {
                ok: false as const,
                error: {
                  kind: "command" as const,
                  reason: "not_found" as const,
                  message: "not found",
                },
              },
        ),
        createProvider: vi.fn(async () => {
          present = true;
          return { ok: true as const };
        }),
      });
      const save = vi.fn();
      const result = await runCredentialsAddAction(
        {
          provider: profile.logicalProvider,
          type: profile.profileId,
          credentials: [profile.credentialEnv],
          configPairs: [],
          fromExisting: false,
        },
        {
          providerAdapter: adapter,
          getNativeHostedProviderAuthority: () => undefined,
          setNativeHostedProviderAuthority: save,
        },
      );
      expect(result.exitCode).toBe(0);
      expect(save).toHaveBeenCalledWith("nemoclaw", {
        schemaVersion: 1,
        profileId: profile.profileId,
        providerName: profile.providerName,
        providerId: "registered-id",
      });
      expect(recordExtraProvider).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("host-only-test-value");
    },
  );
});
