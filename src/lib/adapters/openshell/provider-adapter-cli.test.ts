// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createCliOpenShellProviderAdapter, type RunProviderCommand } from "./provider-adapter-cli";
import { namedOpenShellGateway, selectedOpenShellGateway } from "./sandbox-observer";

function captured(status: number | null, stdout = "", stderr = "", error?: Error) {
  return { status, stdout, stderr, ...(error ? { error } : {}) };
}

const TAVILY_PROFILE = {
  id: "tavily",
  credentials: [
    {
      name: "api_key",
      env_vars: ["TAVILY_API_KEY"],
      required: true,
      auth_style: "bearer",
      header_name: "authorization",
      query_param: "",
    },
  ],
  endpoints: [
    {
      host: "api.tavily.com",
      port: 443,
      protocol: "rest",
      enforcement: "enforce",
      request_body_credential_rewrite: true,
      rules: [
        { allow: { method: "POST", path: "/search" } },
        { allow: { method: "POST", path: "/extract" } },
      ],
    },
  ],
  binaries: [
    "/opt/venv/bin/python3*",
    "/usr/local/bin/node",
    "/usr/bin/node",
    "/usr/local/bin/curl",
    "/usr/bin/curl",
  ],
  inference_capable: false,
} as const;

const TAVILY_PROFILE_YAML = `
id: tavily
credentials:
  - name: api_key
    env_vars: [TAVILY_API_KEY]
    required: true
    auth_style: bearer
    header_name: authorization
    query_param: ''
endpoints:
  - host: api.tavily.com
    port: 443
    protocol: rest
    enforcement: enforce
    request_body_credential_rewrite: true
    rules:
      - allow: { method: POST, path: /search }
      - allow: { method: POST, path: /extract }
binaries:
  - /opt/venv/bin/python3*
  - /usr/local/bin/node
  - /usr/bin/node
  - /usr/local/bin/curl
  - /usr/bin/curl
inference_capable: false
`;

