// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createRunnerFsStore,
  FAKE_HOME,
  FIXED_RUN_UUID,
  inMemoryFsMethods,
  resolvedEndpointFor,
} from "./runner-mock-fixtures.js";
import {
  createInferenceRouteResult,
  failureResult,
  gatewayStatusResult,
  globalPolicyAbsentResult,
  globalPolicyAuthorityResult,
  globalPolicyHistoryResult,
  MATCHING_INFERENCE_PROVIDER_LISTING,
  MATCHING_INFERENCE_ROUTE_LISTING,
  MATCHING_RUNTIME_PROVIDER_LISTING,
  providersV2EnabledResult,
  resultWithSandboxPolicyAuthority,
  sandboxPolicyAuthorityResult,
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
    closeSync: memory.closeSync,
    fsyncSync: memory.fsyncSync,
    mkdirSync: memory.mkdirSync,
    openSync: memory.openSync,
    readFileSync: memory.readFileSync,
    renameSync: memory.renameSync,
    unlinkSync: memory.unlinkSync,
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

const { BlueprintPolicyAuthorityRefusalError } = await import("./runtime-identity.js");
const { actionApply, actionRollback, actionStatus, loadBlueprint } = await import("./runner.js");

const matchingProvider = MATCHING_RUNTIME_PROVIDER_LISTING;
const matchingInferenceProvider = MATCHING_INFERENCE_PROVIDER_LISTING;
const matchingInferenceRoute = MATCHING_INFERENCE_ROUTE_LISTING;

const success = successResult();
const providersV2Enabled = providersV2EnabledResult();

function responseQueue(
  overrides: Array<[string, Array<{ exitCode?: number; stdout: string; stderr: string }>]>,
) {
  const inferenceRouteResult = createInferenceRouteResult("test-gateway");
  const responses = new Map([
    ["sandbox get -g test-gateway test-sandbox", [failureResult("sandbox not found")]],
    ["provider get -g test-gateway test-provider", [failureResult("provider not found")]],
    ["status", [gatewayStatusResult()]],
    ...overrides,
  ]);
  const fallbacks = new Map([
    [
      "sandbox get -g test-gateway test-sandbox",
      { exitCode: 0, stdout: "Name: test-sandbox\nPhase: Ready", stderr: "" },
    ],
    ["settings get -g test-gateway --global --json", providersV2Enabled],
    ["policy list -g test-gateway --global --limit 1", globalPolicyAbsentResult()],
    [
      "policy get -g test-gateway --full --output json test-sandbox",
      sandboxPolicyAuthorityResult("test-sandbox"),
    ],
  ]);
  mockExeca.mockImplementation(async (_command: string, args: string[]) => {
    const command = args.join(" ");
    const queued = responses.get(command)?.shift();
    return queued ?? inferenceRouteResult(args, fallbacks.get(command) ?? success);
  });
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
      resultWithSandboxPolicyAuthority(
        args,
        args.join(" ") === "settings get -g test-gateway --global --json"
          ? providersV2Enabled
          : success,
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

  it.each([
    ["inference profile", { components: { inference: { profiles: { invalid: null } } } }],
    ["sandbox component", { components: { sandbox: [] } }],
    ["router component", { components: { router: [] } }],
    ["policy component", { components: { policy: [] } }],
    ["identity component", { components: { identity: {} } }],
    [
      "policy rule",
      {
        components: {
          policy: {
            additions: {
              invalid: {
                name: "invalid",
                endpoints: [{ host: "api.test", port: 443, protocol: "rest", rules: [null] }],
              },
            },
          },
        },
      },
    ],
    [
      "policy rule allow mapping",
      {
        components: {
          policy: {
            additions: {
              invalid: {
                name: "invalid",
                endpoints: [
                  { host: "api.test", port: 443, protocol: "rest", rules: [{ allow: null }] },
                ],
              },
            },
          },
        },
      },
    ],
  ])("rejects a malformed %s before planning (#9833)", (_case, value) => {
    store.set("/blueprint/blueprint.yaml", {
      type: "file",
      content: JSON.stringify(value),
    });
    expect(() => loadBlueprint()).toThrow(/must contain a YAML mapping/u);
  });

  it("configures refresh from scoped environment material and attaches the runtime provider", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";

    responseQueue([
      [
        "provider get -g test-gateway acme-okta-runtime",
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
        call[1].slice(0, 6).join(" ") === "provider profile import -g test-gateway --file",
    );
    expect(importCall).toBeDefined();
    const [, importArguments, importOptions] = importCall!;
    expect(importArguments[6]).toMatch(/nemoclaw-runtime-identity-profile-.+\/profile\.yaml$/u);
    expect(importArguments[6]).not.toBe("/blueprint/provider-profiles/okta-runtime-v1.yaml");
    expect(importOptions).toEqual(
      expect.objectContaining({ reject: false, env: expect.any(Object) }),
    );
    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      [
        "provider",
        "create",
        "-g",
        "test-gateway",
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
      ["sandbox", "provider", "attach", "-g", "test-gateway", "test-sandbox", "acme-okta-runtime"],
      expect.objectContaining({ reject: false, env: expect.any(Object) }),
    );
    const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(
      commands.indexOf(
        "inference set -g test-gateway --provider test-provider --model test-model --timeout 180",
      ),
    ).toBeLessThan(
      commands.indexOf("sandbox provider attach -g test-gateway test-sandbox acme-okta-runtime"),
    );
    expect(
      commands.indexOf(
        "provider refresh configure -g test-gateway acme-okta-runtime --credential-key OKTA_ACCESS_TOKEN --strategy oauth2-refresh-token --material client_id=client-id --secret-material-env refresh_token=OKTA_REFRESH_TOKEN --secret-material-env client_secret=OKTA_CLIENT_SECRET",
      ),
    ).toBeLessThan(
      commands.indexOf("sandbox provider attach -g test-gateway test-sandbox acme-okta-runtime"),
    );
    expect(
      commands.indexOf("sandbox provider attach -g test-gateway test-sandbox acme-okta-runtime"),
    ).toBeLessThan(
      commands.indexOf(
        "provider refresh rotate -g test-gateway acme-okta-runtime --credential-key OKTA_ACCESS_TOKEN",
      ),
    );
  });

  it("fails closed when an identity subprocess has no exit code", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      ["provider get -g test-gateway acme-okta-runtime", [failureResult("not found")]],
      [
        "provider create -g test-gateway --name acme-okta-runtime --type okta-runtime-v1 --runtime-credentials",
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
      [
        "sandbox get -g test-gateway test-sandbox",
        [failureResult("gateway configuration not found")],
      ],
    ]);

    await expect(actionApply("default", blueprint({ identity: oktaIdentity() }))).rejects.toThrow(
      /Failed to inspect sandbox 'test-sandbox'.*gateway configuration not found/,
    );

    const commandLines = mockExeca.mock.calls.map(([command, args]) =>
      [command, ...(args ?? [])].join(" "),
    );
    expect(commandLines).toEqual([
      "openshell status",
      "openshell policy list -g test-gateway --global --limit 1",
      "openshell sandbox get -g test-gateway test-sandbox",
    ]);
  });

  it("fails before identity mutation when the target sandbox is not Ready", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      [
        "sandbox get -g test-gateway test-sandbox",
        [{ exitCode: 0, stdout: "Name: test-sandbox\nPhase: Provisioning", stderr: "" }],
      ],
    ]);

    await expect(actionApply("default", blueprint({ identity: oktaIdentity() }))).rejects.toThrow(
      /Sandbox 'test-sandbox' is not reusable.*Ready phase.*Provisioning/,
    );

    const commandLines = mockExeca.mock.calls.map(([command, args]) =>
      [command, ...(args ?? [])].join(" "),
    );
    expect(commandLines).toEqual([
      "openshell status",
      "openshell policy list -g test-gateway --global --limit 1",
      "openshell sandbox get -g test-gateway test-sandbox",
    ]);
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
        [
          "sandbox get -g test-gateway test-sandbox",
          [failureResult("sandbox not found"), racedSandbox],
        ],
        [
          "provider get -g test-gateway acme-okta-runtime",
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
          "sandbox create -g test-gateway --from openclaw --name test-sandbox --forward 18789",
          [failureResult("sandbox already exists")],
        ],
      ]);

      await expect(actionApply("default", blueprint({ identity: oktaIdentity() }))).rejects.toThrow(
        expectedError,
      );

      const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
      expect(commands).not.toContain(
        "sandbox provider attach -g test-gateway test-sandbox acme-okta-runtime",
      );
      expect(commands).toContain("provider delete -g test-gateway acme-okta-runtime");
    },
  );

  it("fails before identity mutation when a reused sandbox's inference provider cannot be inspected", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      [
        "sandbox get -g test-gateway test-sandbox",
        [{ exitCode: 0, stdout: "Name: test-sandbox\nPhase: Ready", stderr: "" }],
      ],
      [
        "provider get -g test-gateway test-provider",
        [failureResult("gateway configuration not found")],
      ],
    ]);

    await expect(actionApply("default", blueprint({ identity: oktaIdentity() }))).rejects.toThrow(
      /Failed to inspect inference provider 'test-provider'.*gateway configuration not found/,
    );

    const commandLines = mockExeca.mock.calls.map(([command, args]) =>
      [command, ...(args ?? [])].join(" "),
    );
    expect(commandLines).toEqual([
      "openshell status",
      "openshell policy list -g test-gateway --global --limit 1",
      "openshell sandbox get -g test-gateway test-sandbox",
      "openshell provider get -g test-gateway test-provider",
    ]);
  });

  it("rejects a mismatched inference provider before identity mutation for a new sandbox", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      [
        "provider get -g test-gateway test-provider",
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

    const commandLines = mockExeca.mock.calls.map(([command, args]) =>
      [command, ...(args ?? [])].join(" "),
    );
    expect(commandLines).toEqual([
      "openshell status",
      "openshell policy list -g test-gateway --global --limit 1",
      "openshell sandbox get -g test-gateway test-sandbox",
      "openshell provider get -g test-gateway test-provider",
    ]);
  });

  it("rechecks global authority before runtime identity preparation (#9833)", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      [
        "policy list -g test-gateway --global --limit 1",
        [globalPolicyAbsentResult(), globalPolicyHistoryResult()],
      ],
      ["policy get -g test-gateway --global --full --output json", [globalPolicyAuthorityResult()]],
    ]);

    await expect(actionApply("default", blueprint({ identity: oktaIdentity() }))).rejects.toThrow(
      /authority changed/,
    );

    const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(commands).not.toContain(
      "provider create -g test-gateway --name acme-okta-runtime --type okta-runtime-v1 --runtime-credentials",
    );
    expect(commands).not.toContain(
      "sandbox create -g test-gateway --from openclaw --name test-sandbox --forward 18789",
    );
  });

  it("records reused sandbox authority before refusing missing identity requirements (#9833)", async () => {
    responseQueue([
      [
        "sandbox get -g test-gateway test-sandbox",
        [{ exitCode: 0, stdout: "Name: test-sandbox\nPhase: Ready", stderr: "" }],
      ],
      [
        "policy get -g test-gateway --full --output json test-sandbox",
        [sandboxPolicyAuthorityResult("test-sandbox", "externally-managed")],
      ],
    ]);
    const input = blueprint({
      identity: oktaIdentity(),
      policy: {
        additions: {
          protected_api: {
            endpoints: [{ host: "api.example.okta.com", port: 443 }],
          },
        },
      },
    });

    await expect(actionApply("default", input)).rejects.toThrow(/missing entries "protected_api"/);

    const planEntry = [...store.entries()].find(([key]) => key.endsWith("/plan.json"))?.[1];
    expect(JSON.parse(planEntry?.content ?? "{}").policy_authority).toEqual({
      authority: "externally-managed",
      scope: "sandbox",
      sandbox_name: "test-sandbox",
    });
    const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(commands).not.toContain(
      "provider create -g test-gateway --name acme-okta-runtime --type okta-runtime-v1 --runtime-credentials",
    );
  });

  it("fails before identity mutation when a reused route cannot be inspected", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      [
        "sandbox get -g test-gateway test-sandbox",
        [{ exitCode: 0, stdout: "Name: test-sandbox\nPhase: Ready", stderr: "" }],
      ],
      [
        "provider get -g test-gateway test-provider",
        [{ exitCode: 0, stdout: matchingInferenceProvider, stderr: "" }],
      ],
      ["inference get -g test-gateway", [failureResult("gateway route inspection unavailable")]],
    ]);

    await expect(actionApply("default", blueprint({ identity: oktaIdentity() }))).rejects.toThrow(
      /Failed to inspect the active inference route.*gateway route inspection unavailable/,
    );

    const commandLines = mockExeca.mock.calls.map(([command, args]) =>
      [command, ...(args ?? [])].join(" "),
    );
    expect(commandLines).toEqual([
      "openshell status",
      "openshell policy list -g test-gateway --global --limit 1",
      "openshell sandbox get -g test-gateway test-sandbox",
      "openshell provider get -g test-gateway test-provider",
      "openshell inference get -g test-gateway",
    ]);
  });

  it("revalidates the sandbox immediately before attaching runtime identity", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      [
        "sandbox get -g test-gateway test-sandbox",
        [
          { exitCode: 0, stdout: "Name: test-sandbox\nPhase: Ready", stderr: "" },
          { exitCode: 0, stdout: "Name: test-sandbox\nPhase: Provisioning", stderr: "" },
        ],
      ],
      [
        "provider get -g test-gateway test-provider",
        [{ exitCode: 0, stdout: matchingInferenceProvider, stderr: "" }],
      ],
      [
        "provider get -g test-gateway acme-okta-runtime",
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
    expect(commands).not.toContain(
      "sandbox provider attach -g test-gateway test-sandbox acme-okta-runtime",
    );
    expect(commands).toContain("provider delete -g test-gateway acme-okta-runtime");
  });

  it.each([
    ["attachment", 4, false],
    ["credential mint", 5, true],
  ])(
    "compensates runtime identity when authority changes before %s (#9833)",
    async (_edge, driftAtInspection, attachmentCreated) => {
      process.env.OKTA_CLIENT_ID = "client-id";
      process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
      process.env.OKTA_CLIENT_SECRET = "client-secret";
      responseQueue([
        [
          "provider get -g test-gateway acme-okta-runtime",
          [
            failureResult("provider not found"),
            ...Array.from({ length: 3 }, () => ({
              exitCode: 0,
              stdout: matchingProvider,
              stderr: "",
            })),
          ],
        ],
        [
          "policy get -g test-gateway --full --output json test-sandbox",
          Array.from({ length: driftAtInspection }, (_, index) =>
            sandboxPolicyAuthorityResult(
              "test-sandbox",
              index + 1 < driftAtInspection ? "nemoclaw-managed" : "externally-managed",
            ),
          ),
        ],
      ]);

      const error = await actionApply("default", blueprint({ identity: oktaIdentity() })).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(BlueprintPolicyAuthorityRefusalError);
      expect((error as Error).message).toMatch(/authority changed/);

      const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
      expect(
        commands.includes("sandbox provider attach -g test-gateway test-sandbox acme-okta-runtime"),
      ).toBe(attachmentCreated);
      expect(commands).not.toContain(
        "provider refresh rotate -g test-gateway acme-okta-runtime --credential-key OKTA_ACCESS_TOKEN",
      );
      expect(
        commands.includes("sandbox provider detach -g test-gateway test-sandbox acme-okta-runtime"),
      ).toBe(attachmentCreated);
      expect(commands).toContain("provider delete -g test-gateway acme-okta-runtime");
      expect(commands).toContain("sandbox stop -g test-gateway test-sandbox");
      expect(commands).toContain("sandbox remove -g test-gateway test-sandbox");
      expect(commands).toContain("provider delete -g test-gateway test-provider");
      expect(commands.indexOf("provider delete -g test-gateway acme-okta-runtime")).toBeLessThan(
        commands.indexOf("sandbox stop -g test-gateway test-sandbox"),
      );
      expect(commands.indexOf("sandbox stop -g test-gateway test-sandbox")).toBeLessThan(
        commands.indexOf("sandbox remove -g test-gateway test-sandbox"),
      );
      expect(commands.indexOf("sandbox remove -g test-gateway test-sandbox")).toBeLessThan(
        commands.indexOf("provider delete -g test-gateway test-provider"),
      );
      const plan = [...store.entries()].find(([path]) => path.endsWith("/plan.json"))?.[1];
      expect(JSON.parse(plan?.content ?? "{}")).toMatchObject({
        sandbox_created_by_apply: false,
        inference_provider_created_by_apply: false,
        identity: { provider_created: false, attachment_created: false },
      });
    },
  );

  it("preserves the typed authority refusal when attached identity cleanup fails (#9833)", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      [
        "provider get -g test-gateway acme-okta-runtime",
        [
          failureResult("provider not found"),
          ...Array.from({ length: 3 }, () => ({
            exitCode: 0,
            stdout: matchingProvider,
            stderr: "",
          })),
        ],
      ],
      [
        "policy get -g test-gateway --full --output json test-sandbox",
        Array.from({ length: 5 }, (_, index) =>
          sandboxPolicyAuthorityResult(
            "test-sandbox",
            index < 4 ? "nemoclaw-managed" : "externally-managed",
          ),
        ),
      ],
      [
        "sandbox provider detach -g test-gateway test-sandbox acme-okta-runtime",
        [failureResult("detach denied")],
      ],
    ]);

    const error = await actionApply("default", blueprint({ identity: oktaIdentity() })).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(BlueprintPolicyAuthorityRefusalError);
    expect((error as Error).message).toMatch(
      /authority changed[\s\S]*cleanup failed[\s\S]*detach denied/u,
    );

    const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(commands).toContain(
      "sandbox provider attach -g test-gateway test-sandbox acme-okta-runtime",
    );
    expect(commands).toContain(
      "sandbox provider detach -g test-gateway test-sandbox acme-okta-runtime",
    );
    expect(commands).not.toContain(
      "provider refresh rotate -g test-gateway acme-okta-runtime --credential-key OKTA_ACCESS_TOKEN",
    );
    expect(commands).not.toContain("provider delete -g test-gateway acme-okta-runtime");
    expect(commands).toContain("sandbox stop -g test-gateway test-sandbox");
    expect(commands).toContain("sandbox remove -g test-gateway test-sandbox");
    expect(commands).toContain("provider delete -g test-gateway test-provider");
    expect(
      commands.indexOf("sandbox provider detach -g test-gateway test-sandbox acme-okta-runtime"),
    ).toBeLessThan(commands.indexOf("sandbox stop -g test-gateway test-sandbox"));
    expect(commands.indexOf("sandbox remove -g test-gateway test-sandbox")).toBeLessThan(
      commands.indexOf("provider delete -g test-gateway test-provider"),
    );
    const plan = [...store.entries()].find(([path]) => path.endsWith("/plan.json"))?.[1];
    expect(JSON.parse(plan?.content ?? "{}")).toMatchObject({
      sandbox_created_by_apply: false,
      inference_provider_created_by_apply: false,
      identity: { provider_created: true, attachment_created: true },
    });
  });

  it("compensates a created identity provider and sandbox when apply later fails", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      [
        "provider get -g test-gateway acme-okta-runtime",
        [
          failureResult("provider not found"),
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
        ],
      ],
      [
        "inference set -g test-gateway --provider test-provider --model test-model --timeout 180",
        [failureResult("route failed")],
      ],
    ]);

    await expect(actionApply("default", blueprint({ identity: oktaIdentity() }))).rejects.toThrow(
      /route failed/,
    );

    expect(mockExeca).not.toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "provider", "detach", "-g", "test-gateway", "test-sandbox", "acme-okta-runtime"],
      expect.anything(),
    );
    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      ["provider", "delete", "-g", "test-gateway", "acme-okta-runtime"],
      expect.objectContaining({ reject: false }),
    );
    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "remove", "-g", "test-gateway", "test-sandbox"],
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
        "provider get -g test-gateway acme-okta-runtime",
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
    expect(commands).toContain(
      "sandbox provider detach -g test-gateway test-sandbox acme-okta-runtime",
    );
    expect(commands).toContain("provider delete -g test-gateway acme-okta-runtime");
    expect(commands).toContain("sandbox remove -g test-gateway test-sandbox");
    expect(commands).toContain("provider delete -g test-gateway test-provider");
    const planEntry = [...store.entries()].find(([path]) => path.endsWith("/plan.json"))?.[1];
    expect(JSON.parse(planEntry!.content!)).toMatchObject({
      sandbox_created_by_apply: false,
      inference_provider_created_by_apply: false,
      identity: { provider_created: false, attachment_created: false },
    });
  });

  it("persists reused sandbox ownership and preserves it during later rollback", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      [
        "sandbox get -g test-gateway test-sandbox",
        [{ exitCode: 0, stdout: "Name: test-sandbox\nPhase: Ready", stderr: "" }],
      ],
      [
        "provider get -g test-gateway test-provider",
        [{ exitCode: 0, stdout: matchingInferenceProvider, stderr: "" }],
      ],
      [
        "inference get -g test-gateway",
        [{ exitCode: 0, stdout: matchingInferenceRoute, stderr: "" }],
      ],
      [
        "provider get -g test-gateway acme-okta-runtime",
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
      "sandbox create -g test-gateway --from openclaw --name test-sandbox --forward 18789",
    );
    expect(applyCommands).toContain("provider get -g test-gateway test-provider");
    expect(applyCommands).toContain("inference get -g test-gateway");
    expect(applyCommands).not.toContain(
      "inference set -g test-gateway --provider test-provider --model test-model --timeout 180",
    );
    expect(applyCommands).not.toContain(
      "provider create -g test-gateway --name test-provider --type openai --config OPENAI_BASE_URL=https://api.example.com/v1",
    );
    const planEntry = [...store.entries()].find(([path]) => path.endsWith("/plan.json"))?.[1];
    expect(planEntry?.content).toBeDefined();
    const plan = JSON.parse(planEntry!.content!);
    expect(plan.sandbox_created_by_apply).toBe(false);
    expect(plan.inference_provider_created_by_apply).toBe(false);
    expect(plan.provider_gateway).toBe("test-gateway");

    mockExeca.mockClear();
    vi.stubEnv("OPENSHELL_GATEWAY", "gateway-b");
    responseQueue([
      [
        "provider get -g test-gateway acme-okta-runtime",
        [
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
        ],
      ],
    ]);
    await actionRollback(plan.run_id);

    const rollbackCommands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(rollbackCommands).not.toContain("sandbox stop -g test-gateway test-sandbox");
    expect(rollbackCommands).not.toContain("sandbox remove -g test-gateway test-sandbox");
    expect(rollbackCommands).toContain(
      "sandbox provider detach -g test-gateway test-sandbox acme-okta-runtime",
    );
    expect(rollbackCommands).toContain("provider delete -g test-gateway acme-okta-runtime");
  });

  it("preserves a sandbox for a legacy plan without an ownership receipt", async () => {
    const stateDir = "/fakehome/.nemoclaw/state/runs/legacy-run";
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/plan.json`, {
      type: "file",
      content: JSON.stringify({
        sandbox_name: "existing-sandbox",
        identity: {
          provider_type: "okta-runtime-v1",
          provider_name: "acme-okta-runtime",
          credential_key: "OKTA_ACCESS_TOKEN",
          provider_created: false,
          attachment_created: false,
        },
      }),
    });

    await actionRollback("legacy-run");

    const rollbackCommands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(rollbackCommands).not.toContain("sandbox stop -g test-gateway existing-sandbox");
    expect(rollbackCommands).not.toContain("sandbox remove -g test-gateway existing-sandbox");
    expect(mockExeca).not.toHaveBeenCalled();
    expect(store.get(`${stateDir}/rolled_back`)?.content).toBeDefined();
  });

  it("keeps an owned sandbox receipt retryable when removal fails", async () => {
    const stateDir = "/fakehome/.nemoclaw/state/runs/failed-sandbox-removal";
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/plan.json`, {
      type: "file",
      content: JSON.stringify({
        sandbox_name: "owned-sandbox",
        sandbox_created_by_apply: true,
        provider_gateway: "test-gateway",
      }),
    });
    responseQueue([
      ["sandbox remove -g test-gateway owned-sandbox", [failureResult("remove denied")]],
    ]);

    await expect(actionRollback("failed-sandbox-removal")).rejects.toThrow(
      /Failed to remove owned sandbox 'owned-sandbox': remove denied/,
    );
    expect(store.get(`${stateDir}/rolled_back`)).toBeUndefined();
  });

  it("persists an ownership receipt so failed compensation remains recoverable", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      [
        "provider get -g test-gateway acme-okta-runtime",
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
        "provider delete -g test-gateway acme-okta-runtime",
        [failureResult("delete denied"), { exitCode: 0, stdout: "", stderr: "" }],
      ],
      [
        "inference set -g test-gateway --provider test-provider --model test-model --timeout 180",
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
        "provider get -g test-gateway acme-okta-runtime",
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
        "provider refresh rotate -g test-gateway acme-okta-runtime --credential-key OKTA_ACCESS_TOKEN",
        [failureResult("rotate failed")],
      ],
      [
        "provider delete -g test-gateway acme-okta-runtime",
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
        provider_gateway: "test-gateway",
        inference: { provider_name: "test-provider" },
        identity: receipt,
      }),
    });
    responseQueue([
      [
        "provider get -g test-gateway acme-okta-runtime",
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
      ["sandbox", "provider", "detach", "-g", "test-gateway", "test-sandbox", "acme-okta-runtime"],
      expect.objectContaining({ reject: false }),
    );
    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      ["provider", "delete", "-g", "test-gateway", "acme-okta-runtime"],
      expect.objectContaining({ reject: false }),
    );
    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "stop", "-g", "test-gateway", "test-sandbox"],
      expect.objectContaining({ reject: false }),
    );
    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "remove", "-g", "test-gateway", "test-sandbox"],
      expect.objectContaining({ reject: false }),
    );
    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      ["provider", "delete", "-g", "test-gateway", "test-provider"],
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
