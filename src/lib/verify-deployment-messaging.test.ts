// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildChain } from "../../dist/lib/dashboard/contract.js";
import { verifyDeployment } from "../../dist/lib/verify-deployment.js";

const chain = buildChain();
const NO_RETRY = { retryDelaysMs: [], sleep: async (_ms: number) => {} };

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    executeSandboxCommand: (_name: string, _script: string) => ({ status: 0, stdout: "200", stderr: "" }),
    probeHostPort: (_port: number, _path: string) => 200,
    captureForwardList: () => "my-sandbox  127.0.0.1  18789  12345  running",
    getMessagingChannels: (_name: string) => [] as string[],
    providerExistsInGateway: (_name: string) => true,
    ...overrides,
  };
}

describe("verifyDeployment messaging provider checks", () => {
  it("checks sandbox-scoped provider names for configured messaging channels", async () => {
    const checkedProviders: string[] = [];
    const deps = makeDeps({
      getMessagingChannels: () => ["telegram", "slack"],
      providerExistsInGateway: (name: string) => {
        checkedProviders.push(name);
        return true;
      },
    });

    const result = await verifyDeployment("my-sandbox", chain, deps, NO_RETRY);

    expect(result.verification.messagingBridgesHealthy).toBe(true);
    expect(checkedProviders).toEqual([
      "my-sandbox-telegram-bridge",
      "my-sandbox-slack-bridge",
      "my-sandbox-slack-app",
    ]);
  });

  it.each(["my-sandbox-slack-bridge", "my-sandbox-slack-app"])(
    "warns when Slack provider %s is missing",
    async (missingProvider) => {
      const deps = makeDeps({
        getMessagingChannels: () => ["slack"],
        providerExistsInGateway: (name: string) => name !== missingProvider,
      });

      const result = await verifyDeployment("my-sandbox", chain, deps, NO_RETRY);

      expect(result.healthy).toBe(true);
      expect(result.verification.messagingBridgesHealthy).toBe(false);
      const msgDiag = result.diagnostics.find((d) => d.link === "messaging");
      expect(msgDiag?.status).toBe("warn");
      expect(msgDiag?.detail).toContain("slack");
    },
  );

  it("does not require a gateway provider for tokenless messaging channels", async () => {
    const checkedProviders: string[] = [];
    const deps = makeDeps({
      getMessagingChannels: () => ["whatsapp"],
      providerExistsInGateway: (name: string) => {
        checkedProviders.push(name);
        return false;
      },
    });

    const result = await verifyDeployment("my-sandbox", chain, deps, NO_RETRY);

    expect(result.verification.messagingBridgesHealthy).toBe(true);
    expect(checkedProviders).toEqual([]);
    expect(result.diagnostics.find((d) => d.link === "messaging")).toBeUndefined();
  });
});
