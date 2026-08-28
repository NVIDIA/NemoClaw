// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createCliOpenShellProviderAdapter, type RunProviderCommand } from "./provider-adapter-cli";
import { namedOpenShellGateway, selectedOpenShellGateway } from "./sandbox-observer";

function captured(status: number | null, stdout = "", stderr = "", error?: Error) {
  return { status, stdout, stderr, ...(error ? { error } : {}) };
}

describe("CLI OpenShell provider adapter", () => {
  it("targets a named gateway and returns provider names (#9806)", async () => {
    const run = vi.fn(() => captured(0, "zeta\nalpha\n"));
    const adapter = createCliOpenShellProviderAdapter({ run });

    await expect(
      adapter.listProviders({
        target: namedOpenShellGateway("nemoclaw-18080"),
        timeoutMs: 4_321,
      }),
    ).resolves.toEqual({ ok: true, value: { names: ["zeta", "alpha"] } });
    expect(run).toHaveBeenCalledWith(["provider", "list", "-g", "nemoclaw-18080", "--names"], {
      ignoreError: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 4_321,
    });
  });

  it("passes credential values only through the child environment (#9806)", async () => {
    const run = vi.fn<RunProviderCommand>(() => captured(0));
    const adapter = createCliOpenShellProviderAdapter({ run });
    const credentialValue = "host-only-value";

    await expect(
      adapter.createProvider({
        target: selectedOpenShellGateway(),
        name: "search-prod",
        type: "tavily",
        credentials: [{ name: "TAVILY_API_KEY", value: credentialValue }],
        config: [{ key: "region", value: "us-west" }],
        fromExisting: false,
      }),
    ).resolves.toEqual({ ok: true, value: { state: "created" } });

    expect(run).toHaveBeenCalledWith(
      [
        "provider",
        "create",
        "--name",
        "search-prod",
        "--type",
        "tavily",
        "--credential",
        "TAVILY_API_KEY",
        "--config",
        "region=us-west",
      ],
      {
        env: { TAVILY_API_KEY: credentialValue },
        ignoreError: true,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      },
    );
    expect(run.mock.calls[0]?.[0]).not.toContain(credentialValue);
  });

  it.each([
    [{ credentials: [], fromExisting: false }],
    [{ credentials: [{ name: "TAVILY_API_KEY", value: "" }], fromExisting: false }],
    [
      {
        credentials: [{ name: "TAVILY_API_KEY", value: "credential-value" }],
        fromExisting: true,
      },
    ],
  ])(
    "rejects missing or conflicting credential material before provider creation (#9806)",
    async (input) => {
      const run = vi.fn();
      const adapter = createCliOpenShellProviderAdapter({ run });

      await expect(
        adapter.createProvider({
          target: selectedOpenShellGateway(),
          name: "search-prod",
          type: "tavily",
          credentials: input.credentials,
          config: [],
          fromExisting: input.fromExisting,
        }),
      ).resolves.toEqual({
        ok: false,
        error: {
          kind: "validation",
          message: "Provider credential input is missing or conflicts with imported credentials.",
        },
      });
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("removes exact credential values from typed failures (#9806)", async () => {
    const credentialValue = "unstructured-host-value";
    const adapter = createCliOpenShellProviderAdapter({
      run: () => captured(1, "", `provider rejected ${credentialValue}`),
    });

    const result = await adapter.createProvider({
      target: selectedOpenShellGateway(),
      name: "search-prod",
      type: "tavily",
      credentials: [{ name: "TAVILY_API_KEY", value: credentialValue }],
      config: [],
      fromExisting: false,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "command",
        reason: "failed",
        message: "provider rejected <REDACTED>",
      },
    });
    expect(JSON.stringify(result)).not.toContain(credentialValue);
  });

  it("does not expose an imported credential value in a provider failure (#9806)", async () => {
    const storedCredentialValue = "arbitrary-stored-value";
    const adapter = createCliOpenShellProviderAdapter({
      run: () => captured(1, "", `provider rejected ${storedCredentialValue}`),
    });

    const result = await adapter.createProvider({
      target: selectedOpenShellGateway(),
      name: "search-prod",
      type: "tavily",
      credentials: [],
      config: [],
      fromExisting: true,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "command",
        reason: "failed",
        message: "OpenShell could not create the provider from existing credentials.",
      },
    });
    expect(JSON.stringify(result)).not.toContain(storedCredentialValue);
  });

  it("imports an existing profile and returns sorted credential keys (#9806)", async () => {
    const run = vi
      .fn()
      .mockReturnValueOnce(captured(1, "", "provider profile already exists"))
      .mockReturnValueOnce(
        captured(
          0,
          JSON.stringify({
            credentials: [
              { env_vars: ["ZETA_TOKEN", "ALPHA_TOKEN"] },
              { env_vars: ["ALPHA_TOKEN"] },
            ],
          }),
        ),
      );
    const adapter = createCliOpenShellProviderAdapter({ run });

    await expect(
      adapter.importProviderProfile({
        target: selectedOpenShellGateway(),
        profilePath: "/repo/profile.yaml",
      }),
    ).resolves.toEqual({ ok: true, value: { state: "already_present" } });
    await expect(
      adapter.inspectProviderProfile({
        target: selectedOpenShellGateway(),
        profileType: "custom",
      }),
    ).resolves.toEqual({
      ok: true,
      value: { credentialKeys: ["ALPHA_TOKEN", "ZETA_TOKEN"] },
    });
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ["provider", "profile", "import", "--file", "/repo/profile.yaml"],
      ["provider", "profile", "export", "custom", "--output", "json"],
    ]);
  });

  it("reconciles an endpointless profile inside the CLI adapter (#9806)", async () => {
    const run = vi
      .fn()
      .mockReturnValueOnce(captured(1, "", "provider profile not found"))
      .mockReturnValueOnce(captured(0));
    const adapter = createCliOpenShellProviderAdapter({ run });

    await expect(
      adapter.ensureEndpointlessProviderProfile({
        target: selectedOpenShellGateway(),
        profileType: "openai",
        profilePath: "/repo/provider-profiles/openai.yaml",
        inferenceCapable: true,
      }),
    ).resolves.toEqual({ ok: true, value: { state: "ready" } });
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ["provider", "profile", "export", "openai", "--output", "json"],
      ["provider", "profile", "import", "--file", "/repo/provider-profiles/openai.yaml"],
    ]);
  });

  it("returns a schema failure for an invalid provider profile (#9806)", async () => {
    const adapter = createCliOpenShellProviderAdapter({
      run: () => captured(0, "not-json"),
    });

    await expect(
      adapter.inspectProviderProfile({
        target: selectedOpenShellGateway(),
        profileType: "custom",
      }),
    ).resolves.toEqual({
      ok: false,
      error: { kind: "schema", message: "OpenShell returned an invalid provider profile." },
    });
  });

  it("returns typed attachment names and exact detach arguments (#9806)", async () => {
    const run = vi
      .fn()
      .mockReturnValueOnce(captured(1, "", "provider is attached to sandbox(es): alpha, beta"))
      .mockReturnValueOnce(captured(0));
    const adapter = createCliOpenShellProviderAdapter({ run });

    await expect(
      adapter.deleteProvider({
        target: selectedOpenShellGateway(),
        providerName: "search-prod",
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: "command",
        reason: "attached",
        message: "provider is attached to sandbox(es): alpha, beta",
        attachedSandboxes: ["alpha", "beta"],
      },
    });
    await expect(
      adapter.detachProvider({
        target: selectedOpenShellGateway(),
        providerName: "search-prod",
        sandboxName: "alpha",
      }),
    ).resolves.toEqual({ ok: true, value: { state: "detached" } });
    expect(run.mock.calls[1]?.[0]).toEqual([
      "sandbox",
      "provider",
      "detach",
      "alpha",
      "search-prod",
    ]);
  });

  it("stops attachment parsing before trailing diagnostic prose (#9806)", async () => {
    const adapter = createCliOpenShellProviderAdapter({
      run: () =>
        captured(1, "", "provider is attached to sandbox(es): alpha, beta. Detach them first."),
    });

    await expect(
      adapter.deleteProvider({
        target: selectedOpenShellGateway(),
        providerName: "search-prod",
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        kind: "command",
        reason: "attached",
        attachedSandboxes: ["alpha", "beta"],
      },
    });
  });

  it("places a named gateway flag before detach arguments (#9806)", async () => {
    const run = vi.fn(() => captured(0));
    const adapter = createCliOpenShellProviderAdapter({ run });

    await expect(
      adapter.detachProvider({
        target: namedOpenShellGateway("nemoclaw-18080"),
        providerName: "search-prod",
        sandboxName: "alpha",
      }),
    ).resolves.toEqual({ ok: true, value: { state: "detached" } });
    expect(run).toHaveBeenCalledWith(
      ["sandbox", "provider", "detach", "-g", "nemoclaw-18080", "alpha", "search-prod"],
      expect.objectContaining({ ignoreError: true, timeout: 30_000 }),
    );
  });

  it.each(["NotAttached", "provider search-prod NotFound", "provider search-prod not found"])(
    "treats a stale detach result as already absent: %s (#9806)",
    async (diagnostic) => {
      const adapter = createCliOpenShellProviderAdapter({
        run: () => captured(1, "", diagnostic),
      });

      await expect(
        adapter.detachProvider({
          target: selectedOpenShellGateway(),
          providerName: "search-prod",
          sandboxName: "alpha",
        }),
      ).resolves.toEqual({ ok: true, value: { state: "absent" } });
    },
  );

  it.each([
    "provider is attached to sandbox(es): alpha, invalid/name",
    "provider is attached to sandbox(es): --gateway, invalid/name",
    "provider is attached to sandbox(es):",
  ])("does not return unvalidated attachment targets from %s (#9806)", async (diagnostic) => {
    const adapter = createCliOpenShellProviderAdapter({
      run: () => captured(1, "", diagnostic),
    });

    const result = await adapter.deleteProvider({
      target: selectedOpenShellGateway(),
      providerName: "search-prod",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { kind: "command", reason: "failed" },
    });
    expect(JSON.stringify(result)).not.toContain("attachedSandboxes");
  });

  it.each([
    [
      "authentication",
      captured(1, "", "authentication failed: credential-value"),
      "OpenShell could not authenticate the provider operation.",
      undefined,
    ],
    [
      "transport",
      captured(1, "", "handshake verification failed"),
      "The selected OpenShell gateway identity does not match the recorded identity.",
      "identity_mismatch",
    ],
    [
      "transport",
      captured(1, "", "client error (Connect): connection refused"),
      "OpenShell could not reach the selected gateway.",
      "unreachable",
    ],
    [
      "timeout",
      captured(
        null,
        "",
        "credential-value",
        Object.assign(new Error("provider create credential-value timed out"), {
          code: "ETIMEDOUT",
        }),
      ),
      "The OpenShell provider operation timed out.",
      undefined,
    ],
    [
      "transport",
      captured(
        null,
        "",
        "credential-value",
        Object.assign(new Error("spawn openshell credential-value"), { code: "ENOENT" }),
      ),
      "OpenShell could not start the provider operation.",
      "process_start",
    ],
  ])(
    "maps %s failures without returning CLI diagnostics (#9806)",
    async (kind, result, message, reason) => {
      const adapter = createCliOpenShellProviderAdapter({ run: () => result });

      const mapped = await adapter.listProviders({ target: selectedOpenShellGateway() });

      expect(mapped).toEqual({
        ok: false,
        error: { kind, ...(reason ? { reason } : {}), message },
      });
      expect(JSON.stringify(mapped)).not.toContain("credential-value");
    },
  );
});
