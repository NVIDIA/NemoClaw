// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type fs from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

interface FsEntry {
  type: "file" | "dir";
  content?: string;
}

const store = new Map<string, FsEntry>();
const realpaths = new Map<string, string>();
const mockExeca = vi.fn();
const missingEntry = (path: string): never => {
  throw new Error(`ENOENT: ${path}`);
};

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => "/fakehome" };
});
vi.mock("node:crypto", () => ({ randomUUID: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return {
    ...original,
    mkdirSync: vi.fn((path: string) => store.set(path, { type: "dir" })),
    readFileSync: (path: string) => {
      const entry = store.get(path);
      return entry?.type === "file" ? (entry.content ?? "") : missingEntry(path);
    },
    writeFileSync: vi.fn((path: string, content: string) =>
      store.set(path, { type: "file", content }),
    ),
    readdirSync: (path: string) => {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const entries = [...store.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length).split("/")[0]);
      return entries.length > 0 || store.has(path) ? [...new Set(entries)] : missingEntry(path);
    },
    realpathSync: (path: string) => {
      const resolved = resolve(path);
      return realpaths.get(resolved) ?? (store.has(resolved) ? resolved : missingEntry(resolved));
    },
    statSync: (path: string) => ({
      isFile: () => store.get(resolve(path))?.type === "file",
    }),
  };
});
vi.mock("execa", () => ({ execa: (...args: unknown[]) => mockExeca(...args) }));
vi.mock("./ssrf.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ssrf.js")>();
  return {
    ...actual,
    validateEndpointUrl: vi.fn(async (url: string) => ({
      url,
      pinnedUrl: url,
      protocol: "https:",
      hostname: new URL(url).hostname,
      dnsResolved: false,
    })),
  };
});

const { actionApply, actionPlan, actionRollback, actionStatus, loadBlueprint } = await import(
  "./runner.js"
);

const matchingProvider = [
  "Name: acme-okta-runtime",
  "Type: okta-runtime-v1",
  "Credential keys: OKTA_ACCESS_TOKEN",
  "Config keys: <none>",
  "",
].join("\n");

const matchingInferenceProvider = [
  "Name: test-provider",
  "Type: openai",
  "Credential keys: <none>",
  "Config keys: OPENAI_BASE_URL",
  "",
].join("\n");

const matchingInferenceRoute = [
  "Gateway inference:",
  "",
  "  Provider: test-provider",
  "  Model: test-model",
  "  Version: 1",
  "  Timeout: 180s",
  "",
].join("\n");

const success = { exitCode: 0, stdout: "", stderr: "" };
const providersV2Enabled = {
  exitCode: 0,
  stdout: JSON.stringify({
    scope: "global",
    settings_revision: 1,
    settings: { providers_v2_enabled: "true" },
  }),
  stderr: "",
};

