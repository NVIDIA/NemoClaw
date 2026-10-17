// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenShellProviderAdapter } from "../../adapters/openshell/provider-adapter";
import {
  EXTRA_PLACEHOLDER_KEYS_ENV,
  registerExtraPlaceholderProviders,
} from "../../onboard/extra-placeholder-keys";
import {
  applyCredentialsAtOpenShell,
  isMessagingProviderBindingConflict,
} from "./openshell-provider";
import { buildMessagingProviderApplication } from "./provider-application";
import {
  target,
  plan,
  definition,
  metadata,
  providerAdapter,
} from "./__test-helpers__/provider-fixtures";

import { REPOSITORY_ROOT } from "../../core/repository-root";
import { exportedProviderProfileMatchesContract } from "../../adapters/openshell/provider-profile";
import {
  buildCredentialFamilyProfile,
  credentialFamilyProfileContract,
  credentialFamilyProfileType,
  matchesCredentialFamilyProfileType,
  withCredentialFamilyProfile,
} from "./credential-family-profile";

const profilePath = path.join(REPOSITORY_ROOT, "nemoclaw-blueprint/provider-profiles/brave.yaml");
const primary = "BRAVE_API_KEY";
const keys = [primary, `${primary}_TEAM`];

describe("additional provider credential declarations", () => {
  it("preserves the owned endpoint and executable boundaries while declaring the selected key", () => {
    const original = {
      id: "brave",
      display_name: "Brave Search",
      description: "Brave Search API access",
      category: "agent",
      credentials: [
        {
          name: "api_key",
          description: "Brave Search API key",
          env_vars: [primary],
          required: true,
          auth_style: "header",
          header_name: "x-subscription-token",
          query_param: "",
        },
      ],
      endpoints: [
        {
          host: "api.search.brave.com",
          port: 443,
          protocol: "rest",
          access: "read-write",
          enforcement: "enforce",
        },
      ],
      binaries: ["/usr/local/bin/node", "/usr/bin/node", "/usr/local/bin/curl", "/usr/bin/curl"],
      inference_capable: false,
    };
    const source = JSON.stringify(original);
    const generated = buildCredentialFamilyProfile(source, primary, keys);
    const profile = JSON.parse(generated.source);
    expect({ ...profile, id: original.id, credentials: original.credentials }).toEqual(original);
    expect(profile.credentials.at(-1)).toEqual({
      name: "BRAVE_API_KEY_TEAM",
      env_vars: ["BRAVE_API_KEY_TEAM"],
      required: false,
      auth_style: "header",
      header_name: "x-subscription-token",
      query_param: "",
    });
    const expected = credentialFamilyProfileContract(profilePath, primary, keys);
    expect(exportedProviderProfileMatchesContract(generated.source, expected)).toBe(true);
    profile.endpoints.push({ host: "unowned.example", port: 443 });
    expect(exportedProviderProfileMatchesContract(JSON.stringify(profile), expected)).toBe(false);
  });

  it("binds the profile to credential names regardless of input order", () => {
    const type = credentialFamilyProfileType("brave", primary, keys);
    expect(credentialFamilyProfileType("brave", primary, [...keys].reverse())).toBe(type);
    expect(matchesCredentialFamilyProfileType(type, "brave", primary, keys)).toBe(true);
    expect(matchesCredentialFamilyProfileType(type, "brave", primary, [primary])).toBe(false);
    expect(matchesCredentialFamilyProfileType(type, "tavily", primary, keys)).toBe(false);
  });

  it.each([
    [primary, "GITHUB_TOKEN"],
    [primary, `${primary}_`],
    [primary, `${primary}_TEAM`, `${primary}_TEAM`],
    [primary, `${primary}_TEAM\nOTHER_KEY`],
    [`${primary}_TEAM`],
  ])("rejects names outside the selected credential family: %j", (...invalid) => {
    expect(() =>
      buildCredentialFamilyProfile(fs.readFileSync(profilePath, "utf8"), primary, invalid),
    ).toThrow();
  });

  it("removes the private profile file when its consumer fails", async () => {
    let temporaryPath = "";
    await expect(
      withCredentialFamilyProfile(profilePath, primary, keys, async (profile) => {
        temporaryPath = profile.profilePath;
        expect(fs.statSync(temporaryPath).mode & 0o777).toBe(0o600);
        expect(fs.statSync(path.dirname(temporaryPath)).mode & 0o777).toBe(0o700);
        throw new Error("import failed");
      }),
    ).rejects.toThrow("import failed");
    expect(fs.existsSync(path.dirname(temporaryPath))).toBe(false);
  });
});

