// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type {
  OpenShellProviderAdapter,
  OpenShellProviderMetadata,
} from "../adapters/openshell/provider-adapter";
import { captureSanitizedResolvedOpenshellAsync } from "../adapters/openshell/sanitized-capture";
import { SANDBOX_EXEC_STARTED_MARKER } from "../adapters/sandbox/sandbox-exec-output";
import { NATIVE_NVIDIA_SCOPED_HANDLE_READ_SCRIPT } from "../inference-credential";
import {
  assertInferenceSetProviderOwnership,
  prepareInferenceSetProviderBinding,
  readNativeNvidiaCredentialHandle,
} from "./inference-set-provider";
import type { HttpsPinProviderBinding } from "./inference-set-route-containment";

vi.mock("../adapters/openshell/sanitized-capture", async (importOriginal) => ({
  ...(await importOriginal()),
  captureSanitizedResolvedOpenshellAsync: vi.fn(),
}));

const PROVIDER_ID = "11111111-2222-4333-8444-555555555555";
const TARGET = { kind: "named", gatewayName: "nemoclaw" } as const;

function markerFromCommand(args: string[]): string {
  const marker = args
    .at(-1)
    ?.match(new RegExp(`${SANDBOX_EXEC_STARTED_MARKER}_[0-9a-f]{32}`, "u"))?.[0];
  expect(marker).toBeDefined();
  return marker ?? "";
}

