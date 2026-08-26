// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

import {
  createRunnerFsStore,
  FAKE_HOME,
  FIXED_RUN_UUID,
  inMemoryFsMethods,
  resolvedEndpointFor,
} from "./runner-mock-fixtures.js";
import {
  failureResult,
  MATCHING_INFERENCE_PROVIDER_LISTING,
  MATCHING_INFERENCE_ROUTE_LISTING,
  MATCHING_RUNTIME_PROVIDER_LISTING,
  providersV2EnabledResult,
  resultWithBlueprintPolicyAuthority,
  successResult,
} from "./runner-test-fixtures.js";

const { store } = createRunnerFsStore();
const realpaths = new Map<string, string>();
const mockExeca = vi.fn();

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => FAKE_HOME };
});
vi.mock("node:crypto", () => ({ randomUUID: () => FIXED_RUN_UUID }));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  const memory = inMemoryFsMethods(store, { realpaths, spy: vi.fn });
  return {
    ...original,
    existsSync: memory.existsSync,
    mkdirSync: memory.mkdirSync,
    readFileSync: memory.readFileSync,
    renameSync: memory.renameSync,
    writeFileSync: memory.writeFileSync,
    readdirSync: memory.readdirSync,
    realpathSync: memory.realpathSync,
    statSync: memory.statSync,
  };
});
vi.mock("execa", () => ({ execa: (...args: unknown[]) => mockExeca(...args) }));
vi.mock("./ssrf.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ssrf.js")>();
  return {
    ...actual,
    validateEndpointUrl: vi.fn(async (url: string) => resolvedEndpointFor(url)),
  };
});

const { actionApply, actionPlan, actionRollback, actionStatus, loadBlueprint } =
  await import("./runner.js");

const matchingProvider = MATCHING_RUNTIME_PROVIDER_LISTING;
const matchingInferenceProvider = MATCHING_INFERENCE_PROVIDER_LISTING;
const matchingInferenceRoute = MATCHING_INFERENCE_ROUTE_LISTING;

const success = successResult();
const providersV2Enabled = providersV2EnabledResult();

function responseQueue(
  overrides: Array<[string, Array<{ exitCode?: number; stdout: string; stderr: string }>]>,
) {
  const responses = new Map([
    ["sandbox get test-sandbox", [failureResult("sandbox not found")]],
    ["provider get test-provider", [failureResult("provider not found")]],
    ["inference get", [{ exitCode: 0, stdout: matchingInferenceRoute, stderr: "" }]],
    ...overrides,
  ]);
  const fallbacks = new Map([
    [
      "sandbox get test-sandbox",
      { exitCode: 0, stdout: "Name: test-sandbox\nPhase: Ready", stderr: "" },
    ],
    ["settings get --global --json", providersV2Enabled],
  ]);
  mockExeca.mockImplementation(async (_command: string, args: string[]) => {
    const command = args.join(" ");
    const fallback = responses.get(command)?.shift() ?? fallbacks.get(command) ?? success;
    return fallback.exitCode === undefined
      ? fallback
      : resultWithBlueprintPolicyAuthority(args, {
          ...fallback,
          exitCode: fallback.exitCode ?? 1,
        });
  });
}

function nonAuthorityCommandLines(): string[] {
  const authorityCommands = new Set([
    "openshell status",
    "openshell policy list -g test-gateway --global --limit 1",
    "openshell policy get -g test-gateway --full --output json test-sandbox",
  ]);
  return mockExeca.mock.calls
    .map(([command, args]) => [command, ...(args ?? [])].join(" "))
    .filter((command) => !authorityCommands.has(command));
}

function blueprint(overrides: Record<string, unknown> = {}): Parameters<typeof actionApply>[1] {
  return {
    components: {
      inference: {
        profiles: {
          default: {
            provider_type: "openai",
            provider_name: "test-provider",
            endpoint: "https://api.example.com/v1",
            model: "test-model",
          },
        },
      },
      sandbox: { image: "openclaw", name: "test-sandbox", forward_ports: [18789] },
      ...overrides,
    },
  };
}

function oktaIdentity(profilePath = "provider-profiles/okta-runtime-v1.yaml") {
  return {
    profile_path: profilePath,
    provider_type: "okta-runtime-v1",
    provider_name: "acme-okta-runtime",
    credential_key: "OKTA_ACCESS_TOKEN",
    client_id_env: "OKTA_CLIENT_ID",
    refresh_token_env: "OKTA_REFRESH_TOKEN",
    client_secret_env: "OKTA_CLIENT_SECRET",
  };
}

