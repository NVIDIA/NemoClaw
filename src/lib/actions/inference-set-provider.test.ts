// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type {
  OpenShellProviderAdapter,
  OpenShellProviderMetadata,
} from "../adapters/openshell/provider-adapter";
import { endpointlessProviderProfilePath } from "../adapters/openshell/provider-profile";
import { OPENAI_GATEWAY_PROVIDER_TYPE } from "../adapters/openshell/provider-profile-registration";
import { REPOSITORY_ROOT } from "../core/repository-root";
import {
  assertInferenceSetProviderOwnership,
  prepareInferenceSetProviderBinding,
} from "./inference-set-provider";
import type { HttpsPinProviderBinding } from "./inference-set-route-containment";

const PROVIDER_ID = "11111111-2222-4333-8444-555555555555";
const TARGET = { kind: "named", gatewayName: "nemoclaw" } as const;

function binding(overrides: Partial<HttpsPinProviderBinding> = {}): HttpsPinProviderBinding {
  return {
    baseUrl: "http://host.openshell.internal:11438/route/route-a/v1",
    credentialEnv: "COMPATIBLE_API_KEY",
    token: "route-token-a",
    routeId: "route-a",
    providerType: "openai",
    ...overrides,
  };
}

function metadata(overrides: Partial<OpenShellProviderMetadata> = {}): OpenShellProviderMetadata {
  return {
    name: "compatible-endpoint",
    type: "openai",
    credentialKeys: ["COMPATIBLE_API_KEY"],
    configKeys: ["OPENAI_BASE_URL"],
    revision: { id: PROVIDER_ID, resourceVersion: 4 },
    ...overrides,
  };
}

function providerAdapter(
  overrides: Partial<OpenShellProviderAdapter> = {},
): OpenShellProviderAdapter {
  return {
    listProviders: vi.fn(async () => ({ ok: true, value: { names: [] } }) as const),
    createProvider: vi.fn(async () => ({ ok: true }) as const),
    getProvider: vi.fn(
      async () =>
        ({
          ok: false,
          error: { kind: "command", reason: "not_found", message: "provider not found" },
        }) as const,
    ),
    updateProvider: vi.fn(async () => ({ ok: true }) as const),
    importProviderProfile: vi.fn(async () => ({ ok: true }) as const),
    inspectProviderProfile: vi.fn(
      async () => ({ ok: true, value: { credentialKeys: [] } }) as const,
    ),
    deleteProvider: vi.fn(async () => ({ ok: true }) as const),
    detachProvider: vi.fn(async () => ({ ok: true }) as const),
    ...overrides,
  };
}