describe("native NVIDIA credential handle boundary", () => {
  it("emits a fixed pending signal without printing a missing or raw credential", () => {
    const missing = spawnSync("sh", ["-c", NATIVE_NVIDIA_SCOPED_HANDLE_READ_SCRIPT], {
      encoding: "utf8",
      env: { NVIDIA_INFERENCE_API_KEY: "" },
    });
    expect(missing.status).toBe(75);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toBe("NEMOCLAW_NATIVE_PROVIDER_HANDLE_PENDING\n");

    const raw = spawnSync("sh", ["-c", NATIVE_NVIDIA_SCOPED_HANDLE_READ_SCRIPT], {
      encoding: "utf8",
      env: { NVIDIA_INFERENCE_API_KEY: "raw-test-secret" },
    });
    expect(raw.status).toBe(1);
    expect(raw.stdout).toBe("");
    expect(raw.stderr).toBe("");
  });

  it.each([
    "openshell:resolve:env:v7_NVIDIA_INFERENCE_API_KEY",
    `openshell:resolve:env:s${"a".repeat(64)}_NVIDIA_INFERENCE_API_KEY`,
  ])("reads only the scoped handle %s from a sanitized sandbox exec", async (handle) => {
    const capture = vi.mocked(captureSanitizedResolvedOpenshellAsync);
    capture.mockImplementationOnce(async (args) => {
      const stdout = `${markerFromCommand(args)}\n${handle}\n`;
      return { status: 0, output: stdout, stdout, stderr: "" };
    });

    await expect(readNativeNvidiaCredentialHandle("hermes-sandbox", "gateway-a")).resolves.toBe(
      handle,
    );
    expect(capture).toHaveBeenCalledExactlyOnceWith(
      [
        "sandbox",
        "exec",
        "--name",
        "hermes-sandbox",
        "-g",
        "gateway-a",
        "--",
        "sh",
        "-c",
        expect.stringContaining(NATIVE_NVIDIA_SCOPED_HANDLE_READ_SCRIPT),
      ],
      {
        ignoreError: true,
        includeStderr: true,
        includeStreams: true,
        outputLimitBytes: 512,
        timeout: 30_000,
      },
    );
    capture.mockClear();
  });

  it.each(["stdout", "stderr"])(
    "reads a framed scoped handle from the %s stream",
    async (stream) => {
      const handle = "openshell:resolve:env:v7_NVIDIA_INFERENCE_API_KEY";
      const capture = vi.mocked(captureSanitizedResolvedOpenshellAsync);
      capture.mockImplementationOnce(async (args) => {
        const framed = `stdout: ${markerFromCommand(args)}\nstdout: ${handle}\n`;
        return {
          status: 0,
          output: framed,
          stdout: stream === "stdout" ? framed : "OpenShell preamble\n",
          stderr: stream === "stderr" ? framed : "",
        };
      });

      await expect(readNativeNvidiaCredentialHandle("hermes-sandbox", "gateway-a")).resolves.toBe(
        handle,
      );
      capture.mockClear();
    },
  );

  it("waits for a newly attached provider handle only when OpenShell reports it pending", async () => {
    const capture = vi.mocked(captureSanitizedResolvedOpenshellAsync);
    const sleep = vi.fn(async () => undefined);
    const handle = "openshell:resolve:env:v7_NVIDIA_INFERENCE_API_KEY";
    capture.mockImplementationOnce(async (args) => ({
      status: 75,
      output: "",
      stdout: `${markerFromCommand(args)}\n`,
      stderr: "NEMOCLAW_NATIVE_PROVIDER_HANDLE_PENDING\n",
    }));
    capture.mockImplementationOnce(async (args) => {
      const stdout = `${markerFromCommand(args)}\n${handle}\n`;
      return { status: 0, output: stdout, stdout, stderr: "" };
    });

    await expect(
      readNativeNvidiaCredentialHandle("hermes-sandbox", "gateway-a", { sleep }),
    ).resolves.toBe(handle);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(2_000);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(markerFromCommand(capture.mock.calls[0]?.[0] ?? [])).not.toBe(
      markerFromCommand(capture.mock.calls[1]?.[0] ?? []),
    );
    capture.mockClear();
  });

  it("stops after ten explicitly pending read-only probes", async () => {
    const capture = vi.mocked(captureSanitizedResolvedOpenshellAsync);
    const sleep = vi.fn(async () => undefined);
    capture.mockImplementation(async (args) => ({
      status: 75,
      output: "",
      stdout: `${markerFromCommand(args)}\n`,
      stderr: "NEMOCLAW_NATIVE_PROVIDER_HANDLE_PENDING\n",
    }));

    await expect(
      readNativeNvidiaCredentialHandle("hermes-sandbox", "gateway-a", { sleep }),
    ).rejects.toThrow("OpenShell did not expose a provider-bound NVIDIA credential handle");
    expect(capture).toHaveBeenCalledTimes(10);
    expect(sleep).toHaveBeenCalledTimes(9);
    capture.mockReset();
  });

  it("does not retry a non-pending credential probe failure", async () => {
    const capture = vi.mocked(captureSanitizedResolvedOpenshellAsync);
    const sleep = vi.fn(async () => undefined);
    capture.mockImplementationOnce(async (args) => ({
      status: 75,
      output: "",
      stdout: `${markerFromCommand(args)}\n`,
      stderr: "unrelated execution failure",
    }));

    await expect(
      readNativeNvidiaCredentialHandle("hermes-sandbox", "gateway-a", { sleep }),
    ).rejects.toThrow("OpenShell did not expose a provider-bound NVIDIA credential handle");
    expect(capture).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    capture.mockClear();
  });

  it.each([
    [1, "openshell:resolve:env:v7_NVIDIA_INFERENCE_API_KEY", ""],
    [0, "sk-raw-secret", ""],
    [0, "openshell:resolve:env:NVIDIA_INFERENCE_API_KEY", ""],
    [0, "openshell:resolve:env:v7_OPENAI_API_KEY", ""],
    [0, "openshell:resolve:env:v7_NVIDIA_INFERENCE_API_KEY extra", ""],
    [0, "", "openshell:resolve:env:v7_NVIDIA_INFERENCE_API_KEY"],
  ])("rejects invalid capture status %s and stdout %s", async (status, stdout, stderr) => {
    const capture = vi.mocked(captureSanitizedResolvedOpenshellAsync);
    capture.mockImplementationOnce(async (args) => {
      const markedStdout = `${markerFromCommand(args)}\n${stdout}`;
      return { status, output: `${markedStdout}${stderr}`, stdout: markedStdout, stderr };
    });

    await expect(readNativeNvidiaCredentialHandle("hermes-sandbox", "gateway-a")).rejects.toThrow(
      "OpenShell did not expose a provider-bound NVIDIA credential handle",
    );
    capture.mockClear();
  });

  it("rejects duplicate marker boundaries even when one contains a valid handle", async () => {
    const capture = vi.mocked(captureSanitizedResolvedOpenshellAsync);
    capture.mockImplementationOnce(async (args) => {
      const marker = markerFromCommand(args);
      const stdout = `${marker}\nopenshell:resolve:env:v7_NVIDIA_INFERENCE_API_KEY\n`;
      return { status: 0, output: stdout, stdout, stderr: `stdout: ${marker}\n` };
    });

    await expect(readNativeNvidiaCredentialHandle("hermes-sandbox", "gateway-a")).rejects.toThrow(
      "OpenShell did not expose a provider-bound NVIDIA credential handle",
    );
    capture.mockClear();
  });
});

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
  const adapter: OpenShellProviderAdapter = {
    ensureProviderPolicyComposition: vi
      .fn<OpenShellProviderAdapter["ensureProviderPolicyComposition"]>()
      .mockResolvedValue({ ok: true, value: undefined }),
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
    detachProvider: vi.fn(async () => ({ ok: true, value: { changed: true } }) as const),
    attachProvider: vi.fn(async () => ({ ok: true }) as const),
    listProviderAttachments: vi.fn(async () => ({ ok: true, value: { names: [] } }) as const),
    configureProviderRefresh: vi.fn(async () => ({ ok: true }) as const),
    getProviderRefreshStatus: vi.fn(
      async () => ({ ok: true, value: { status: "refreshed" } }) as const,
    ),
  };
  return { ...adapter, ...overrides };
}