describe("blueprint identity wrapper", () => {
  beforeEach(() => {
    store.clear();
    realpaths.clear();
    vi.clearAllMocks();
    mockExeca.mockImplementation(async (_command: string, args: string[]) =>
      resultWithBlueprintPolicyAuthority(
        args,
        args.join(" ") === "settings get --global --json" ? providersV2Enabled : success,
      ),
    );
    process.env.NEMOCLAW_BLUEPRINT_PATH = "/blueprint";
    store.set("/blueprint", { type: "dir" });
    store.set("/blueprint/provider-profiles/okta-runtime-v1.yaml", {
      type: "file",
      content: [
        "id: okta-runtime-v1",
        "display_name: Okta Runtime Credentials v1",
        "description: Gateway-managed Okta access-token refresh for an attached sandbox",
        "category: agent",
        "credentials:",
        "  - name: OKTA_ACCESS_TOKEN",
        "    description: Short-lived Okta API access token",
        "    env_vars:",
        "      - OKTA_ACCESS_TOKEN",
        "    required: true",
        "    auth_style: bearer",
        "    header_name: authorization",
        "    refresh:",
        "      strategy: oauth2_refresh_token",
        "      token_url: https://example.okta.com/oauth2/default/v1/token",
        "      refresh_before_seconds: 300",
        "      max_lifetime_seconds: 3600",
        "      material:",
        "        - name: client_id",
        "          required: true",
        "        - name: refresh_token",
        "          required: true",
        "          secret: true",
        "        - name: client_secret",
        "          required: false",
        "          secret: true",
        "endpoints:",
        "  - host: api.example.okta.com",
        "    port: 443",
        "    protocol: rest",
        "    enforcement: enforce",
        "    rules:",
        '      - allow: { method: GET, path: "/**" }',
        "binaries:",
        "  - /usr/local/bin/node",
        "  - /usr/bin/node",
        "  - /usr/local/bin/curl",
        "  - /usr/bin/curl",
        "inference_capable: false",
        "",
      ].join("\n"),
    });
  });

  afterEach(() => {
    delete process.env.OKTA_CLIENT_ID;
    delete process.env.OKTA_REFRESH_TOKEN;
    delete process.env.OKTA_CLIENT_SECRET;
    delete process.env.NEMOCLAW_BLUEPRINT_PATH;
    vi.restoreAllMocks();
  });

  it("accepts an opt-in provider-neutral Okta identity configuration", () => {
    const input = blueprint({ identity: oktaIdentity() });
    store.set("/blueprint/blueprint.yaml", { type: "file", content: YAML.stringify(input) });

    expect(loadBlueprint()).toEqual(input);
  });

  it("rejects an empty identity component", () => {
    store.set("/blueprint/blueprint.yaml", {
      type: "file",
      content: YAML.stringify(blueprint({ identity: {} })),
    });

    expect(() => loadBlueprint()).toThrow(/valid nested component shapes/);
  });

  it("rejects identity environment names that overlap", () => {
    const identity = oktaIdentity();
    store.set("/blueprint/blueprint.yaml", {
      type: "file",
      content: YAML.stringify(
        blueprint({
          identity: { ...identity, refresh_token_env: identity.client_secret_env },
        }),
      ),
    });

    expect(() => loadBlueprint()).toThrow(/valid nested component shapes/);
  });

  it("rejects profile paths that escape the blueprint directory", async () => {
    store.set("/outside.yaml", { type: "file", content: "name: outside" });
    responseQueue([]);
    await expect(
      actionApply("default", blueprint({ identity: oktaIdentity("../outside.yaml") })),
    ).rejects.toThrow(/profile_path must stay inside/i);
  });

  it("configures refresh from scoped environment material and attaches the runtime provider", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";

    responseQueue([
      [
        "provider get acme-okta-runtime",
        [
          failureResult("provider not found"),
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
        ],
      ],
    ]);

    await actionApply("default", blueprint({ identity: oktaIdentity() }));

    const importCall = mockExeca.mock.calls.find(
      (call) =>
        Array.isArray(call[1]) &&
        call[1].slice(0, 4).join(" ") === "provider profile import --file",
    );
    expect(importCall).toBeDefined();
    const [, importArguments, importOptions] = importCall!;
    expect(importArguments[4]).toMatch(/nemoclaw-runtime-identity-profile-.+\/profile\.yaml$/u);
    expect(importArguments[4]).not.toBe("/blueprint/provider-profiles/okta-runtime-v1.yaml");
    expect(importOptions).toEqual(
      expect.objectContaining({ reject: false, env: expect.any(Object) }),
    );
    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      [
        "provider",
        "create",
        "--name",
        "acme-okta-runtime",
        "--type",
        "okta-runtime-v1",
        "--runtime-credentials",
      ],
      expect.objectContaining({ reject: false, env: expect.any(Object) }),
    );
    const refreshCall = mockExeca.mock.calls.find(
      (call) => Array.isArray(call[1]) && call[1][0] === "provider" && call[1][2] === "configure",
    );
    expect(refreshCall).toBeDefined();
    const [, refreshArguments, refreshOptions] = refreshCall!;
    expect(refreshArguments).toContain("client_id=client-id");
    expect(refreshArguments).not.toContain("refresh-secret");
    expect(refreshArguments).not.toContain("client-secret");
    expect(refreshOptions.env.OKTA_REFRESH_TOKEN).toBe("refresh-secret");
    expect(refreshOptions.env.OKTA_CLIENT_SECRET).toBe("client-secret");
    expect(refreshOptions.extendEnv).toBe(false);
    const sandboxCreateCall = mockExeca.mock.calls.find(
      (call) => Array.isArray(call[1]) && call[1][0] === "sandbox" && call[1][1] === "create",
    );
    expect(sandboxCreateCall).toBeDefined();
    expect(sandboxCreateCall![2].env.OKTA_REFRESH_TOKEN).toBeUndefined();
    expect(sandboxCreateCall![2].env.OKTA_CLIENT_SECRET).toBeUndefined();
    expect(sandboxCreateCall![2].extendEnv).toBe(false);
    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "provider", "attach", "test-sandbox", "acme-okta-runtime"],
      expect.objectContaining({ reject: false, env: expect.any(Object) }),
    );
    const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(
      commands.indexOf("inference set --provider test-provider --model test-model"),
    ).toBeLessThan(commands.indexOf("sandbox provider attach test-sandbox acme-okta-runtime"));
    expect(
      commands.indexOf(
        "provider refresh configure acme-okta-runtime --credential-key OKTA_ACCESS_TOKEN --strategy oauth2-refresh-token --material client_id=client-id --secret-material-env refresh_token=OKTA_REFRESH_TOKEN --secret-material-env client_secret=OKTA_CLIENT_SECRET",
      ),
    ).toBeLessThan(commands.indexOf("sandbox provider attach test-sandbox acme-okta-runtime"));
    expect(commands.indexOf("sandbox provider attach test-sandbox acme-okta-runtime")).toBeLessThan(
      commands.indexOf(
        "provider refresh rotate acme-okta-runtime --credential-key OKTA_ACCESS_TOKEN",
      ),
    );
  });

  it("fails closed when an identity subprocess has no exit code", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      ["provider get acme-okta-runtime", [failureResult("not found")]],
      [
        "provider create --name acme-okta-runtime --type okta-runtime-v1 --runtime-credentials",
        [{ exitCode: undefined, stdout: "", stderr: "terminated by SIGTERM" }],
      ],
    ]);

    await expect(actionApply("default", blueprint({ identity: oktaIdentity() }))).rejects.toThrow(
      /terminated by SIGTERM/,
    );
    expect(
      mockExeca.mock.calls
        .map(([, args]) => (Array.isArray(args) ? args.join(" ") : ""))
        .join("\n"),
    ).not.toContain("refresh configure");
  });

  it("fails before identity mutation when the target sandbox cannot be inspected", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      ["sandbox get test-sandbox", [failureResult("gateway configuration not found")]],
    ]);

    await expect(actionApply("default", blueprint({ identity: oktaIdentity() }))).rejects.toThrow(
      /Failed to inspect sandbox 'test-sandbox'.*gateway configuration not found/,
    );

    const commandLines = nonAuthorityCommandLines();
    expect(commandLines).toEqual(["openshell sandbox get test-sandbox"]);
  });

  it("fails before identity mutation when the target sandbox is not Ready", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      [
        "sandbox get test-sandbox",
        [{ exitCode: 0, stdout: "Name: test-sandbox\nPhase: Provisioning", stderr: "" }],
      ],
    ]);

    await expect(actionApply("default", blueprint({ identity: oktaIdentity() }))).rejects.toThrow(
      /Sandbox 'test-sandbox' is not reusable.*Ready phase.*Provisioning/,
    );

    const commandLines = nonAuthorityCommandLines();
    expect(commandLines).toEqual(["openshell sandbox get test-sandbox"]);
  });

  it.each([
    [
      "cannot be inspected",
      failureResult("gateway route unavailable"),
      /Failed to inspect sandbox 'test-sandbox' after concurrent creation.*gateway route unavailable/,
    ],
    [
      "is not Ready",
      { exitCode: 0, stdout: "Name: test-sandbox\nPhase: Provisioning", stderr: "" },
      /Sandbox 'test-sandbox' is not reusable.*Ready phase.*Provisioning/,
    ],
  ])(
    "fails closed when a concurrently created sandbox %s",
    async (_label, racedSandbox, expectedError) => {
      process.env.OKTA_CLIENT_ID = "client-id";
      process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
      process.env.OKTA_CLIENT_SECRET = "client-secret";
      responseQueue([
        ["sandbox get test-sandbox", [failureResult("sandbox not found"), racedSandbox]],
        [
          "provider get acme-okta-runtime",
          [
            failureResult("provider not found"),
            ...Array.from({ length: 4 }, () => ({
              exitCode: 0,
              stdout: matchingProvider,
              stderr: "",
            })),
          ],
        ],
        [
          "sandbox create --from openclaw --name test-sandbox --forward 18789",
          [failureResult("sandbox already exists")],
        ],
      ]);

      await expect(actionApply("default", blueprint({ identity: oktaIdentity() }))).rejects.toThrow(
        expectedError,
      );

      const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
      expect(commands.filter((command) => command === "sandbox get test-sandbox")).toHaveLength(2);
      expect(commands).not.toContain("sandbox provider attach test-sandbox acme-okta-runtime");
      expect(commands).toContain("provider delete acme-okta-runtime");
    },
  );

  it("fails before identity mutation when a reused sandbox's inference provider cannot be inspected", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      [
        "sandbox get test-sandbox",
        [{ exitCode: 0, stdout: "Name: test-sandbox\nPhase: Ready", stderr: "" }],
      ],
      ["provider get test-provider", [failureResult("gateway configuration not found")]],
    ]);

    await expect(actionApply("default", blueprint({ identity: oktaIdentity() }))).rejects.toThrow(
      /Failed to inspect inference provider 'test-provider'.*gateway configuration not found/,
    );

    const commandLines = nonAuthorityCommandLines();
    expect(commandLines).toEqual([
      "openshell sandbox get test-sandbox",
      "openshell provider get test-provider",
    ]);
  });

  it("rejects a mismatched inference provider before identity mutation for a new sandbox", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      [
        "provider get test-provider",
        [
          {
            exitCode: 0,
            stdout: matchingInferenceProvider.replace("Type: openai", "Type: anthropic"),
            stderr: "",
          },
        ],
      ],
    ]);

    await expect(actionApply("default", blueprint({ identity: oktaIdentity() }))).rejects.toThrow(
      /Inference provider 'test-provider' does not match the requested non-secret binding/,
    );

    const commandLines = nonAuthorityCommandLines();
    expect(commandLines).toEqual([
      "openshell sandbox get test-sandbox",
      "openshell provider get test-provider",
    ]);
  });

  it("fails before identity mutation when a reused route cannot be inspected", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      [
        "sandbox get test-sandbox",
        [{ exitCode: 0, stdout: "Name: test-sandbox\nPhase: Ready", stderr: "" }],
      ],
      [
        "provider get test-provider",
        [{ exitCode: 0, stdout: matchingInferenceProvider, stderr: "" }],
      ],
      ["inference get", [failureResult("gateway route inspection unavailable")]],
    ]);

    await expect(actionApply("default", blueprint({ identity: oktaIdentity() }))).rejects.toThrow(
      /Failed to inspect the active inference route.*gateway route inspection unavailable/,
    );

    const commandLines = nonAuthorityCommandLines();
    expect(commandLines).toEqual([
      "openshell sandbox get test-sandbox",
      "openshell provider get test-provider",
      "openshell inference get",
    ]);
  });

  it("revalidates the sandbox immediately before attaching runtime identity", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      [
        "sandbox get test-sandbox",
        [
          { exitCode: 0, stdout: "Name: test-sandbox\nPhase: Ready", stderr: "" },
          { exitCode: 0, stdout: "Name: test-sandbox\nPhase: Provisioning", stderr: "" },
        ],
      ],
      [
        "provider get test-provider",
        [{ exitCode: 0, stdout: matchingInferenceProvider, stderr: "" }],
      ],
      [
        "provider get acme-okta-runtime",
        [
          failureResult("provider not found"),
          ...Array.from({ length: 4 }, () => ({
            exitCode: 0,
            stdout: matchingProvider,
            stderr: "",
          })),
        ],
      ],
    ]);

    await expect(actionApply("default", blueprint({ identity: oktaIdentity() }))).rejects.toThrow(
      /Sandbox 'test-sandbox' is not reusable.*Ready phase.*Provisioning/,
    );

    const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(commands.filter((command) => command === "sandbox get test-sandbox")).toHaveLength(2);
    expect(commands).not.toContain("sandbox provider attach test-sandbox acme-okta-runtime");
    expect(commands).toContain("provider delete acme-okta-runtime");
  });

  it.each([
    ["not configured", "Gateway inference:\n\n  Not configured\n"],
    [
      "OpenShell v0.0.99 ANSI not configured",
      [
        "\u001b[1mInference:\u001b[0m",
        "",
        "  Not configured",
        "",
        "\u001b[1mSystem inference:\u001b[0m",
        "",
        "  Not configured",
        "",
      ].join("\n"),
    ],
    [
      "configured for a different model",
      matchingInferenceRoute.replace("Model: test-model", "Model: other-model"),
    ],
  ])("sets the requested route when the reused route is %s", async (_label, routeOutput) => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      [
        "sandbox get test-sandbox",
        [{ exitCode: 0, stdout: "Name: test-sandbox\nPhase: Ready", stderr: "" }],
      ],
      [
        "provider get test-provider",
        [{ exitCode: 0, stdout: matchingInferenceProvider, stderr: "" }],
      ],
      ["inference get", [{ exitCode: 0, stdout: routeOutput, stderr: "" }]],
      [
        "provider get acme-okta-runtime",
        [
          failureResult("provider not found"),
          ...Array.from({ length: 4 }, () => ({
            exitCode: 0,
            stdout: matchingProvider,
            stderr: "",
          })),
        ],
      ],
    ]);

    await actionApply("default", blueprint({ identity: oktaIdentity() }));

    const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(commands).toContain("inference set --provider test-provider --model test-model");
    expect(
      commands.indexOf("inference set --provider test-provider --model test-model"),
    ).toBeLessThan(commands.indexOf("sandbox provider attach test-sandbox acme-okta-runtime"));
  });

  it("reuses the ANSI-formatted OpenShell v0.0.99 inference route", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    const routeOutput = [
      "\u001b[1mInference:\u001b[0m",
      "",
      "  Workspace: default",
      "  Provider: test-provider",
      "  Model: test-model",
      "  Version: 1",
      "  Timeout: 180s",
      "",
      "\u001b[1mSystem inference:\u001b[0m",
      "",
      "  Not configured",
      "",
    ].join("\n");
    responseQueue([
      [
        "sandbox get test-sandbox",
        [{ exitCode: 0, stdout: "Name: test-sandbox\nPhase: Ready", stderr: "" }],
      ],
      [
        "provider get test-provider",
        [{ exitCode: 0, stdout: matchingInferenceProvider, stderr: "" }],
      ],
      ["inference get", [{ exitCode: 0, stdout: routeOutput, stderr: "" }]],
      [
        "provider get acme-okta-runtime",
        [
          failureResult("provider not found"),
          ...Array.from({ length: 4 }, () => ({
            exitCode: 0,
            stdout: matchingProvider,
            stderr: "",
          })),
        ],
      ],
    ]);

    await actionApply("default", blueprint({ identity: oktaIdentity() }));

    const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(commands).not.toContain("inference set --provider test-provider --model test-model");
    expect(commands).toContain("sandbox provider attach test-sandbox acme-okta-runtime");
  });

  it("sets an exact reused route when the requested timeout differs", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      [
        "sandbox get test-sandbox",
        [{ exitCode: 0, stdout: "Name: test-sandbox\nPhase: Ready", stderr: "" }],
      ],
      [
        "provider get test-provider",
        [{ exitCode: 0, stdout: matchingInferenceProvider, stderr: "" }],
      ],
      [
        "provider get acme-okta-runtime",
        [
          failureResult("provider not found"),
          ...Array.from({ length: 4 }, () => ({
            exitCode: 0,
            stdout: matchingProvider,
            stderr: "",
          })),
        ],
      ],
    ]);

    const input = blueprint({ identity: oktaIdentity() });
    const inferenceProfile = input.components?.inference?.profiles?.default;
    expect(inferenceProfile).toBeDefined();
    inferenceProfile!.timeout_secs = 300;
    await actionApply("default", input);

    const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(commands).toContain(
      "inference set --provider test-provider --model test-model --timeout 300",
    );
  });

  it("revalidates a mismatched inference provider created after preflight", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      [
        "provider get test-provider",
        [
          failureResult("provider not found"),
          {
            exitCode: 0,
            stdout: matchingInferenceProvider.replace("Type: openai", "Type: anthropic"),
            stderr: "",
          },
        ],
      ],
      [
        "provider get acme-okta-runtime",
        [
          failureResult("provider not found"),
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
        ],
      ],
      [
        "provider create --name test-provider --type openai --config OPENAI_BASE_URL=https://api.example.com/v1",
        [failureResult("provider already exists")],
      ],
    ]);

    await expect(actionApply("default", blueprint({ identity: oktaIdentity() }))).rejects.toThrow(
      /Inference provider 'test-provider' does not match the requested non-secret binding/,
    );

    const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(commands).not.toContain("inference set --provider test-provider --model test-model");
    expect(commands).not.toContain("provider delete test-provider");
  });

  it("plans only the non-secret runtime identity binding", async () => {
    const plan = await actionPlan("default", blueprint({ identity: oktaIdentity() }));

    expect(plan.identity).toEqual({
      provider_type: "okta-runtime-v1",
      provider_name: "acme-okta-runtime",
      credential_key: "OKTA_ACCESS_TOKEN",
    });
    expect(JSON.stringify(plan)).not.toContain("OKTA_REFRESH_TOKEN");
    expect(JSON.stringify(plan)).not.toContain("OKTA_CLIENT_SECRET");
  });

  it("compensates a created identity provider and sandbox when apply later fails", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      [
        "provider get acme-okta-runtime",
        [
          failureResult("provider not found"),
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
        ],
      ],
      [
        "inference set --provider test-provider --model test-model",
        [failureResult("route failed")],
      ],
    ]);

    await expect(actionApply("default", blueprint({ identity: oktaIdentity() }))).rejects.toThrow(
      /route failed/,
    );

    expect(mockExeca).not.toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "provider", "detach", "test-sandbox", "acme-okta-runtime"],
      expect.anything(),
    );
    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      ["provider", "delete", "acme-okta-runtime"],
      expect.objectContaining({ reject: false }),
    );
    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "remove", "test-sandbox"],
      expect.objectContaining({ reject: false }),
    );
    const planEntry = [...store.entries()].find(([path]) => path.endsWith("/plan.json"))?.[1];
    expect(JSON.parse(planEntry!.content!).identity).toMatchObject({
      provider_created: false,
      attachment_created: false,
    });
    expect(JSON.parse(planEntry!.content!).inference_provider_created_by_apply).toBe(false);
  });

  it("compensates owned identity, sandbox, and inference providers after a policy failure", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      [
        "provider get acme-okta-runtime",
        [
          failureResult("provider not found"),
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
        ],
      ],
      ["policy get -g test-gateway --base test-sandbox", [failureResult("policy read rejected")]],
    ]);

    await expect(
      actionApply(
        "default",
        blueprint({
          identity: oktaIdentity(),
          policy: {
            additions: {
              protected_api: {
                name: "protected_api",
                endpoints: [{ host: "api.example.okta.com", port: 443, access: "full" }],
              },
            },
          },
        }),
      ),
    ).rejects.toThrow(/policy read rejected/);

    const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(commands).toContain("sandbox provider detach test-sandbox acme-okta-runtime");
    expect(commands).toContain("provider delete acme-okta-runtime");
    expect(commands).toContain("sandbox remove test-sandbox");
    expect(commands).toContain("provider delete test-provider");
    const planEntry = [...store.entries()].find(([path]) => path.endsWith("/plan.json"))?.[1];
    expect(JSON.parse(planEntry!.content!)).toMatchObject({
      sandbox_created_by_apply: false,
      inference_provider_created_by_apply: false,
      identity: { provider_created: false, attachment_created: false },
    });
  });

  it("rejects a matching pre-existing provider without changing its refresh state", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      ["provider get acme-okta-runtime", [{ exitCode: 0, stdout: matchingProvider, stderr: "" }]],
    ]);

    await expect(actionApply("default", blueprint({ identity: oktaIdentity() }))).rejects.toThrow(
      /cannot be safely reused.*prior refresh configuration cannot be restored/,
    );

    const commandLines = mockExeca.mock.calls.map(([command, args]) =>
      [command, ...(args ?? [])].join(" "),
    );
    expect(commandLines.join("\n")).not.toContain("provider refresh configure");
    expect(commandLines.join("\n")).not.toContain("provider refresh rotate");
    expect(commandLines.join("\n")).not.toContain("provider delete acme-okta-runtime");
  });

  it("compensates a sandbox even when an identity component is not configured", async () => {
    responseQueue([
      [
        "inference set --provider test-provider --model test-model",
        [failureResult("route failed")],
      ],
    ]);

    await expect(actionApply("default", blueprint())).rejects.toThrow(/route failed/);

    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "remove", "test-sandbox"],
      expect.objectContaining({ reject: false }),
    );
  });

  it("persists reused sandbox ownership and preserves it during later rollback", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      [
        "sandbox get test-sandbox",
        [{ exitCode: 0, stdout: "Name: test-sandbox\nPhase: Ready", stderr: "" }],
      ],
      [
        "provider get test-provider",
        [{ exitCode: 0, stdout: matchingInferenceProvider, stderr: "" }],
      ],
      [
        "provider get acme-okta-runtime",
        [
          failureResult("provider not found"),
          ...Array.from({ length: 4 }, () => ({
            exitCode: 0,
            stdout: matchingProvider,
            stderr: "",
          })),
        ],
      ],
    ]);

    await actionApply("default", blueprint({ identity: oktaIdentity() }));

    const applyCommands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(applyCommands).not.toContain(
      "sandbox create --from openclaw --name test-sandbox --forward 18789",
    );
    expect(applyCommands).toContain("provider get test-provider");
    expect(applyCommands).toContain("inference get");
    expect(applyCommands).not.toContain(
      "inference set --provider test-provider --model test-model",
    );
    expect(applyCommands).not.toContain(
      "provider create --name test-provider --type openai --config OPENAI_BASE_URL=https://api.example.com/v1",
    );
    const planEntry = [...store.entries()].find(([path]) => path.endsWith("/plan.json"))?.[1];
    expect(planEntry?.content).toBeDefined();
    const plan = JSON.parse(planEntry!.content!);
    expect(plan.sandbox_created_by_apply).toBe(false);
    expect(plan.inference_provider_created_by_apply).toBe(false);

    mockExeca.mockClear();
    responseQueue([
      [
        "provider get acme-okta-runtime",
        [
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
        ],
      ],
    ]);
    await actionRollback(plan.run_id);

    const rollbackCommands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(rollbackCommands).not.toContain("sandbox stop test-sandbox");
    expect(rollbackCommands).not.toContain("sandbox remove test-sandbox");
    expect(rollbackCommands).toContain("sandbox provider detach test-sandbox acme-okta-runtime");
    expect(rollbackCommands).toContain("provider delete acme-okta-runtime");
  });

  it("preserves a sandbox for a legacy plan without an ownership receipt", async () => {
    const stateDir = "/fakehome/.nemoclaw/state/runs/legacy-run";
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/plan.json`, {
      type: "file",
      content: JSON.stringify({ sandbox_name: "existing-sandbox" }),
    });

    await actionRollback("legacy-run");

    const rollbackCommands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(rollbackCommands).not.toContain("sandbox stop existing-sandbox");
    expect(rollbackCommands).not.toContain("sandbox remove existing-sandbox");
    expect(store.get(`${stateDir}/rolled_back`)?.content).toBeDefined();
  });

  it("creates an explicitly missing inference provider for a reused sandbox", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      [
        "sandbox get test-sandbox",
        [{ exitCode: 0, stdout: "Name: test-sandbox\nPhase: Ready", stderr: "" }],
      ],
      ["provider get test-provider", [failureResult("provider not found")]],
      [
        "provider get acme-okta-runtime",
        [
          failureResult("provider not found"),
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
        ],
      ],
    ]);

    await actionApply("default", blueprint({ identity: oktaIdentity() }));

    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      [
        "provider",
        "create",
        "--name",
        "test-provider",
        "--type",
        "openai",
        "--config",
        "OPENAI_BASE_URL=https://api.example.com/v1",
      ],
      expect.objectContaining({ reject: false }),
    );
    const planEntry = [...store.entries()].find(([path]) => path.endsWith("/plan.json"))?.[1];
    expect(JSON.parse(planEntry!.content!)).toMatchObject({
      sandbox_created_by_apply: false,
      inference_provider_created_by_apply: true,
    });

    mockExeca.mockClear();
    responseQueue([
      [
        "provider get acme-okta-runtime",
        [
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
        ],
      ],
    ]);
    await actionRollback(JSON.parse(planEntry!.content!).run_id);
    const rollbackCommands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(rollbackCommands).toContain("provider delete test-provider");
    expect(rollbackCommands).not.toContain("sandbox remove test-sandbox");
  });

  it("keeps an owned sandbox receipt retryable when removal fails", async () => {
    const stateDir = "/fakehome/.nemoclaw/state/runs/failed-sandbox-removal";
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/plan.json`, {
      type: "file",
      content: JSON.stringify({
        sandbox_name: "owned-sandbox",
        sandbox_created_by_apply: true,
      }),
    });
    responseQueue([["sandbox remove owned-sandbox", [failureResult("remove denied")]]]);

    await expect(actionRollback("failed-sandbox-removal")).rejects.toThrow(
      /Failed to remove owned sandbox 'owned-sandbox': remove denied/,
    );
    expect(store.get(`${stateDir}/rolled_back`)).toBeUndefined();
  });

  it("keeps owned inference provider cleanup retryable when deletion fails", async () => {
    const stateDir = "/fakehome/.nemoclaw/state/runs/failed-inference-provider-removal";
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/plan.json`, {
      type: "file",
      content: JSON.stringify({
        sandbox_name: "test-sandbox",
        inference_provider_created_by_apply: true,
        inference: { provider_name: "test-provider" },
      }),
    });
    responseQueue([["provider delete test-provider", [failureResult("provider delete denied")]]]);

    await expect(actionRollback("failed-inference-provider-removal")).rejects.toThrow(
      /Failed to remove owned inference provider 'test-provider': provider delete denied/,
    );
    expect(store.get(`${stateDir}/rolled_back`)).toBeUndefined();
  });

  it("rejects an invalid owned inference provider receipt before mutation", async () => {
    const stateDir = "/fakehome/.nemoclaw/state/runs/invalid-inference-provider";
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/plan.json`, {
      type: "file",
      content: JSON.stringify({
        sandbox_name: "test-sandbox",
        inference_provider_created_by_apply: true,
        inference: { provider_name: "../../other" },
      }),
    });

    await expect(actionRollback("invalid-inference-provider")).rejects.toThrow(
      /Invalid rollback inference provider name/,
    );
    expect(mockExeca).not.toHaveBeenCalled();
    expect(store.get(`${stateDir}/rolled_back`)).toBeUndefined();
  });

  it("persists an ownership receipt so failed compensation remains recoverable", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      [
        "provider get acme-okta-runtime",
        [
          failureResult("provider not found"),
          ...Array.from({ length: 5 }, () => ({
            exitCode: 0,
            stdout: matchingProvider,
            stderr: "",
          })),
        ],
      ],
      [
        "provider delete acme-okta-runtime",
        [failureResult("delete denied"), { exitCode: 0, stdout: "", stderr: "" }],
      ],
      [
        "inference set --provider test-provider --model test-model",
        [failureResult("route failed")],
      ],
    ]);

    await expect(actionApply("default", blueprint({ identity: oktaIdentity() }))).rejects.toThrow(
      /route failed; cleanup failed:.*delete denied/,
    );

    const planEntry = [...store.entries()].find(([path]) => path.endsWith("/plan.json"))?.[1];
    expect(planEntry?.content).toBeDefined();
    const plan = JSON.parse(planEntry!.content!);
    expect(plan.identity).toMatchObject({
      provider_created: true,
      attachment_created: false,
    });

    await actionRollback(plan.run_id);
    expect(
      store.get(`/fakehome/.nemoclaw/state/runs/${plan.run_id}/rolled_back`)?.content,
    ).toBeDefined();
  });

  it("persists attachment ownership before the initial credential mint", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      [
        "provider get acme-okta-runtime",
        [
          failureResult("provider not found"),
          ...Array.from({ length: 5 }, () => ({
            exitCode: 0,
            stdout: matchingProvider,
            stderr: "",
          })),
        ],
      ],
      [
        "provider refresh rotate acme-okta-runtime --credential-key OKTA_ACCESS_TOKEN",
        [failureResult("rotate failed")],
      ],
      [
        "provider delete acme-okta-runtime",
        [failureResult("first delete denied"), { exitCode: 0, stdout: "", stderr: "" }],
      ],
    ]);

    await expect(actionApply("default", blueprint({ identity: oktaIdentity() }))).rejects.toThrow(
      /rotate failed.*cleanup failed:.*first delete denied/s,
    );

    const planEntry = [...store.entries()].find(([path]) => path.endsWith("/plan.json"))?.[1];
    expect(planEntry?.content).toBeDefined();
    const plan = JSON.parse(planEntry!.content!);
    expect(plan.identity).toMatchObject({
      provider_created: true,
      attachment_created: true,
    });

    await actionRollback(plan.run_id);
    expect(
      store.get(`/fakehome/.nemoclaw/state/runs/${plan.run_id}/rolled_back`)?.content,
    ).toBeDefined();
  });

  it("surfaces a validated ownership receipt in status and consumes it in rollback", async () => {
    const stateDir = "/fakehome/.nemoclaw/state/runs/identity-run";
    const receipt = {
      provider_type: "okta-runtime-v1",
      provider_name: "acme-okta-runtime",
      credential_key: "OKTA_ACCESS_TOKEN",
      provider_created: true,
      attachment_created: true,
    };
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/plan.json`, {
      type: "file",
      content: JSON.stringify({
        run_id: "identity-run",
        sandbox_name: "test-sandbox",
        sandbox_created_by_apply: true,
        inference_provider_created_by_apply: true,
        inference: { provider_name: "test-provider" },
        identity: receipt,
      }),
    });
    responseQueue([
      [
        "provider get acme-okta-runtime",
        [
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
        ],
      ],
    ]);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    actionStatus("identity-run");
    const statusOutput = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(statusOutput).toContain('"provider_created": true');
    expect(statusOutput).toContain('"attachment_created": true');
    expect(statusOutput).toContain('"inference_provider_created_by_apply": true');
    stdout.mockRestore();
    await actionRollback("identity-run");

    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "provider", "detach", "test-sandbox", "acme-okta-runtime"],
      expect.objectContaining({ reject: false }),
    );
    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      ["provider", "delete", "acme-okta-runtime"],
      expect.objectContaining({ reject: false }),
    );
    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "stop", "test-sandbox"],
      expect.objectContaining({ reject: false }),
    );
    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "remove", "test-sandbox"],
      expect.objectContaining({ reject: false }),
    );
    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      ["provider", "delete", "test-provider"],
      expect.objectContaining({ reject: false }),
    );
    expect(store.get(`${stateDir}/rolled_back`)?.content).toBeDefined();
  });

  it("blocks rollback when the persisted identity ownership receipt is invalid", async () => {
    const stateDir = "/fakehome/.nemoclaw/state/runs/invalid-identity-run";
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/plan.json`, {
      type: "file",
      content: JSON.stringify({
        run_id: "invalid-identity-run",
        sandbox_name: "test-sandbox",
        identity: {
          provider_type: "okta-runtime-v1",
          provider_name: "acme-okta-runtime",
          credential_key: "OKTA_ACCESS_TOKEN",
        },
      }),
    });

    await expect(actionRollback("invalid-identity-run")).rejects.toThrow(
      /identity ownership receipt is invalid/,
    );
    expect(mockExeca).not.toHaveBeenCalled();
  });
});
