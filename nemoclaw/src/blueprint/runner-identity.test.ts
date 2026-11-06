// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { withNativeInferenceFixture } from "./runner-test-fixtures.js";

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
  createMutableIdentityPolicyResult,
  failureResult,
  MATCHING_INFERENCE_PROVIDER_LISTING,
  MATCHING_INFERENCE_ROUTE_LISTING,
  MATCHING_RUNTIME_PROVIDER_LISTING,
  absentGlobalPolicyResult,
  resultWithBlueprintPolicy,
  successResult,
  TEST_SANDBOX_POLICY,
  TEST_SANDBOX_POLICY_PATH,
} from "./runner-test-fixtures.js";

const { store } = createRunnerFsStore();
const realpaths = new Map<string, string>();
const mockExeca = vi.fn();

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => FAKE_HOME };
});
vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID: () => FIXED_RUN_UUID,
}));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  const memory = inMemoryFsMethods(store, { realpaths, spy: vi.fn });
  return {
    ...original,
    existsSync: memory.existsSync,
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
vi.mock("./private-networks.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./private-networks.js")>()),
  isPrivateHostname: () => false,
}));

const {
  actionApply: applyWithoutFixture,
  actionPlan,
  actionRollback,
  actionStatus,
  loadBlueprint,
} = await import("./runner.js");
const actionApply = withNativeInferenceFixture(applyWithoutFixture);

const matchingProvider = MATCHING_RUNTIME_PROVIDER_LISTING;
const matchingInferenceProvider = MATCHING_INFERENCE_PROVIDER_LISTING;
const matchingInferenceRoute = MATCHING_INFERENCE_ROUTE_LISTING;
const runtimeIdentityProfilePath = "/blueprint/provider-profiles/okta-runtime-v1.yaml";

const success = successResult();
const absentGlobalPolicy = absentGlobalPolicyResult();
const identityPolicyAdditions = {
  identity_api: {
    name: "identity_api",
    endpoints: [{ host: "identity.example.com", port: 443, access: "full" as const }],
  },
};

function runtimeIdentityProfileExport(args: readonly string[]) {
  return args.join(" ") === "provider profile export okta-runtime-v1 --output yaml"
    ? { exitCode: 0, stdout: store.get(runtimeIdentityProfilePath)?.content ?? "", stderr: "" }
    : null;
}