describe("inference set provider binding", () => {
  it("updates an owned provider when its revision remains unchanged (#9806)", async () => {
    const getProvider = vi
      .fn<OpenShellProviderAdapter["getProvider"]>()
      .mockResolvedValueOnce({ ok: true, value: metadata() })
      .mockResolvedValueOnce({ ok: true, value: metadata() })
      .mockResolvedValueOnce({ ok: true, value: metadata() })
      .mockResolvedValueOnce({
        ok: true,
        value: metadata({ revision: { id: PROVIDER_ID, resourceVersion: 5 } }),
      });
    const importProviderProfile = vi.fn(async () => ({ ok: true as const }));
    const updateProvider = vi.fn(async () => ({ ok: true as const }));
    const adapter = providerAdapter({
      getProvider,
      importProviderProfile,
      updateProvider,
    });

    const mutation = await prepareInferenceSetProviderBinding({
      gatewayName: "nemoclaw",
      providerName: "compatible-endpoint",
      binding: binding(),
      providerAdapter: adapter,
    });
    await mutation.commit();

    expect(getProvider.mock.calls).toEqual([
      [{ target: TARGET, providerName: "compatible-endpoint" }],
      [{ target: TARGET, providerName: "compatible-endpoint" }],
      [{ target: TARGET, providerName: "compatible-endpoint" }],
      [{ target: TARGET, providerName: "compatible-endpoint" }],
    ]);
    expect(importProviderProfile).toHaveBeenCalledExactlyOnceWith({
      target: TARGET,
      profilePath: endpointlessProviderProfilePath(REPOSITORY_ROOT, OPENAI_GATEWAY_PROVIDER_TYPE),
    });
    expect(updateProvider).toHaveBeenCalledExactlyOnceWith({
      target: TARGET,
      providerName: "compatible-endpoint",
      credentials: [{ name: "COMPATIBLE_API_KEY", value: "route-token-a" }],
      config: [
        {
          key: "OPENAI_BASE_URL",
          value: "http://host.openshell.internal:11438/route/route-a/v1",
        },
      ],
    });
  });

  it("creates an absent provider and verifies its revision (#9806)", async () => {
    const getProvider = vi
      .fn<OpenShellProviderAdapter["getProvider"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "command", reason: "not_found", message: "provider not found" },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: metadata({ revision: { id: PROVIDER_ID, resourceVersion: 1 } }),
      });
    const createProvider = vi.fn(async () => ({ ok: true as const }));
    const adapter = providerAdapter({ getProvider, createProvider });

    const mutation = await prepareInferenceSetProviderBinding({
      gatewayName: "nemoclaw",
      providerName: "compatible-endpoint",
      binding: binding(),
      providerAdapter: adapter,
    });

    expect(mutation.action).toBe("create");
    expect(createProvider).toHaveBeenCalledExactlyOnceWith({
      target: TARGET,
      name: "compatible-endpoint",
      type: "openai",
      credentials: [{ name: "COMPATIBLE_API_KEY", value: "route-token-a" }],
      config: [
        {
          key: "OPENAI_BASE_URL",
          value: "http://host.openshell.internal:11438/route/route-a/v1",
        },
      ],
      fromExisting: false,
    });
  });

  it("does not inspect an OpenAI profile for an Anthropic provider (#9806)", async () => {
    const getProvider = vi
      .fn<OpenShellProviderAdapter["getProvider"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "command", reason: "not_found", message: "provider not found" },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: metadata({
          name: "compatible-anthropic-endpoint",
          type: "anthropic",
          credentialKeys: ["ANTHROPIC_API_KEY"],
          configKeys: ["ANTHROPIC_BASE_URL"],
          revision: { id: PROVIDER_ID, resourceVersion: 1 },
        }),
      });
    const createProvider = vi.fn(async () => ({ ok: true as const }));
    const importProviderProfile = vi.fn(async () => ({ ok: true as const }));
    const adapter = providerAdapter({
      getProvider,
      createProvider,
      importProviderProfile,
    });

    await prepareInferenceSetProviderBinding({
      gatewayName: "nemoclaw",
      providerName: "compatible-anthropic-endpoint",
      binding: binding({ providerType: "anthropic", credentialEnv: "ANTHROPIC_API_KEY" }),
      providerAdapter: adapter,
    });

    expect(importProviderProfile).not.toHaveBeenCalled();
    expect(createProvider).toHaveBeenCalledOnce();
  });

  it("does not update an OpenAI provider when provider profile preparation fails (#9895)", async () => {
    const updateProvider = vi.fn(async () => ({ ok: true as const }));
    const adapter = providerAdapter({
      getProvider: vi.fn(async () => ({ ok: true as const, value: metadata() })),
      importProviderProfile: vi.fn(async () => ({
        ok: false as const,
        error: {
          kind: "command" as const,
          reason: "failed" as const,
          message: "redacted profile failure",
        },
      })),
      updateProvider,
    });
    const mutation = await prepareInferenceSetProviderBinding({
      gatewayName: "nemoclaw",
      providerName: "compatible-endpoint",
      binding: binding(),
      providerAdapter: adapter,
    });

    await expect(mutation.commit()).rejects.toThrow(
      "redacted profile failure. Fix the reported OpenShell provider profile error, then rerun this command.",
    );
    expect(updateProvider).not.toHaveBeenCalled();
  });

  it.each([
    ["foreign credential", metadata({ credentialKeys: ["FOREIGN_TOKEN"] })],
    ["missing revision", metadata({ revision: null })],
  ])("fails closed before mutation for %s metadata (#9806)", async (_case, observed) => {
    const updateProvider = vi.fn(async () => ({ ok: true as const }));
    const importProviderProfile = vi.fn(async () => ({ ok: true as const }));
    const adapter = providerAdapter({
      getProvider: vi.fn(async () => ({ ok: true as const, value: observed })),
      updateProvider,
      importProviderProfile,
    });

    await expect(
      prepareInferenceSetProviderBinding({
        gatewayName: "nemoclaw",
        providerName: "compatible-endpoint",
        binding: binding(),
        providerAdapter: adapter,
      }),
    ).rejects.toThrow(
      _case === "foreign credential"
        ? "malformed, foreign"
        : "Update OpenShell with `scripts/install-openshell.sh`, then rerun this command.",
    );
    expect(updateProvider).not.toHaveBeenCalled();
    expect(importProviderProfile).not.toHaveBeenCalled();
  });

  it("does not infer absence from an authentication failure (#9806)", async () => {
    const createProvider = vi.fn(async () => ({ ok: true as const }));
    const adapter = providerAdapter({
      getProvider: vi.fn(async () => ({
        ok: false as const,
        error: {
          kind: "authentication" as const,
          message: "OpenShell could not authenticate the provider operation.",
        },
      })),
      createProvider,
    });

    await expect(
      prepareInferenceSetProviderBinding({
        gatewayName: "nemoclaw",
        providerName: "compatible-endpoint",
        binding: binding(),
        providerAdapter: adapter,
      }),
    ).rejects.toThrow("no provider mutation was attempted");
    expect(createProvider).not.toHaveBeenCalled();
  });

  it.each([
    ["advanced revision", metadata({ revision: { id: PROVIDER_ID, resourceVersion: 5 } })],
    [
      "replaced identity",
      metadata({
        revision: {
          id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          resourceVersion: 4,
        },
      }),
    ],
  ])("refuses a stale revision immediately before update: %s (#9806)", async (_case, current) => {
    const getProvider = vi
      .fn<OpenShellProviderAdapter["getProvider"]>()
      .mockResolvedValueOnce({ ok: true, value: metadata() })
      .mockResolvedValueOnce({ ok: true, value: current });
    const importProviderProfile = vi.fn(async () => ({ ok: true as const }));
    const updateProvider = vi.fn(async () => ({ ok: true as const }));
    const mutation = await prepareInferenceSetProviderBinding({
      gatewayName: "nemoclaw",
      providerName: "compatible-endpoint",
      binding: binding(),
      providerAdapter: providerAdapter({
        getProvider,
        importProviderProfile,
        updateProvider,
      }),
    });

    await expect(mutation.commit()).rejects.toThrow("changed after it was inspected");
    expect(importProviderProfile).not.toHaveBeenCalled();
    expect(updateProvider).not.toHaveBeenCalled();
  });

  it("refuses a revision that changes while ensuring the provider profile (#9806)", async () => {
    const getProvider = vi
      .fn<OpenShellProviderAdapter["getProvider"]>()
      .mockResolvedValueOnce({ ok: true, value: metadata() })
      .mockResolvedValueOnce({ ok: true, value: metadata() })
      .mockResolvedValueOnce({
        ok: true,
        value: metadata({ revision: { id: PROVIDER_ID, resourceVersion: 5 } }),
      });
    const importProviderProfile = vi.fn(async () => ({ ok: true as const }));
    const updateProvider = vi.fn(async () => ({ ok: true as const }));
    const mutation = await prepareInferenceSetProviderBinding({
      gatewayName: "nemoclaw",
      providerName: "compatible-endpoint",
      binding: binding(),
      providerAdapter: providerAdapter({
        getProvider,
        importProviderProfile,
        updateProvider,
      }),
    });

    await expect(mutation.commit()).rejects.toThrow("changed after it was inspected");
    expect(importProviderProfile).toHaveBeenCalledOnce();
    expect(updateProvider).not.toHaveBeenCalled();
  });

  it.each([
    ["unchanged version", PROVIDER_ID, 4],
    ["replaced identity", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", 5],
  ])("rejects a stale provider revision after update: %s (#9806)", async (_case, id, version) => {
    const getProvider = vi
      .fn<OpenShellProviderAdapter["getProvider"]>()
      .mockResolvedValueOnce({ ok: true, value: metadata() })
      .mockResolvedValueOnce({ ok: true, value: metadata() })
      .mockResolvedValueOnce({ ok: true, value: metadata() })
      .mockResolvedValueOnce({
        ok: true,
        value: metadata({ revision: { id, resourceVersion: version } }),
      });
    const adapter = providerAdapter({ getProvider });
    const mutation = await prepareInferenceSetProviderBinding({
      gatewayName: "nemoclaw",
      providerName: "compatible-endpoint",
      binding: binding(),
      providerAdapter: adapter,
    });

    await expect(mutation.commit()).rejects.toThrow("may be partial");
  });

  it("reports partial provider state without reinspecting after an uncertain update failure (#9806)", async () => {
    const getProvider = vi
      .fn<OpenShellProviderAdapter["getProvider"]>()
      .mockResolvedValueOnce({ ok: true, value: metadata() })
      .mockResolvedValueOnce({ ok: true, value: metadata() })
      .mockResolvedValueOnce({ ok: true, value: metadata() });
    const updateProvider = vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: "command" as const,
        reason: "uncertain" as const,
        message: "redacted failure",
      },
    }));
    const mutation = await prepareInferenceSetProviderBinding({
      gatewayName: "nemoclaw",
      providerName: "compatible-endpoint",
      binding: binding(),
      providerAdapter: providerAdapter({ getProvider, updateProvider }),
    });

    await expect(mutation.commit()).rejects.toThrow(
      "OpenShell could not confirm the update operation for provider 'compatible-endpoint'. Provider state may be partial. redacted failure",
    );
    expect(getProvider).toHaveBeenCalledTimes(3);
  });

  it("reports a definite update failure without claiming partial provider state (#9806)", async () => {
    const getProvider = vi
      .fn<OpenShellProviderAdapter["getProvider"]>()
      .mockResolvedValueOnce({ ok: true, value: metadata() })
      .mockResolvedValueOnce({ ok: true, value: metadata() })
      .mockResolvedValueOnce({ ok: true, value: metadata() })
      .mockResolvedValueOnce({ ok: true, value: metadata() });
    const updateProvider = vi.fn(async () => ({
      ok: false as const,
      error: { kind: "validation" as const, message: "safe validation failure" },
    }));
    const mutation = await prepareInferenceSetProviderBinding({
      gatewayName: "nemoclaw",
      providerName: "compatible-endpoint",
      binding: binding(),
      providerAdapter: providerAdapter({ getProvider, updateProvider }),
    });

    const commit = mutation.commit();
    await expect(commit).rejects.toThrow(
      "OpenShell could not update provider 'compatible-endpoint': safe validation failure",
    );
    await expect(commit).rejects.not.toThrow("partial");
    expect(getProvider).toHaveBeenCalledTimes(3);
  });

  it("deletes and verifies a newly created provider during rollback (#9806)", async () => {
    const getProvider = vi
      .fn<OpenShellProviderAdapter["getProvider"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "command", reason: "not_found", message: "provider not found" },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: metadata({ revision: { id: PROVIDER_ID, resourceVersion: 1 } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: metadata({ revision: { id: PROVIDER_ID, resourceVersion: 1 } }),
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "command", reason: "not_found", message: "provider not found" },
      });
    const deleteProvider = vi.fn(async () => ({ ok: true as const }));
    const mutation = await prepareInferenceSetProviderBinding({
      gatewayName: "nemoclaw",
      providerName: "compatible-endpoint",
      binding: binding(),
      providerAdapter: providerAdapter({ getProvider, deleteProvider }),
    });
    await mutation.rollback();

    expect(deleteProvider).toHaveBeenCalledExactlyOnceWith({
      target: TARGET,
      providerName: "compatible-endpoint",
    });
    expect(getProvider).toHaveBeenCalledTimes(4);
  });

  it("reports a rollback failure when the created provider remains registered (#9806)", async () => {
    const getProvider = vi
      .fn<OpenShellProviderAdapter["getProvider"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "command", reason: "not_found", message: "provider not found" },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: metadata({ revision: { id: PROVIDER_ID, resourceVersion: 1 } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: metadata({ revision: { id: PROVIDER_ID, resourceVersion: 1 } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: metadata({ revision: { id: PROVIDER_ID, resourceVersion: 1 } }),
      });
    const deleteProvider = vi.fn(async () => ({
      ok: false as const,
      error: { kind: "command" as const, reason: "failed" as const, message: "safe failure" },
    }));
    const mutation = await prepareInferenceSetProviderBinding({
      gatewayName: "nemoclaw",
      providerName: "compatible-endpoint",
      binding: binding(),
      providerAdapter: providerAdapter({ getProvider, deleteProvider }),
    });

    await expect(mutation.rollback()).rejects.toThrow(
      "OpenShell could not remove newly created provider 'compatible-endpoint' during rollback. The provider remains registered. safe failure",
    );
  });

  it("accepts rollback when inspection confirms the created provider is absent (#9806)", async () => {
    const getProvider = vi
      .fn<OpenShellProviderAdapter["getProvider"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "command", reason: "not_found", message: "provider not found" },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: metadata({ revision: { id: PROVIDER_ID, resourceVersion: 1 } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: metadata({ revision: { id: PROVIDER_ID, resourceVersion: 1 } }),
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "command", reason: "not_found", message: "provider not found" },
      });
    const deleteProvider = vi.fn(async () => ({
      ok: false as const,
      error: { kind: "command" as const, reason: "uncertain" as const, message: "safe failure" },
    }));
    const mutation = await prepareInferenceSetProviderBinding({
      gatewayName: "nemoclaw",
      providerName: "compatible-endpoint",
      binding: binding(),
      providerAdapter: providerAdapter({ getProvider, deleteProvider }),
    });

    await expect(mutation.rollback()).resolves.toBeUndefined();
  });

  it("preserves a typed inspection failure before provider rollback (#9806)", async () => {
    const getProvider = vi
      .fn<OpenShellProviderAdapter["getProvider"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "command", reason: "not_found", message: "provider not found" },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: metadata({ revision: { id: PROVIDER_ID, resourceVersion: 1 } }),
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "authentication", message: "safe authentication failure" },
      });
    const deleteProvider = vi.fn(async () => ({ ok: true as const }));
    const mutation = await prepareInferenceSetProviderBinding({
      gatewayName: "nemoclaw",
      providerName: "compatible-endpoint",
      binding: binding(),
      providerAdapter: providerAdapter({ getProvider, deleteProvider }),
    });

    await expect(mutation.rollback()).rejects.toThrow(
      "Could not inspect newly created provider 'compatible-endpoint': safe authentication failure. No provider deletion was attempted.",
    );
    expect(deleteProvider).not.toHaveBeenCalled();
  });

  it("preserves deletion and follow-up inspection failures during rollback (#9806)", async () => {
    const getProvider = vi
      .fn<OpenShellProviderAdapter["getProvider"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "command", reason: "not_found", message: "provider not found" },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: metadata({ revision: { id: PROVIDER_ID, resourceVersion: 1 } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: metadata({ revision: { id: PROVIDER_ID, resourceVersion: 1 } }),
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "timeout", message: "safe inspection timeout" },
      });
    const deleteProvider = vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: "command" as const,
        reason: "failed" as const,
        message: "safe delete failure",
      },
    }));
    const mutation = await prepareInferenceSetProviderBinding({
      gatewayName: "nemoclaw",
      providerName: "compatible-endpoint",
      binding: binding(),
      providerAdapter: providerAdapter({ getProvider, deleteProvider }),
    });

    await expect(mutation.rollback()).rejects.toThrow(
      "safe delete failure. A follow-up inspection failed: safe inspection timeout.",
    );
  });

  it("refuses to delete a stale provider revision during rollback (#9806)", async () => {
    const getProvider = vi
      .fn<OpenShellProviderAdapter["getProvider"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "command", reason: "not_found", message: "provider not found" },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: metadata({ revision: { id: PROVIDER_ID, resourceVersion: 1 } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        value: metadata({ revision: { id: PROVIDER_ID, resourceVersion: 2 } }),
      });
    const deleteProvider = vi.fn(async () => ({ ok: true as const }));
    const mutation = await prepareInferenceSetProviderBinding({
      gatewayName: "nemoclaw",
      providerName: "compatible-endpoint",
      binding: binding(),
      providerAdapter: providerAdapter({ getProvider, deleteProvider }),
    });

    await expect(mutation.rollback()).rejects.toThrow("no provider deletion was attempted");
    expect(deleteProvider).not.toHaveBeenCalled();
  });

  it("rejects provider ownership when provider metadata has no revision (#9806)", async () => {
    const getProvider = vi.fn(async () => ({
      ok: true as const,
      value: metadata({ revision: null }),
    }));

    await expect(
      assertInferenceSetProviderOwnership({
        gatewayName: "nemoclaw",
        providerName: "compatible-endpoint",
        providerType: "openai",
        credentialEnv: "COMPATIBLE_API_KEY",
        providerAdapter: providerAdapter({ getProvider }),
      }),
    ).rejects.toThrow(
      "Update OpenShell with `scripts/install-openshell.sh`, then rerun this command.",
    );
    expect(getProvider).toHaveBeenCalledExactlyOnceWith({
      target: TARGET,
      providerName: "compatible-endpoint",
    });
  });
});