describe("additional credential provider lifecycle", () => {
  it.each([false, true])(
    "preserves legacy extra credentials when the missing key is declared: %s",
    async (declareMissing) => {
      const requested = definition({
        profile: {
          profilePath: path.join(
            REPOSITORY_ROOT,
            "nemoclaw-blueprint/provider-profiles/nemoclaw-messaging-v1.yaml",
          ),
          profileType: "nemoclaw-messaging-v1",
        },
      });
      const completeCredentials = [
        ...requested.credentials,
        { name: "TELEGRAM_BOT_TOKEN_TEAM", value: "telegram-team-secret" },
      ];
      const existing = metadata({
        ...requested,
        providerType: "nemoclaw-mcp-v1",
        credentials: completeCredentials,
      });
      const adapter = providerAdapter({
        getProvider: vi
          .fn<OpenShellProviderAdapter["getProvider"]>()
          .mockResolvedValue({ ok: true, value: existing }),
      });
      await expect(
        applyCredentialsAtOpenShell(plan, {
          target,
          providerAdapter: adapter,
          definitions: [
            {
              ...requested,
              credentials: declareMissing
                ? [...requested.credentials, { name: "TELEGRAM_BOT_TOKEN_TEAM", value: null }]
                : requested.credentials,
            },
          ],
          replaceExisting: true,
        }),
      ).rejects.toThrow("cannot be replaced without every stored credential");
      expect(adapter.importProviderProfile).not.toHaveBeenCalled();
      expect(adapter.deleteProvider).not.toHaveBeenCalled();
      expect(adapter.createProvider).not.toHaveBeenCalled();
      expect(adapter.updateProvider).not.toHaveBeenCalled();

      const complete = { ...requested, credentials: completeCredentials };
      const replacementType = credentialFamilyProfileType(
        requested.providerType,
        requested.credentialId,
        completeCredentials.map(({ name }) => name),
      );
      vi.mocked(adapter.getProvider)
        .mockReset()
        .mockResolvedValueOnce({ ok: true, value: existing })
        .mockResolvedValueOnce({
          ok: true,
          value: metadata({ ...complete, providerType: replacementType }),
        });
      await applyCredentialsAtOpenShell(plan, {
        target,
        providerAdapter: adapter,
        definitions: [complete],
        replaceExisting: true,
      });
      expect(adapter.deleteProvider).toHaveBeenCalledExactlyOnceWith({
        target,
        providerName: requested.providerName,
      });
      expect(adapter.createProvider).toHaveBeenCalledExactlyOnceWith({
        target,
        name: requested.providerName,
        type: replacementType,
        credentials: completeCredentials,
        config: [],
        fromExisting: false,
      });
      expect(adapter.updateProvider).not.toHaveBeenCalled();
    },
  );

  it("omits an absent optional credential when creating a provider (#11190)", async () => {
    const tokenDefs = [
      {
        name: "alpha-telegram-bridge",
        envKey: "TELEGRAM_BOT_TOKEN",
        token: "telegram-secret",
        providerType: "nemoclaw-messaging-v1",
      },
    ];
    const warnings: string[] = [];
    const acceptedKeys = registerExtraPlaceholderProviders(
      tokenDefs,
      (message) => {
        warnings.push(message);
      },
      {
        env: {
          [EXTRA_PLACEHOLDER_KEYS_ENV]:
            "TELEGRAM_BOT_TOKEN_AGENT_A TELEGRAM_BOT_TOKEN_AGENT_MISSING GITHUB_TOKEN",
          TELEGRAM_BOT_TOKEN_AGENT_A: "telegram-agent-a-secret",
          TELEGRAM_BOT_TOKEN_AGENT_MISSING: undefined,
          GITHUB_TOKEN: "arbitrary-host-secret",
        },
        getCredential: () => null,
        normalizeCredentialValue: (value) => value?.trim() ?? "",
      },
    );
    const application = buildMessagingProviderApplication({
      tokenDefs,
      root: REPOSITORY_ROOT,
      agent: "openclaw",
      getCredential: () => null,
      profiles: [],
    });
    const builtDefinition = application.definitions[0]!;
    const expected = {
      ...builtDefinition,
      credentials: [
        builtDefinition.credentials[2]!,
        builtDefinition.credentials[0]!,
        builtDefinition.credentials[1]!,
      ],
    };
    const createdCredentials = expected.credentials.filter(({ value }) => value !== null);
    const createdType = credentialFamilyProfileType(
      expected.providerType,
      "TELEGRAM_BOT_TOKEN",
      createdCredentials.map(({ name }) => name),
    );
    const adapter = providerAdapter({
      getProvider: vi
        .fn<OpenShellProviderAdapter["getProvider"]>()
        .mockResolvedValueOnce({
          ok: false,
          error: { kind: "command", reason: "not_found", message: "provider not found" },
        })
        .mockResolvedValueOnce({
          ok: true,
          value: metadata({
            ...expected,
            providerType: createdType,
            credentials: createdCredentials,
          }),
        }),
    });

    await applyCredentialsAtOpenShell(plan, {
      providerAdapter: adapter,
      target,
      definitions: [expected],
      requireCompleteBindings: true,
    });

    expect(adapter.createProvider).toHaveBeenCalledWith({
      target,
      name: expected.providerName,
      type: createdType,
      credentials: createdCredentials,
      config: [],
      fromExisting: false,
    });
    expect(acceptedKeys).toEqual([
      "TELEGRAM_BOT_TOKEN_AGENT_A",
      "TELEGRAM_BOT_TOKEN_AGENT_MISSING",
    ]);
    expect(warnings.some((warning) => warning.includes('"GITHUB_TOKEN"'))).toBe(true);
    expect(JSON.stringify(application)).not.toContain("arbitrary-host-secret");

    vi.mocked(adapter.getProvider).mockResolvedValue({
      ok: true,
      value: metadata({ ...expected, providerType: createdType, credentials: createdCredentials }),
    });
    vi.mocked(adapter.createProvider).mockClear();
    const retryDefinition = {
      ...expected,
      credentials: expected.credentials.map(({ name }) => ({ name, value: null })),
    };

    const retry = await applyCredentialsAtOpenShell(plan, {
      providerAdapter: adapter,
      target,
      definitions: [retryDefinition],
      requireCompleteBindings: true,
    });

    expect(retry.reused).toEqual([
      expect.objectContaining({ providerName: expected.providerName }),
    ]);
    expect(adapter.createProvider).not.toHaveBeenCalled();
    expect(adapter.updateProvider).not.toHaveBeenCalled();
    expect(adapter.deleteProvider).not.toHaveBeenCalled();

    const expandedCredentials = expected.credentials.map((credential) =>
      credential.name === "TELEGRAM_BOT_TOKEN_AGENT_MISSING"
        ? { ...credential, value: "telegram-agent-missing-secret" }
        : credential,
    );
    const expandedType = credentialFamilyProfileType(
      expected.providerType,
      "TELEGRAM_BOT_TOKEN",
      expandedCredentials.map(({ name }) => name),
    );
    const existing = metadata({
      ...expected,
      providerType: createdType,
      credentials: createdCredentials,
    });
    vi.mocked(adapter.getProvider).mockResolvedValue({ ok: true, value: existing });

    await expect(
      applyCredentialsAtOpenShell(plan, {
        providerAdapter: adapter,
        target,
        definitions: [{ ...expected, credentials: expandedCredentials }],
        requireCompleteBindings: true,
      }),
    ).rejects.toSatisfy(isMessagingProviderBindingConflict);
    expect(adapter.deleteProvider).not.toHaveBeenCalled();

    vi.mocked(adapter.importProviderProfile).mockClear();
    await expect(
      applyCredentialsAtOpenShell(plan, {
        providerAdapter: adapter,
        target,
        definitions: [
          {
            ...expected,
            credentials: expandedCredentials.map((credential) =>
              credential.name === "TELEGRAM_BOT_TOKEN_AGENT_A"
                ? { ...credential, value: null }
                : credential,
            ),
          },
        ],
        requireCompleteBindings: true,
        replaceExisting: true,
      }),
    ).rejects.toThrow("cannot be replaced without every stored credential");
    expect(adapter.importProviderProfile).not.toHaveBeenCalled();
    expect(adapter.deleteProvider).not.toHaveBeenCalled();
    expect(adapter.createProvider).not.toHaveBeenCalled();
    expect(adapter.updateProvider).not.toHaveBeenCalled();

    vi.mocked(adapter.getProvider)
      .mockReset()
      .mockResolvedValueOnce({ ok: true, value: existing })
      .mockResolvedValueOnce({
        ok: true,
        value: metadata({
          ...expected,
          providerType: expandedType,
          credentials: expandedCredentials,
        }),
      });
    await applyCredentialsAtOpenShell(plan, {
      providerAdapter: adapter,
      target,
      definitions: [{ ...expected, credentials: expandedCredentials }],
      requireCompleteBindings: true,
      replaceExisting: true,
    });

    expect(adapter.createProvider).toHaveBeenCalledWith({
      target,
      name: expected.providerName,
      type: expandedType,
      credentials: expandedCredentials,
      config: [],
      fromExisting: false,
    });
    expect(adapter.updateProvider).not.toHaveBeenCalled();
    expect(adapter.deleteProvider).toHaveBeenCalledExactlyOnceWith({
      target,
      providerName: expected.providerName,
    });
  });
});