function responseQueue(
  overrides: Array<
    [string, Array<{ exitCode?: number; stdout: string; stderr: string; timedOut?: boolean }>]
  >,
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
    ["provider get test-provider", { exitCode: 0, stdout: matchingInferenceProvider, stderr: "" }],
    ["policy list --global --page-size 1 --output json", absentGlobalPolicy],
  ]);
  mockExeca.mockImplementation(async (_command: string, args: string[]) => {
    const command = args.join(" ");
    const fallback =
      responses.get(command)?.shift() ??
      fallbacks.get(command) ??
      runtimeIdentityProfileExport(args) ??
      success;
    return fallback.exitCode === undefined
      ? fallback
      : resultWithBlueprintPolicy(args, {
          ...fallback,
          exitCode: fallback.exitCode ?? 1,
        });
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

function installPolicyIdentityResponses(policyWriteFailure?: string): void {
  const identityPolicyResult = createMutableIdentityPolicyResult({
    readMergedPolicy: () => {
      const update = [...store.entries()].find(([path]) => path.endsWith("policy-update.yaml"));
      return YAML.parse(update?.[1].content ?? "{}");
    },
    runtimeProviderListing: matchingProvider,
    policyWriteFailure,
  });
  mockExeca.mockImplementation(async (_command: string, args: string[]) =>
    args.join(" ") === "sandbox get test-sandbox"
      ? failureResult("sandbox not found")
      : (runtimeIdentityProfileExport(args) ?? identityPolicyResult(args)),
  );
}

describe("blueprint identity wrapper", () => {
  beforeEach(() => {
    store.clear();
    store.set(TEST_SANDBOX_POLICY_PATH, { type: "file", content: TEST_SANDBOX_POLICY });
    vi.stubEnv("OPENSHELL_SANDBOX_POLICY", TEST_SANDBOX_POLICY_PATH);
    realpaths.clear();
    vi.clearAllMocks();
    mockExeca.mockImplementation(async (_command: string, args: string[]) =>
      resultWithBlueprintPolicy(
        args,
        runtimeIdentityProfileExport(args) ??
          (args.join(" ") === "policy list --global --page-size 1 --output json"
            ? absentGlobalPolicy
            : success),
      ),
    );
    process.env.NEMOCLAW_BLUEPRINT_PATH = "/blueprint";
    store.set("/blueprint", { type: "dir" });
    store.set(runtimeIdentityProfilePath, {
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
    vi.unstubAllEnvs();
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
    expect(commands.indexOf("forward start 18789 test-sandbox")).toBeLessThan(
      commands.indexOf("sandbox provider attach test-sandbox acme-okta-runtime"),
    );
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

  it("bounds a timed-out profile export before runtime provider creation", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      ["provider get acme-okta-runtime", [failureResult("provider not found")]],
      [
        "provider profile export okta-runtime-v1 --output yaml",
        [{ stdout: "", stderr: "", timedOut: true }],
      ],
    ]);

    await expect(actionApply("default", blueprint({ identity: oktaIdentity() }))).rejects.toThrow(
      /profile 'okta-runtime-v1'.*OpenShell command timed out after 30 seconds/,
    );
    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      ["provider", "profile", "export", "okta-runtime-v1", "--output", "yaml"],
      expect.objectContaining({ timeout: 30_000, reject: false }),
    );
    expect(mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "))).not.toContain(
      "provider create --name acme-okta-runtime --type okta-runtime-v1 --runtime-credentials",
    );
  });

  it("applies policy before inference and runtime credential mutations", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    installPolicyIdentityResponses();

    await actionApply(
      "default",
      blueprint({ policy: { additions: identityPolicyAdditions }, identity: oktaIdentity() }),
    );

    const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    const policySet = commands.findIndex((command) => command.startsWith("policy set "));
    const policyVerification = commands.findIndex(
      (command, index) =>
        index > policySet &&
        command === "policy get -g test-gateway --full --output json test-sandbox",
    );
    const nativeReady = commands.indexOf("forward start 18789 test-sandbox");
    const runtimeProviderCreate = commands.findIndex((command) =>
      command.startsWith("provider create --name acme-okta-runtime "),
    );
    const runtimeAttachment = commands.indexOf(
      "sandbox provider attach test-sandbox acme-okta-runtime",
    );

    expect(policySet).toBeGreaterThanOrEqual(0);
    expect(policyVerification).toBeGreaterThan(policySet);
    expect(nativeReady).toBeGreaterThan(policyVerification);
    expect(runtimeProviderCreate).toBeGreaterThan(policyVerification);
    expect(runtimeAttachment).toBeGreaterThan(policyVerification);
  });

  it("does not mutate providers or credentials after a policy refusal", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    installPolicyIdentityResponses("policy denied");

    await expect(
      actionApply(
        "default",
        blueprint({ policy: { additions: identityPolicyAdditions }, identity: oktaIdentity() }),
      ),
    ).rejects.toThrow(/Failed to apply policy additions: policy denied/);

    const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(commands.some((command) => command.startsWith("provider create "))).toBe(false);
    expect(commands.some((command) => command.startsWith("inference set "))).toBe(false);
    expect(commands.some((command) => command.startsWith("provider refresh "))).toBe(false);
    expect(commands.some((command) => command.startsWith("sandbox provider attach "))).toBe(false);
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

  it("fails closed before create when existing-sandbox inspection is inconclusive", async () => {
    responseQueue([["sandbox get test-sandbox", [failureResult("gateway transport unavailable")]]]);

    await expect(actionApply("default", blueprint({ identity: oktaIdentity() }))).rejects.toThrow(
      /Failed to inspect sandbox 'test-sandbox'.*gateway transport unavailable/su,
    );

    const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(commands).not.toContain(
      `sandbox create -g test-gateway --from openclaw --name test-sandbox --policy /tmp/nemoclaw-test-policy.yaml --no-auto-providers --label ai.nvidia.nemoclaw.create-attempt=${"a".repeat(62)} --detach`,
    );
    expect(commands.some((command) => command.startsWith("provider create "))).toBe(false);
  });

  it("preserves verified native inference while attaching a runtime identity", async () => {
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

    const nativeInferenceObserver = vi.fn(async () => "verified-native-identity");
    await actionApply("default", blueprint({ identity: oktaIdentity() }), {
      nativeInferenceObserver,
    });
    expect(nativeInferenceObserver).toHaveBeenCalledWith({
      gatewayName: "test-gateway",
      sandboxName: "test-sandbox",
      provider: "test-provider",
      model: "test-model",
      api: "openai-completions",
      endpointUrl: "https://api.example.com/v1",
    });

    const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(commands).not.toContain(
      `sandbox create -g test-gateway --from openclaw --name test-sandbox --policy /tmp/nemoclaw-test-policy.yaml --no-auto-providers --label ai.nvidia.nemoclaw.create-attempt=${"a".repeat(62)} --detach`,
    );
    expect(
      commands.some((command) =>
        /^(?:inference |provider (?:create|update).*--name test-provider)/u.test(command),
      ),
    ).toBe(false);
    expect(commands).toContain("sandbox provider attach test-sandbox acme-okta-runtime");
  });

  it("refuses concurrent sandbox creation without recorded native authority", async () => {
    responseQueue([
      [
        `sandbox create -g test-gateway --from openclaw --name test-sandbox --policy /tmp/nemoclaw-test-policy.yaml --no-auto-providers --label ai.nvidia.nemoclaw.create-attempt=${"a".repeat(62)} --detach`,
        [failureResult("sandbox already exists")],
      ],
    ]);
    const nativeInferenceObserver = vi.fn(async (): Promise<string> => {
      throw new Error("native authority missing");
    });
    await expect(
      actionApply("default", blueprint({ identity: oktaIdentity() }), {
        nativeInferenceObserver,
      }),
    ).rejects.toThrow(/Failed to create sandbox.*already exists/);
    expect(nativeInferenceObserver).not.toHaveBeenCalled();
    const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(
      commands.some((command) =>
        /^(?:inference |provider create --name test-provider)/u.test(command),
      ),
    ).toBe(false);
  });

  it.each([
    ["missing host observer", undefined, /requires the host native inference observer/],
    [
      "missing native authority",
      async (): Promise<string> => {
        throw new Error("native authority missing");
      },
      /native authority missing/,
    ],
    ["invalid native observation", async (): Promise<string> => "", /could not be verified/],
  ] as const)(
    "refuses reuse with %s before mutation",
    async (_label, nativeInferenceObserver, expected) => {
      responseQueue([
        [
          "sandbox get test-sandbox",
          [{ exitCode: 0, stdout: "Name: test-sandbox\nPhase: Ready", stderr: "" }],
        ],
      ]);
      await expect(
        actionApply("default", blueprint({ identity: oktaIdentity() }), {
          nativeInferenceObserver,
        }),
      ).rejects.toThrow(expected);
      const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
      expect(
        commands.some((command) =>
          /^(?:policy set|inference set|provider (?:create|refresh)|sandbox (?:create|provider attach))/u.test(
            command,
          ),
        ),
      ).toBe(false);
    },
  );

  it("stops identity mutation when the verified native selection changes", async () => {
    responseQueue([
      [
        "sandbox get test-sandbox",
        [{ exitCode: 0, stdout: "Name: test-sandbox\nPhase: Ready", stderr: "" }],
      ],
    ]);
    const nativeInferenceObserver = vi
      .fn()
      .mockResolvedValueOnce("original")
      .mockResolvedValue("replacement");
    await expect(
      actionApply("default", blueprint({ identity: oktaIdentity() }), { nativeInferenceObserver }),
    ).rejects.toThrow(/Native inference identity changed/);
    const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(
      commands.some((command) =>
        /^(?:inference set|provider (?:create|refresh)|sandbox provider attach)/u.test(command),
      ),
    ).toBe(false);
  });

  it("creates the sandbox native route without reading the retired global inference route", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      [
        "provider get test-provider",
        [{ exitCode: 0, stdout: matchingInferenceProvider, stderr: "" }],
      ],
      [
        "inference get",
        [
          {
            exitCode: 0,
            stdout: "Inference:\n  Not configured\nSystem inference:\n  Not configured\n",
            stderr: "",
          },
        ],
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

    const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(commands).toContain("forward start 18789 test-sandbox");
    expect(commands.some((command) => command.startsWith("inference "))).toBe(false);
  });

  it("refuses a timeout change without the host configuration boundary", async () => {
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
    await expect(
      actionApply("default", input, {
        nativeInferenceObserver: async () => "verified-native-identity",
      }),
    ).rejects.toThrow(/require the host configuration boundary/);

    const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(
      commands.some((command) =>
        /^(?:inference set|provider create|provider refresh|sandbox provider attach)/u.test(
          command,
        ),
      ),
    ).toBe(false);
  });

  it("preserves credential presence and updates native timeout before attaching runtime identity", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    vi.stubEnv("BLUEPRINT_TEST_CREDENTIAL", "host-secret-not-rotated");
    responseQueue([
      ["sandbox get test-sandbox", [{ exitCode: 0, stdout: "Name: test-sandbox", stderr: "" }]],
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
    const inference = input.components!.inference!.profiles!.default!;
    inference.timeout_secs = 300;
    inference.credential_env = "BLUEPRINT_TEST_CREDENTIAL";
    const observer = vi.fn(async () => "verified-native-identity");
    const preparer = vi.fn(async () => {
      const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
      expect(commands.some((command) => command.startsWith("sandbox provider attach"))).toBe(false);
    });
    await actionApply("default", input, {
      nativeInferenceObserver: observer,
      nativeInferencePreparer: preparer,
    });
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({ requiresCredential: true }));
    expect(preparer).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutSeconds: 300,
        requiresCredential: true,
        model: "test-model",
      }),
    );
    expect(
      JSON.stringify(preparer.mock.calls) + JSON.stringify(mockExeca.mock.calls),
    ).not.toContain("host-secret-not-rotated");
  });

  it("propagates native provider identity rejection without creating runtime credentials", async () => {
    responseQueue([]);
    const nativeInferenceCreator = vi.fn(async () => {
      throw new Error("Native inference provider identity changed");
    });
    await expect(
      actionApply("default", blueprint({ identity: oktaIdentity() }), { nativeInferenceCreator }),
    ).rejects.toThrow("Native inference provider identity changed");
    const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(
      commands.some((command) =>
        /^(?:inference |provider (?:create|delete|refresh)|sandbox provider attach)/u.test(command),
      ),
    ).toBe(false);
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

  it("preserves a created identity provider and sandbox when apply later fails (#9833)", async () => {
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
      ["sandbox provider attach test-sandbox acme-okta-runtime", [failureResult("route failed")]],
    ]);

    await expect(actionApply("default", blueprint({ identity: oktaIdentity() }))).rejects.toThrow(
      /route failed.*automatic cleanup was refused/u,
    );

    expect(mockExeca).not.toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "provider", "detach", "test-sandbox", "acme-okta-runtime"],
      expect.anything(),
    );
    expect(mockExeca).not.toHaveBeenCalledWith(
      "openshell",
      ["provider", "delete", "acme-okta-runtime"],
      expect.anything(),
    );
    expect(mockExeca).not.toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "remove", "-g", "test-gateway", "test-sandbox"],
      expect.anything(),
    );
    const planEntry = [...store.entries()].find(([path]) => path.endsWith("/plan.json"))?.[1];
    expect(JSON.parse(planEntry!.content!).identity).toMatchObject({
      provider_created: true,
      attachment_created: false,
    });
    expect(JSON.parse(planEntry!.content!).inference_provider_created_by_apply).toBe(true);
  });

  it("stops before provider or credential mutation when a policy read fails", async () => {
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
    ).rejects.toThrow(/automatic cleanup was refused.*mutable resource names/u);

    const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(commands).not.toContain("provider get test-provider");
    expect(commands).not.toContain("provider get acme-okta-runtime");
    expect(commands.some((command) => command.startsWith("provider create "))).toBe(false);
    expect(commands.some((command) => command.startsWith("inference set "))).toBe(false);
    expect(commands.some((command) => command.startsWith("provider refresh "))).toBe(false);
    expect(commands.some((command) => command.startsWith("sandbox provider attach "))).toBe(false);
    expect(commands).not.toContain("sandbox provider detach test-sandbox acme-okta-runtime");
    expect(commands).not.toContain("provider delete acme-okta-runtime");
    expect(commands).not.toContain("sandbox stop -g test-gateway test-sandbox");
    expect(commands).not.toContain("sandbox remove -g test-gateway test-sandbox");
    expect(commands).not.toContain("provider delete test-provider");
    const planEntry = [...store.entries()].find(([path]) => path.endsWith("/plan.json"))?.[1];
    const plan = JSON.parse(planEntry!.content!);
    expect(plan).toMatchObject({
      sandbox_created_by_apply: true,
      inference_provider_created_by_apply: false,
    });
    expect(plan).not.toHaveProperty("identity");
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

  it("preserves a sandbox after a later failure without an identity component (#9833)", async () => {
    responseQueue([["forward start 18789 test-sandbox", [failureResult("route failed")]]]);

    await expect(actionApply("default", blueprint())).rejects.toThrow(
      /route failed.*automatic cleanup was refused/u,
    );

    expect(mockExeca).not.toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "remove", "-g", "test-gateway", "test-sandbox"],
      expect.anything(),
    );
  });

  it("preserves the created sandbox when rollback has only mutable-name mutations (#9833)", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      ["sandbox get test-sandbox", [failureResult("sandbox not found")]],
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
    expect(applyCommands).toContain(
      `sandbox create -g test-gateway --from openclaw --name test-sandbox --policy /tmp/nemoclaw-test-policy.yaml --no-auto-providers --label ai.nvidia.nemoclaw.create-attempt=${"a".repeat(62)} --detach`,
    );
    expect(applyCommands).not.toContain("provider get test-provider");
    expect(applyCommands).not.toContain("inference get");
    expect(applyCommands).not.toContain(
      "inference set --provider test-provider --model test-model",
    );
    expect(applyCommands).not.toContain(
      "provider create --name test-provider --type openai --config OPENAI_BASE_URL=https://api.example.com/v1",
    );
    const planEntry = [...store.entries()].find(([path]) => path.endsWith("/plan.json"))?.[1];
    expect(planEntry?.content).toBeDefined();
    const plan = JSON.parse(planEntry!.content!);
    expect(plan.sandbox_created_by_apply).toBe(true);
    expect(plan.inference_provider_created_by_apply).toBe(true);
    expect(plan.native_inference).toMatchObject({
      sandboxId: "sandbox-id-1",
      providerAttachment: { providerId: "test-native-provider-id" },
    });

    mockExeca.mockClear();
    responseQueue([
      [
        "provider get test-provider",
        [{ exitCode: 0, stdout: matchingInferenceProvider, stderr: "" }],
      ],
      [
        "provider get acme-okta-runtime",
        [
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
        ],
      ],
    ]);
    await expect(actionRollback(plan.run_id)).rejects.toThrow(
      /Cannot roll back.*mutable sandbox and provider names/u,
    );

    const rollbackCommands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(rollbackCommands).not.toContain("sandbox stop -g test-gateway test-sandbox");
    expect(rollbackCommands).not.toContain("sandbox remove -g test-gateway test-sandbox");
    expect(rollbackCommands).not.toContain(
      "sandbox provider detach test-sandbox acme-okta-runtime",
    );
    expect(rollbackCommands).not.toContain("provider delete acme-okta-runtime");
    expect(store.get(`/fakehome/.nemoclaw/state/runs/${plan.run_id}/rolled_back`)).toBeUndefined();
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

  it("creates an explicitly missing inference provider for a receipt-owned sandbox", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      ["sandbox get test-sandbox", [failureResult("sandbox not found")]],
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

    const plan = JSON.parse(
      [...store.entries()].find(([path]) => path.endsWith("/plan.json"))![1].content!,
    );
    expect(plan.native_inference).toMatchObject({
      providerAttachment: { providerName: "test-provider", providerId: "test-native-provider-id" },
      sandboxId: "sandbox-id-1",
    });
    expect(plan.inference_provider_created_by_apply).toBe(true);
  });

  it("refuses name-only rollback before attempting an owned sandbox removal (#9833)", async () => {
    const stateDir = "/fakehome/.nemoclaw/state/runs/failed-sandbox-removal";
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/plan.json`, {
      type: "file",
      content: JSON.stringify({
        sandbox_name: "owned-sandbox",
        sandbox_created_by_apply: true,
      }),
    });
    responseQueue([
      ["sandbox remove -g test-gateway owned-sandbox", [failureResult("remove denied")]],
    ]);

    await expect(actionRollback("failed-sandbox-removal")).rejects.toThrow(
      /mutable sandbox and provider names/u,
    );
    expect(mockExeca).not.toHaveBeenCalled();
    expect(store.get(`${stateDir}/rolled_back`)).toBeUndefined();
  });

  it("refuses name-only rollback before attempting an owned provider deletion (#9833)", async () => {
    const stateDir = "/fakehome/.nemoclaw/state/runs/failed-inference-provider-removal";
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/plan.json`, {
      type: "file",
      content: JSON.stringify({
        sandbox_name: "test-sandbox",
        inference_provider_created_by_apply: true,
        inference: { provider_name: "test-provider", provider_type: "openai" },
      }),
    });
    responseQueue([
      [
        "provider get test-provider",
        [{ exitCode: 0, stdout: matchingInferenceProvider, stderr: "" }],
      ],
      ["provider delete test-provider", [failureResult("provider delete denied")]],
    ]);

    await expect(actionRollback("failed-inference-provider-removal")).rejects.toThrow(
      /mutable sandbox and provider names/u,
    );
    expect(mockExeca).not.toHaveBeenCalled();
    expect(store.get(`${stateDir}/rolled_back`)).toBeUndefined();
  });

  it("preserves rollback resources when the plan has no exact resource identity (#9833)", async () => {
    const stateDir = "/fakehome/.nemoclaw/state/runs/provider-authority-drift";
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/plan.json`, {
      type: "file",
      content: JSON.stringify({
        sandbox_name: "test-sandbox",
        inference_provider_created_by_apply: true,
        inference: { provider_name: "test-provider", provider_type: "openai" },
      }),
    });
    mockExeca.mockImplementation(async (_command: string, args: string[]) =>
      args.join(" ") === "provider get test-provider"
        ? { exitCode: 0, stdout: matchingInferenceProvider, stderr: "" }
        : resultWithBlueprintPolicy(args, success),
    );

    await expect(actionRollback("provider-authority-drift")).rejects.toThrow(
      /mutable sandbox and provider names/u,
    );
    const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(commands).not.toContain("provider delete test-provider");
    expect(commands).not.toContain("sandbox stop -g test-gateway test-sandbox");
    expect(commands).not.toContain("sandbox remove -g test-gateway test-sandbox");
  });

  it("does not stop a sandbox before refusing name-only rollback (#9833)", async () => {
    const stateDir = "/fakehome/.nemoclaw/state/runs/sandbox-authority-drift";
    store.set(stateDir, { type: "dir" });
    store.set(`${stateDir}/plan.json`, {
      type: "file",
      content: JSON.stringify({
        sandbox_name: "test-sandbox",
        sandbox_created_by_apply: true,
      }),
    });
    await expect(actionRollback("sandbox-authority-drift")).rejects.toThrow(
      /mutable sandbox and provider names/u,
    );
    const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(commands).not.toContain("sandbox stop -g test-gateway test-sandbox");
    expect(commands).not.toContain("sandbox remove -g test-gateway test-sandbox");
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

  it("persists an ownership receipt when automatic compensation is unavailable (#9833)", async () => {
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
      ["inference get", [failureResult("inference route not found")]],
      ["sandbox provider attach test-sandbox acme-okta-runtime", [failureResult("route failed")]],
    ]);

    await expect(actionApply("default", blueprint({ identity: oktaIdentity() }))).rejects.toThrow(
      /route failed.*automatic cleanup was refused/u,
    );

    const planEntry = [...store.entries()].find(([path]) => path.endsWith("/plan.json"))?.[1];
    expect(planEntry?.content).toBeDefined();
    const plan = JSON.parse(planEntry!.content!);
    expect(plan.identity).toMatchObject({
      provider_created: true,
      attachment_created: false,
    });

    await expect(actionRollback(plan.run_id)).rejects.toThrow(
      /mutable sandbox and provider names/u,
    );
    expect(store.get(`/fakehome/.nemoclaw/state/runs/${plan.run_id}/rolled_back`)).toBeUndefined();
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
      /rotate failed.*automatic cleanup was refused/su,
    );

    const planEntry = [...store.entries()].find(([path]) => path.endsWith("/plan.json"))?.[1];
    expect(planEntry?.content).toBeDefined();
    const plan = JSON.parse(planEntry!.content!);
    expect(plan.identity).toMatchObject({
      provider_created: true,
      attachment_created: true,
    });

    await expect(actionRollback(plan.run_id)).rejects.toThrow(
      /mutable sandbox and provider names/u,
    );
    expect(store.get(`/fakehome/.nemoclaw/state/runs/${plan.run_id}/rolled_back`)).toBeUndefined();
  });

  it.each([true, false])(
    "records attachment ownership before the advisory profile export when created: %s",
    async (created) => {
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
          "sandbox provider attach test-sandbox acme-okta-runtime",
          [created ? success : failureResult("already attached")],
        ],
      ]);
      const originalRun = mockExeca.getMockImplementation()!;
      let attachmentSeen = false;
      let signalExport!: () => void;
      let releaseExport!: () => void;
      const exportStarted = new Promise<void>((resolve) => {
        signalExport = resolve;
      });
      const exportReleased = new Promise<void>((resolve) => {
        releaseExport = resolve;
      });
      const pauseExport = () => {
        signalExport();
        return exportReleased;
      };
      mockExeca.mockImplementation(async (command: string, args: string[]) => {
        const commandText = args.join(" ");
        attachmentSeen ||= commandText === "sandbox provider attach test-sandbox acme-okta-runtime";
        await (attachmentSeen &&
        commandText === "provider profile export okta-runtime-v1 --output yaml"
          ? pauseExport()
          : Promise.resolve());
        return originalRun(command, args);
      });

      const apply = actionApply("default", blueprint({ identity: oktaIdentity() }));
      try {
        await exportStarted;
        const planEntry = [...store.entries()].find(([path]) => path.endsWith("/plan.json"))?.[1];
        expect(planEntry?.content).toBeDefined();
        expect(JSON.parse(planEntry!.content!).identity.attachment_created).toBe(created);
        expect(
          mockExeca.mock.calls.some(([, args]) =>
            (args as string[]).join(" ").startsWith("provider refresh rotate "),
          ),
        ).toBe(false);
      } finally {
        releaseExport();
      }
      await apply;
    },
  );

  it.each([true, false])(
    "preserves runtime identity when other resources are owned: %s (#9833)",
    async (ownsOtherResources) => {
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
          sandbox_created_by_apply: ownsOtherResources,
          inference_provider_created_by_apply: ownsOtherResources,
          inference: { provider_name: "test-provider", provider_type: "openai" },
          identity: receipt,
        }),
      });
      responseQueue([
        [
          "provider get test-provider",
          [{ exitCode: 0, stdout: matchingInferenceProvider, stderr: "" }],
        ],
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
      expect(statusOutput).toContain(
        `"inference_provider_created_by_apply": ${ownsOtherResources}`,
      );
      stdout.mockRestore();
      const originalPlan = store.get(`${stateDir}/plan.json`);
      await expect(actionRollback("identity-run")).rejects.toThrow(
        /mutable sandbox and provider names/u,
      );

      expect(mockExeca).not.toHaveBeenCalledWith(
        "openshell",
        ["sandbox", "provider", "detach", "test-sandbox", "acme-okta-runtime"],
        expect.anything(),
      );
      expect(mockExeca).not.toHaveBeenCalledWith(
        "openshell",
        ["provider", "delete", "acme-okta-runtime"],
        expect.anything(),
      );
      expect(mockExeca).not.toHaveBeenCalledWith(
        "openshell",
        ["sandbox", "stop", "-g", "test-gateway", "test-sandbox"],
        expect.anything(),
      );
      expect(mockExeca).not.toHaveBeenCalledWith(
        "openshell",
        ["sandbox", "remove", "-g", "test-gateway", "test-sandbox"],
        expect.anything(),
      );
      expect(mockExeca).not.toHaveBeenCalledWith(
        "openshell",
        ["provider", "delete", "test-provider"],
        expect.anything(),
      );
      expect(store.get(`${stateDir}/rolled_back`)).toBeUndefined();
      expect(store.get(`${stateDir}/plan.json`)).toEqual(originalPlan);
    },
  );

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