describe("inference set provider binding", () => {
  it("updates an owned provider when its revision remains unchanged (#9806)", async () => {
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
    ]);
    expect(importProviderProfile).not.toHaveBeenCalled();
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
    await mutation.assertCurrent();
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
    expect(getProvider.mock.calls).toEqual([
      [{ target: TARGET, providerName: "compatible-endpoint" }],
      [{ target: TARGET, providerName: "compatible-endpoint" }],
      [{ target: TARGET, providerName: "compatible-endpoint" }],
    ]);
  });

  it("refuses a changed created-provider revision before route selection (#9806)", async () => {
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
    const createProvider = vi.fn(async () => ({ ok: true as const }));
    const adapter = providerAdapter({ getProvider, createProvider });

    const mutation = await prepareInferenceSetProviderBinding({
      gatewayName: "nemoclaw",
      providerName: "compatible-endpoint",
      binding: binding(),
      providerAdapter: adapter,
    });

    await expect(mutation.assertCurrent()).rejects.toThrow(
      "Could not verify newly created provider 'compatible-endpoint' immediately before inference route mutation",
    );
    expect(createProvider).toHaveBeenCalledOnce();
    expect(getProvider.mock.calls).toEqual([
      [{ target: TARGET, providerName: "compatible-endpoint" }],
      [{ target: TARGET, providerName: "compatible-endpoint" }],
      [{ target: TARGET, providerName: "compatible-endpoint" }],
    ]);
  });

  it("preserves a replacement when post-create inspection did not capture the created revision (#9806)", async () => {
    const replacementId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const getProvider = vi
      .fn<OpenShellProviderAdapter["getProvider"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "command", reason: "not_found", message: "provider not found" },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "timeout", message: "safe post-create inspection timeout" },
      })
      .mockResolvedValueOnce({
        ok: true,
        value: metadata({ revision: { id: replacementId, resourceVersion: 2 } }),
      });
    const createProvider = vi.fn(async () => ({ ok: true as const }));
    const deleteProvider = vi.fn(async () => ({ ok: true as const }));

    const failure = await prepareInferenceSetProviderBinding({
      gatewayName: "nemoclaw",
      providerName: "compatible-endpoint",
      binding: binding(),
      providerAdapter: providerAdapter({ getProvider, createProvider, deleteProvider }),
    }).catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("Cleanup could not confirm removal");
    expect((failure as Error).message).toContain("no provider deletion was attempted");
    expect((failure as Error).message).toContain("Provider state may be partial");
    expect((failure as Error).message).toMatch(
      /rerun onboarding before using this provider route or retrying this switch/i,
    );
    expect(createProvider).toHaveBeenCalledOnce();
    expect(deleteProvider).not.toHaveBeenCalled();
    expect(getProvider).toHaveBeenCalledTimes(3);
  });

  it("reports an inspection failure during post-create reconciliation (#9806)", async () => {
    const getProvider = vi
      .fn<OpenShellProviderAdapter["getProvider"]>()
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "command", reason: "not_found", message: "provider not found" },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "timeout", message: "safe post-create inspection timeout" },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { kind: "authentication", message: "safe cleanup inspection failure" },
      });
    const deleteProvider = vi.fn(async () => ({ ok: true as const }));

    const failure = await prepareInferenceSetProviderBinding({
      gatewayName: "nemoclaw",
      providerName: "compatible-endpoint",
      binding: binding(),
      providerAdapter: providerAdapter({ getProvider, deleteProvider }),
    }).catch((error: Error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "Provider 'compatible-endpoint' did not converge to the expected type and binding-key shape after create.",
    );
    expect((failure as Error).message).toContain("Cleanup could not confirm removal");
    expect((failure as Error).message).toContain("safe cleanup inspection failure");
    expect((failure as Error).message).toContain("Provider state may be partial");
    expect((failure as Error).message).toMatch(
      /rerun onboarding before using this provider route or retrying this switch/i,
    );
    expect(deleteProvider).not.toHaveBeenCalled();
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
    expect(getProvider).toHaveBeenCalledTimes(2);
  });

  it("reports partial provider state without reinspecting after a failed update command (#9806)", async () => {
    const getProvider = vi
      .fn<OpenShellProviderAdapter["getProvider"]>()
      .mockResolvedValueOnce({ ok: true, value: metadata() })
      .mockResolvedValueOnce({ ok: true, value: metadata() })
      .mockResolvedValueOnce({ ok: true, value: metadata() });
    const updateProvider = vi.fn(async () => ({
      ok: false as const,
      error: {
        kind: "command" as const,
        reason: "failed" as const,
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
    expect(getProvider).toHaveBeenCalledTimes(2);
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
    expect(getProvider).toHaveBeenCalledTimes(2);
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
