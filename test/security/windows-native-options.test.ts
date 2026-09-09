// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import {
  createNativeServiceBootstrap,
  nativeOpenClawOptions,
  nativeServiceBinding,
  normalizeNativeOptions,
} from "../../packaging/windows/runtime/native-options.mts";
import { nativeCredentialBinding } from "../../packaging/windows/runtime/native-security.mts";

describe("native optional services", () => {
  it("filters services by real agent capability and validates sender identities", () => {
    expect(
      normalizeNativeOptions("hermes", { search: { provider: "tavily", credentialStored: true } }),
    ).toEqual({ search: { provider: "tavily", credentialStored: true } });
    expect(() =>
      normalizeNativeOptions("hermes", {
        messaging: { slack: { credentialStored: true, allowedUsers: [] } },
      }),
    ).toThrow();
    expect(() => normalizeNativeOptions("pi", { messaging: {} })).toThrow();
    expect(() =>
      normalizeNativeOptions("openclaw", {
        search: { provider: "brave", credentialStored: true, apiKey: "must-not-persist" },
      }),
    ).toThrow();
  });

  it.each(["hermes", "pi", "langchain-deepagents-code", "nemocua"])(
    "rejects unsupported Brave selection for %s",
    (agent) => {
      expect(() =>
        normalizeNativeOptions(agent, { search: { provider: "brave", credentialStored: true } }),
      ).toThrow();
    },
  );

  it.each([
    { allowedUsers: ["*"] },
    { allowedUsers: ["<script>"] },
    { allowedUsers: ["1\n2"] },
    { allowedUsers: [1] },
  ])("rejects invalid sender identities %j", ({ allowedUsers }) => {
    expect(() =>
      normalizeNativeOptions("openclaw", {
        messaging: { telegram: { credentialStored: true, allowedUsers } },
      }),
    ).toThrow();
  });

  it("keeps Personal network selection separate from incoming sender authorization", () => {
    const options = normalizeNativeOptions("openclaw", {
      messaging: {
        telegram: { credentialStored: true, allowedUsers: [] },
        discord: { credentialStored: true, allowedUsers: ["1234", "1234"] },
      },
    });
    expect(nativeOpenClawOptions(options).channels).toEqual({
      telegram: {
        enabled: true,
        accounts: { default: { enabled: true, dmPolicy: "pairing", groupPolicy: "disabled" } },
      },
      discord: {
        enabled: true,
        accounts: {
          default: {
            enabled: true,
            dmPolicy: "allowlist",
            allowFrom: ["1234"],
            groupPolicy: "disabled",
          },
        },
      },
    });
  });

  it("domain-separates service, agent, and inference credentials", () => {
    const bindings = [
      nativeServiceBinding("openclaw", "tavily"),
      nativeServiceBinding("hermes", "tavily"),
      nativeServiceBinding("openclaw", "brave"),
      nativeCredentialBinding({
        agent: "openclaw",
        inference: "compatible",
        endpoint: "https://api.tavily.com",
      }),
    ];
    expect(new Set(bindings).size).toBe(bindings.length);
    expect(() => nativeServiceBinding("openclaw", "nvidia")).toThrow();
    expect(() => nativeServiceBinding("../hermes", "tavily")).toThrow();
  });

  it("delivers opted-in service keys once to an authenticated native bootstrap", async () => {
    const selected = {
      options: normalizeNativeOptions("hermes", {
        search: { provider: "tavily", credentialStored: true },
      }),
      environment: { TAVILY_API_KEY: "service-control-canary" },
    };
    const handler = createNativeServiceBootstrap(selected, "ephemeral-control-token");
    const server = createServer(handler);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/native/bootstrap`;
    try {
      expect((await fetch(url, { method: "POST" })).status).toBe(403);
      expect(
        (
          await fetch(url, {
            method: "POST",
            headers: {
              authorization: "Bearer ephemeral-control-token",
              origin: "https://untrusted.example",
            },
          })
        ).status,
      ).toBe(403);
      const response = await fetch(url, {
        method: "POST",
        headers: { authorization: "Bearer ephemeral-control-token" },
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({
        environment: { TAVILY_API_KEY: "service-control-canary" },
        options: { search: { provider: "tavily" } },
      });
      expect(selected.environment).toEqual({});
      expect(
        (
          await fetch(url, {
            method: "POST",
            headers: { authorization: "Bearer ephemeral-control-token" },
          })
        ).status,
      ).toBe(403);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