function responseQueue(
  overrides: Array<[string, Array<{ exitCode?: number; stdout: string; stderr: string }>]>,
) {
  const responses = new Map([
    ["sandbox get test-sandbox", [{ exitCode: 1, stdout: "", stderr: "sandbox not found" }]],
    ["provider get test-provider", [{ exitCode: 1, stdout: "", stderr: "provider not found" }]],
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
    return responses.get(command)?.shift() ?? fallbacks.get(command) ?? success;
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
      args.join(" ") === "settings get --global --json" ? providersV2Enabled : success,
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
          { exitCode: 1, stdout: "", stderr: "provider not found" },
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
  });

  it("fails closed when an identity subprocess has no exit code", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      ["provider get acme-okta-runtime", [{ exitCode: 1, stdout: "", stderr: "not found" }]],
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
      [
        "sandbox get test-sandbox",
        [{ exitCode: 1, stdout: "", stderr: "gateway configuration not found" }],
      ],
    ]);

    await expect(actionApply("default", blueprint({ identity: oktaIdentity() }))).rejects.toThrow(
      /Failed to inspect sandbox 'test-sandbox'.*gateway configuration not found/,
    );

    const commandLines = mockExeca.mock.calls.map(([command, args]) =>
      [command, ...(args ?? [])].join(" "),
    );
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

    const commandLines = mockExeca.mock.calls.map(([command, args]) =>
      [command, ...(args ?? [])].join(" "),
    );
    expect(commandLines).toEqual(["openshell sandbox get test-sandbox"]);
  });

  it.each([
    [
      "cannot be inspected",
      { exitCode: 1, stdout: "", stderr: "gateway route unavailable" },
      /Failed to inspect sandbox 'test-sandbox' after concurrent creation.*gateway route unavailable/,
    ],
    [
      "is not Ready",
      { exitCode: 0, stdout: "Name: test-sandbox\nPhase: Provisioning", stderr: "" },
      /Sandbox 'test-sandbox' is not reusable.*Ready phase.*Provisioning/,
    ],
  ])("fails closed when a concurrently created sandbox %s", async (_label, racedSandbox, expectedError) => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      [
        "sandbox get test-sandbox",
        [{ exitCode: 1, stdout: "", stderr: "sandbox not found" }, racedSandbox],
      ],
      [
        "provider get acme-okta-runtime",
        [
          { exitCode: 1, stdout: "", stderr: "provider not found" },
          ...Array.from({ length: 4 }, () => ({
            exitCode: 0,
            stdout: matchingProvider,
            stderr: "",
          })),
        ],
      ],
      [
        "sandbox create --from openclaw --name test-sandbox --forward 18789",
        [{ exitCode: 1, stdout: "", stderr: "sandbox already exists" }],
      ],
    ]);

    await expect(actionApply("default", blueprint({ identity: oktaIdentity() }))).rejects.toThrow(
      expectedError,
    );

    const commands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(commands.filter((command) => command === "sandbox get test-sandbox")).toHaveLength(2);
    expect(commands).not.toContain("sandbox provider attach test-sandbox acme-okta-runtime");
    expect(commands).toContain("provider delete acme-okta-runtime");
  });

  it("fails before identity mutation when a reused sandbox's inference provider cannot be inspected", async () => {
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
        [{ exitCode: 1, stdout: "", stderr: "gateway configuration not found" }],
      ],
    ]);

    await expect(actionApply("default", blueprint({ identity: oktaIdentity() }))).rejects.toThrow(
      /Failed to inspect inference provider 'test-provider'.*gateway configuration not found/,
    );

    const commandLines = mockExeca.mock.calls.map(([command, args]) =>
      [command, ...(args ?? [])].join(" "),
    );
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

    const commandLines = mockExeca.mock.calls.map(([command, args]) =>
      [command, ...(args ?? [])].join(" "),
    );
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
      [
        "inference get",
        [{ exitCode: 1, stdout: "", stderr: "gateway route inspection unavailable" }],
      ],
    ]);

    await expect(actionApply("default", blueprint({ identity: oktaIdentity() }))).rejects.toThrow(
      /Failed to inspect the active inference route.*gateway route inspection unavailable/,
    );

    const commandLines = mockExeca.mock.calls.map(([command, args]) =>
      [command, ...(args ?? [])].join(" "),
    );
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
          { exitCode: 1, stdout: "", stderr: "provider not found" },
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
          { exitCode: 1, stdout: "", stderr: "provider not found" },
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
          { exitCode: 1, stdout: "", stderr: "provider not found" },
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
          { exitCode: 1, stdout: "", stderr: "provider not found" },
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
          { exitCode: 1, stdout: "", stderr: "provider not found" },
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
        ],
      ],
      [
        "provider create --name test-provider --type openai --config OPENAI_BASE_URL=https://api.example.com/v1",
        [{ exitCode: 1, stdout: "", stderr: "provider already exists" }],
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
          { exitCode: 1, stdout: "", stderr: "provider not found" },
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
        ],
      ],
      [
        "inference set --provider test-provider --model test-model",
        [{ exitCode: 1, stdout: "", stderr: "route failed" }],
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
          { exitCode: 1, stdout: "", stderr: "provider not found" },
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
          { exitCode: 0, stdout: matchingProvider, stderr: "" },
        ],
      ],
      [
        "policy get --base test-sandbox",
        [{ exitCode: 1, stdout: "", stderr: "policy read rejected" }],
      ],
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
        [{ exitCode: 1, stdout: "", stderr: "route failed" }],
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
          { exitCode: 1, stdout: "", stderr: "provider not found" },
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
      content: JSON.stringify({ sandbox_name: "pre-existing-sandbox" }),
    });

    await actionRollback("legacy-run");

    const rollbackCommands = mockExeca.mock.calls.map(([, args]) => (args ?? []).join(" "));
    expect(rollbackCommands).not.toContain("sandbox stop pre-existing-sandbox");
    expect(rollbackCommands).not.toContain("sandbox remove pre-existing-sandbox");
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
      ["provider get test-provider", [{ exitCode: 1, stdout: "", stderr: "provider not found" }]],
      [
        "provider get acme-okta-runtime",
        [
          { exitCode: 1, stdout: "", stderr: "provider not found" },
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
    responseQueue([
      ["sandbox remove owned-sandbox", [{ exitCode: 1, stdout: "", stderr: "remove denied" }]],
    ]);

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
    responseQueue([
      [
        "provider delete test-provider",
        [{ exitCode: 1, stdout: "", stderr: "provider delete denied" }],
      ],
    ]);

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
          { exitCode: 1, stdout: "", stderr: "provider not found" },
          ...Array.from({ length: 5 }, () => ({
            exitCode: 0,
            stdout: matchingProvider,
            stderr: "",
          })),
        ],
      ],
      [
        "provider delete acme-okta-runtime",
        [
          { exitCode: 1, stdout: "", stderr: "delete denied" },
          { exitCode: 0, stdout: "", stderr: "" },
        ],
      ],
      [
        "inference set --provider test-provider --model test-model",
        [{ exitCode: 1, stdout: "", stderr: "route failed" }],
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

  it("persists provider ownership before refresh so preparation cleanup is recoverable", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";
    responseQueue([
      [
        "provider get acme-okta-runtime",
        [
          { exitCode: 1, stdout: "", stderr: "provider not found" },
          ...Array.from({ length: 3 }, () => ({
            exitCode: 0,
            stdout: matchingProvider,
            stderr: "",
          })),
        ],
      ],
      [
        "provider refresh rotate acme-okta-runtime --credential-key OKTA_ACCESS_TOKEN",
        [{ exitCode: 1, stdout: "", stderr: "rotate failed" }],
      ],
      [
        "provider delete acme-okta-runtime",
        [
          { exitCode: 1, stdout: "", stderr: "first delete denied" },
          { exitCode: 1, stdout: "", stderr: "second delete denied" },
          { exitCode: 0, stdout: "", stderr: "" },
        ],
      ],
    ]);

    await expect(actionApply("default", blueprint({ identity: oktaIdentity() }))).rejects.toThrow(
      /rotate failed.*cleanup failed:.*first delete denied.*cleanup failed:.*second delete denied/s,
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