describe("CLI OpenShell provider adapter", () => {
  it("rejects an ambient endpoint before every named-gateway operation (#9806)", async () => {
    const run = vi.fn(() => captured(0));
    const adapter = createCliOpenShellProviderAdapter({
      run,
      environment: { OPENSHELL_GATEWAY_ENDPOINT: "https://untrusted.example.test" },
    });
    const target = namedOpenShellGateway("nemoclaw-18080");
    const credentialValue = "host-only-value";
    const operations = [
      adapter.listProviders({ target }),
      adapter.createProvider({
        target,
        name: "search-prod",
        type: "tavily",
        credentials: [{ name: "TAVILY_API_KEY", value: credentialValue }],
        config: [],
        fromExisting: false,
      }),
      adapter.getProvider({ target, providerName: "search-prod" }),
      adapter.updateProvider({
        target,
        providerName: "search-prod",
        credentials: [{ name: "TAVILY_API_KEY", value: credentialValue }],
        config: [],
      }),
      adapter.importProviderProfile({ target, profilePath: "/unused/profile.yaml" }),
      adapter.inspectProviderProfile({ target, profileType: "tavily" }),
      adapter.deleteProvider({ target, providerName: "search-prod" }),
      adapter.detachProvider({ target, providerName: "search-prod", sandboxName: "alpha" }),
    ];

    const results = await Promise.all(operations);

    const expectedFailure = {
      ok: false,
      error: {
        kind: "validation",
        message:
          "OPENSHELL_GATEWAY_ENDPOINT is set, so OpenShell may bypass the gateway recorded for this sandbox. Unset OPENSHELL_GATEWAY_ENDPOINT and retry.",
      },
    };
    expect(results).toEqual([
      expectedFailure,
      expectedFailure,
      expectedFailure,
      expectedFailure,
      expectedFailure,
      expectedFailure,
      expectedFailure,
      expectedFailure,
    ]);
    expect(JSON.stringify(results)).not.toContain(credentialValue);
    expect(run).not.toHaveBeenCalled();
  });

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

  it.each([
    ["OSC control", "alpha\n\u001b]52;c;YXR0YWNr\u0007"],
    ["invalid name", "alpha\nbad/name"],
  ])(
    "rejects unsafe provider inventory output before returning names: %s (#9806)",
    async (_case, output) => {
      const adapter = createCliOpenShellProviderAdapter({
        run: () => captured(0, output),
      });

      await expect(adapter.listProviders({ target: selectedOpenShellGateway() })).resolves.toEqual({
        ok: false,
        error: {
          kind: "schema",
          message: "OpenShell returned an invalid provider inventory.",
        },
      });
    },
  );

  it("returns typed provider metadata from a named gateway (#9806)", async () => {
    const run = vi.fn(() =>
      captured(
        0,
        [
          "Name: search-prod",
          "Type: tavily",
          "Credential keys: TAVILY_API_KEY",
          "Config keys: <none>",
        ].join("\n"),
      ),
    );
    const adapter = createCliOpenShellProviderAdapter({ run });

    await expect(
      adapter.getProvider({
        target: namedOpenShellGateway("nemoclaw-18080"),
        providerName: "search-prod",
        timeoutMs: 4_321,
      }),
    ).resolves.toEqual({
      ok: true,
      value: {
        name: "search-prod",
        type: "tavily",
        credentialKeys: ["TAVILY_API_KEY"],
        configKeys: [],
      },
    });
    expect(run).toHaveBeenCalledWith(["provider", "get", "-g", "nemoclaw-18080", "search-prod"], {
      ignoreError: true,
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      suppressOutput: true,
      timeout: 4_321,
    });
  });

  it.each([
    ["provider name", "Name: \u001b[31msearch-prod\u001b[0m", "Credential keys: TAVILY_API_KEY"],
    ["credential key", "Name: search-prod", "Credential keys: \u001b[31mTAVILY_API_KEY\u001b[0m"],
  ])(
    "rejects terminal controls in raw provider %s metadata (#9806)",
    async (_field, name, keys) => {
      const adapter = createCliOpenShellProviderAdapter({
        run: () => captured(0, [name, "Type: tavily", keys, "Config keys: <none>"].join("\n")),
      });

      await expect(
        adapter.getProvider({
          target: selectedOpenShellGateway(),
          providerName: "search-prod",
        }),
      ).resolves.toEqual({
        ok: false,
        error: { kind: "schema", message: "OpenShell returned invalid provider metadata." },
      });
    },
  );

  it("distinguishes exact absence from a safe lookup failure (#9806)", async () => {
    const run = vi
      .fn()
      .mockReturnValueOnce(captured(1, "", "Error: provider 'search-prod' not found"))
      .mockReturnValueOnce(
        captured(
          1,
          "",
          "Error: gateway 'nemoclaw' not found while checking provider 'search-prod'",
        ),
      );
    const adapter = createCliOpenShellProviderAdapter({ run });
    const request = {
      target: namedOpenShellGateway("nemoclaw"),
      providerName: "search-prod",
    } as const;

    await expect(adapter.getProvider(request)).resolves.toEqual({
      ok: false,
      error: {
        kind: "command",
        reason: "not_found",
        message: "OpenShell provider 'search-prod' was not found.",
      },
    });
    await expect(adapter.getProvider(request)).resolves.toEqual({
      ok: false,
      error: {
        kind: "command",
        reason: "failed",
        message: "Error: gateway 'nemoclaw' not found while checking provider 'search-prod'",
      },
    });
  });

  it("does not classify signaled lookup output as exact absence (#9806)", async () => {
    const adapter = createCliOpenShellProviderAdapter({
      run: () => ({
        ...captured(1, "", "Error: provider 'search-prod' not found"),
        signal: "SIGTERM",
      }),
    });

    await expect(
      adapter.getProvider({
        target: selectedOpenShellGateway(),
        providerName: "search-prod",
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: "command",
        reason: "failed",
        message: "Error: provider 'search-prod' not found",
      },
    });
  });

  it("keeps gateway identity mismatch distinct from operational lookup failure (#9806)", async () => {
    const adapter = createCliOpenShellProviderAdapter({
      run: () => captured(1, "", "handshake verification failed: gateway unavailable"),
    });

    await expect(
      adapter.getProvider({
        target: namedOpenShellGateway("nemoclaw"),
        providerName: "search-prod",
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: "transport",
        reason: "identity_mismatch",
        message: "The selected OpenShell gateway identity does not match the recorded identity.",
      },
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
    ).resolves.toEqual({ ok: true });

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

  it("updates a provider without placing credential values in argv (#9806)", async () => {
    const run = vi.fn<RunProviderCommand>(() => captured(0));
    const adapter = createCliOpenShellProviderAdapter({ run });

    await expect(
      adapter.updateProvider({
        target: namedOpenShellGateway("nemoclaw"),
        providerName: "search-prod",
        credentials: [{ name: "TAVILY_API_KEY", value: "host-only-value" }],
        config: [{ key: "region", value: "us-west" }],
      }),
    ).resolves.toEqual({ ok: true });
    expect(run).toHaveBeenCalledWith(
      [
        "provider",
        "update",
        "-g",
        "nemoclaw",
        "search-prod",
        "--credential",
        "TAVILY_API_KEY",
        "--config",
        "region=us-west",
      ],
      {
        env: { TAVILY_API_KEY: "host-only-value" },
        ignoreError: true,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      },
    );
    expect(run.mock.calls[0]?.[0]).not.toContain("host-only-value");
  });

  it("returns redacted provider update failure details (#9806)", async () => {
    const credentialValue = "host-only-value";
    const adapter = createCliOpenShellProviderAdapter({
      run: () => captured(1, "", `provider update rejected ${credentialValue}`),
    });

    await expect(
      adapter.updateProvider({
        target: selectedOpenShellGateway(),
        providerName: "search-prod",
        credentials: [{ name: "TAVILY_API_KEY", value: credentialValue }],
        config: [],
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: "command",
        reason: "failed",
        message: "provider update rejected <REDACTED>",
      },
    });
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

  it("removes URL userinfo from typed failures (#9806)", async () => {
    const username = "upstream-user";
    const password = "upstream-password";
    const adapter = createCliOpenShellProviderAdapter({
      run: () =>
        captured(1, "", `provider rejected https://${username}:${password}@example.test/path`),
    });

    const result = await adapter.createProvider({
      target: selectedOpenShellGateway(),
      name: "search-prod",
      type: "tavily",
      credentials: [{ name: "TAVILY_API_KEY", value: "unrelated-host-value" }],
      config: [],
      fromExisting: false,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        kind: "command",
        reason: "failed",
        message: "provider rejected https://example.test/path",
      },
    });
    expect(JSON.stringify(result)).not.toContain(username);
    expect(JSON.stringify(result)).not.toContain(password);
  });

  it("removes terminal control strings from typed failures (#9806)", async () => {
    const adapter = createCliOpenShellProviderAdapter({
      run: () =>
        captured(
          1,
          "",
          "provider rejected \u001b]52;c;osc-payload\u0007\u001bP+dcs-payload\u001b\\request",
        ),
    });

    const result = await adapter.listProviders({ target: selectedOpenShellGateway() });

    expect(result).toEqual({
      ok: false,
      error: { kind: "command", reason: "failed", message: "provider rejected request" },
    });
    expect(JSON.stringify(result)).not.toMatch(/[\u001B\u0090-\u009F]/u);
    expect(JSON.stringify(result)).not.toContain("payload");
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

  it("validates an existing provider profile without importing it (#9806)", () => {
    const run = vi
      .fn<RunProviderCommand>()
      .mockReturnValueOnce(captured(0, JSON.stringify(TAVILY_PROFILE)));
    const adapter = createCliOpenShellProviderAdapter({
      run,
      readProfileFile: () => TAVILY_PROFILE_YAML,
    });

    expect(
      adapter.importProviderProfile({
        target: selectedOpenShellGateway(),
        profilePath: "/repo/profile.yaml",
      }),
    ).toEqual({ ok: true });
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ["provider", "profile", "export", "tavily", "--output", "json"],
    ]);
    expect(run.mock.calls[0]?.[1]).toMatchObject({ suppressOutput: true, timeout: 30_000 });
  });

  it.each([
    ["plain", captured(1, "", "provider profile not found")],
    [
      "structured output",
      {
        status: 1,
        output: [
          null,
          Buffer.from(""),
          Buffer.from("Error: × status: 'NotFound', message: \"provider profile not found\"\n"),
        ],
      },
    ],
    [
      "wrapped structured output",
      captured(
        1,
        "",
        "Error: × code: 'Some requested entity was not found', message: \"provider profile\n  │ not found\"",
      ),
    ],
  ] as const)(
    "validates a newly imported provider profile after %s missing output (#9806)",
    (_case, missingResult) => {
      const run = vi
        .fn<RunProviderCommand>()
        .mockReturnValueOnce(missingResult)
        .mockReturnValueOnce(captured(0))
        .mockReturnValueOnce(captured(0, JSON.stringify(TAVILY_PROFILE)));
      const adapter = createCliOpenShellProviderAdapter({
        run,
        readProfileFile: () => TAVILY_PROFILE_YAML,
      });

      expect(
        adapter.importProviderProfile({
          target: selectedOpenShellGateway(),
          profilePath: "/repo/profile.yaml",
        }),
      ).toEqual({ ok: true });
      expect(run.mock.calls.map(([args]) => args)).toEqual([
        ["provider", "profile", "export", "tavily", "--output", "json"],
        ["provider", "profile", "import", "--file", "/repo/profile.yaml"],
        ["provider", "profile", "export", "tavily", "--output", "json"],
      ]);
      expect(run.mock.calls.map(([, options]) => options.timeout)).toEqual([
        30_000, 30_000, 30_000,
      ]);
    },
  );

  it.each([
    [
      "an unrelated entity is missing",
      {
        status: 1,
        output: [
          null,
          Buffer.from(""),
          Buffer.from("Error: × status: 'NotFound', message: \"gateway not found\"\n"),
        ],
      },
    ],
    ["the exit status is unknown", captured(null, "", "provider profile not found")],
  ] as const)("does not import when %s (#10155)", (_case, inspection) => {
    const run = vi.fn<RunProviderCommand>().mockReturnValueOnce(inspection);
    const adapter = createCliOpenShellProviderAdapter({
      run,
      readProfileFile: () => TAVILY_PROFILE_YAML,
    });

    expect(
      adapter.importProviderProfile({
        target: selectedOpenShellGateway(),
        profilePath: "/repo/profile.yaml",
      }),
    ).toMatchObject({ ok: false });
    expect(run).toHaveBeenCalledOnce();
  });

  it("accepts an exact profile created by a concurrent importer (#10155)", () => {
    const run = vi
      .fn<RunProviderCommand>()
      .mockReturnValueOnce(captured(1, "", "provider profile not found"))
      .mockReturnValueOnce(captured(1, "", "provider profile already exists"))
      .mockReturnValueOnce(captured(0, JSON.stringify(TAVILY_PROFILE)));
    const adapter = createCliOpenShellProviderAdapter({
      run,
      readProfileFile: () => TAVILY_PROFILE_YAML,
    });

    expect(
      adapter.importProviderProfile({
        target: selectedOpenShellGateway(),
        profilePath: "/repo/profile.yaml",
      }),
    ).toEqual({ ok: true });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it.each(["authentication failed", "connection refused", "profile lookup failed"])(
    "does not import when the profile export fails with %s (#9806)",
    (diagnostic) => {
      const run = vi.fn<RunProviderCommand>().mockReturnValueOnce(captured(1, "", diagnostic));
      const adapter = createCliOpenShellProviderAdapter({
        run,
        readProfileFile: () => TAVILY_PROFILE_YAML,
      });

      expect(
        adapter.importProviderProfile({
          target: selectedOpenShellGateway(),
          profilePath: "/repo/profile.yaml",
        }),
      ).toMatchObject({ ok: false });
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]?.[0]).toEqual([
        "provider",
        "profile",
        "export",
        "tavily",
        "--output",
        "json",
      ]);
      expect(run.mock.calls[0]?.[1]).toMatchObject({ timeout: 30_000 });
    },
  );

  it("scopes messaging profile import and validation to the named gateway (#9806)", () => {
    const run = vi
      .fn<RunProviderCommand>()
      .mockReturnValueOnce(captured(1, "", "provider profile not found"))
      .mockReturnValueOnce(captured(0))
      .mockReturnValueOnce(captured(0, JSON.stringify(TAVILY_PROFILE)));
    const adapter = createCliOpenShellProviderAdapter({
      run,
      readProfileFile: () => TAVILY_PROFILE_YAML,
    });

    expect(
      adapter.importProviderProfile({
        target: namedOpenShellGateway("nemoclaw"),
        profilePath: "/repo/profile.yaml",
      }),
    ).toEqual({ ok: true });
    expect(run.mock.calls.map(([args]) => args)).toEqual([
      ["provider", "profile", "-g", "nemoclaw", "export", "tavily", "--output", "json"],
      ["provider", "profile", "-g", "nemoclaw", "import", "--file", "/repo/profile.yaml"],
      ["provider", "profile", "-g", "nemoclaw", "export", "tavily", "--output", "json"],
    ]);
  });

  it.each([
    [
      "endpoint",
      {
        ...TAVILY_PROFILE,
        endpoints: [
          ...TAVILY_PROFILE.endpoints,
          { host: "attacker.example", port: 443, protocol: "rest", enforcement: "enforce" },
        ],
      },
    ],
    ["binary", { ...TAVILY_PROFILE, binaries: [...TAVILY_PROFILE.binaries, "/tmp/widened"] }],
    [
      "credential",
      {
        ...TAVILY_PROFILE,
        credentials: [
          ...TAVILY_PROFILE.credentials,
          {
            name: "extra",
            env_vars: ["EXTRA_TOKEN"],
            required: true,
            auth_style: "bearer",
            header_name: "authorization",
            query_param: "",
          },
        ],
      },
    ],
  ])("rejects an existing profile with a widened %s boundary (#9806)", (_field, profile) => {
    const run = vi
      .fn<RunProviderCommand>()
      .mockReturnValueOnce(captured(0, JSON.stringify(profile)));
    const adapter = createCliOpenShellProviderAdapter({
      run,
      readProfileFile: () => TAVILY_PROFILE_YAML,
    });

    expect(
      adapter.importProviderProfile({
        target: selectedOpenShellGateway(),
        profilePath: "/repo/profile.yaml",
      }),
    ).toEqual({
      ok: false,
      error: {
        kind: "command",
        reason: "profile_incompatible",
        message:
          "The OpenShell provider profile does not match the checked-in credential boundary.",
      },
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed exported profile after import (#9806)", () => {
    const run = vi
      .fn<RunProviderCommand>()
      .mockReturnValueOnce(captured(1, "", "provider profile not found"))
      .mockReturnValueOnce(captured(0))
      .mockReturnValueOnce(captured(0, "not-json"));
    const adapter = createCliOpenShellProviderAdapter({
      run,
      readProfileFile: () => TAVILY_PROFILE_YAML,
    });

    expect(
      adapter.importProviderProfile({
        target: selectedOpenShellGateway(),
        profilePath: "/repo/profile.yaml",
      }),
    ).toMatchObject({
      ok: false,
      error: { kind: "command", reason: "profile_incompatible" },
    });
  });

  it("rejects a missing exported profile after import (#9806)", () => {
    const run = vi
      .fn<RunProviderCommand>()
      .mockReturnValueOnce(captured(1, "", "provider profile not found"))
      .mockReturnValueOnce(captured(0))
      .mockReturnValueOnce(captured(1, "", "provider profile not found"));
    const adapter = createCliOpenShellProviderAdapter({
      run,
      readProfileFile: () => TAVILY_PROFILE_YAML,
    });

    expect(
      adapter.importProviderProfile({
        target: selectedOpenShellGateway(),
        profilePath: "/repo/profile.yaml",
      }),
    ).toMatchObject({
      ok: false,
      error: { kind: "command", reason: "not_found" },
    });
  });

  it("rejects an unreadable checked-in profile before invoking OpenShell (#9806)", () => {
    const run = vi.fn<RunProviderCommand>();
    const adapter = createCliOpenShellProviderAdapter({
      run,
      readProfileFile: () => {
        throw new Error("host path detail");
      },
    });

    expect(
      adapter.importProviderProfile({
        target: selectedOpenShellGateway(),
        profilePath: "/repo/profile.yaml",
      }),
    ).toEqual({
      ok: false,
      error: {
        kind: "validation",
        message: "The checked-in OpenShell provider profile is invalid or unreadable.",
      },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("returns sorted unique credential keys from a provider profile (#9806)", async () => {
    const run = vi.fn(() =>
      captured(
        0,
        JSON.stringify({
          id: "custom",
          credentials: [{ env_vars: ["ZETA_TOKEN", "ALPHA_TOKEN"] }, { env_vars: ["ALPHA_TOKEN"] }],
        }),
      ),
    );
    const adapter = createCliOpenShellProviderAdapter({ run });

    await expect(
      adapter.inspectProviderProfile({
        target: selectedOpenShellGateway(),
        profileType: "custom",
      }),
    ).resolves.toEqual({
      ok: true,
      value: { credentialKeys: ["ALPHA_TOKEN", "ZETA_TOKEN"] },
    });
    expect(run).toHaveBeenCalledWith(
      ["provider", "profile", "export", "custom", "--output", "json"],
      expect.any(Object),
    );
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

  it.each([
    ["missing", { credentials: [{ env_vars: ["CUSTOM_TOKEN"] }] }],
    ["mismatched", { id: "other", credentials: [{ env_vars: ["CUSTOM_TOKEN"] }] }],
  ])("rejects a provider profile with a %s identity (#9806)", async (_case, profile) => {
    const adapter = createCliOpenShellProviderAdapter({
      run: () => captured(0, JSON.stringify(profile)),
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
    ).resolves.toEqual({ ok: true });
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
    ).resolves.toEqual({ ok: true });
    expect(run).toHaveBeenCalledWith(
      ["sandbox", "provider", "detach", "-g", "nemoclaw-18080", "alpha", "search-prod"],
      expect.objectContaining({ ignoreError: true, timeout: 30_000 }),
    );
  });

  it.each(["NotAttached", "provider search-prod is not attached"])(
    "treats an idempotent detach result as already detached: %s (#9806)",
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
      ).resolves.toEqual({ ok: true });
    },
  );

  it.each(["provider search-prod NotFound", "provider search-prod not found"])(
    "does not report a missing provider as detached: %s (#9806)",
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
      ).resolves.toEqual({
        ok: false,
        error: { kind: "command", reason: "not_found", message: diagnostic },
      });
    },
  );

  it.each([
    "provider is attached to sandbox(es): alpha, invalid/name",
    "provider is attached to sandbox(es): --gateway, invalid/name",
    "provider is attached to sandbox(es): team.alpha",
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
    [
      "command",
      captured(null, "", "credential-value"),
      "OpenShell did not report whether the provider operation completed.",
      "uncertain",
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
