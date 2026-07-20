// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

interface FsEntry {
  type: "file" | "dir";
  content?: string;
}

const store = new Map<string, FsEntry>();
const mockExeca = vi.fn();

vi.mock("node:os", () => ({ homedir: () => "/fakehome" }));
vi.mock("node:crypto", () => ({ randomUUID: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return {
    ...original,
    mkdirSync: vi.fn((path: string) => store.set(path, { type: "dir" })),
    readFileSync: (path: string) => {
      const entry = store.get(path);
      if (entry?.type !== "file") throw new Error(`ENOENT: ${path}`);
      return entry.content ?? "";
    },
    writeFileSync: vi.fn((path: string, content: string) =>
      store.set(path, { type: "file", content }),
    ),
    readdirSync: (path: string) => {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const entries = [...store.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length).split("/")[0]);
      if (entries.length === 0 && !store.has(path)) throw new Error(`ENOENT: ${path}`);
      return [...new Set(entries)];
    },
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

const { actionApply, loadBlueprint } = await import("./runner.js");

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

function entraIdentity(profilePath = "provider-profiles/entra-graph-runtime-v1.yaml") {
  return {
    profile_path: profilePath,
    provider_type: "entra-graph-runtime-v1",
    provider_name: "acme-entra-runtime",
    credential_key: "MS_GRAPH_ACCESS_TOKEN",
    client_id_env: "ENTRA_CLIENT_ID",
    refresh_token_env: "ENTRA_REFRESH_TOKEN",
    client_secret_env: "ENTRA_CLIENT_SECRET",
  };
}

describe("blueprint identity wrapper", () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    delete process.env.NEMOCLAW_BLUEPRINT_PATH;
  });

  afterEach(() => {
    delete process.env.OKTA_CLIENT_ID;
    delete process.env.OKTA_REFRESH_TOKEN;
    delete process.env.OKTA_CLIENT_SECRET;
    delete process.env.ENTRA_CLIENT_ID;
    delete process.env.ENTRA_REFRESH_TOKEN;
    delete process.env.ENTRA_CLIENT_SECRET;
    vi.restoreAllMocks();
  });

  it("accepts an opt-in Okta identity and fail-closed middleware configuration", () => {
    const input = blueprint({
      identity: { okta: oktaIdentity() },
      policy: {
        middlewares: {
          identity_guard: {
            middleware: "acme/identity-guard",
            order: 10,
            on_error: "fail_closed",
            endpoints: { include: ["api.example.okta.com"] },
          },
        },
      },
    });
    store.set("blueprint.yaml", { type: "file", content: YAML.stringify(input) });

    expect(loadBlueprint()).toEqual(input);
  });

  it("rejects profile paths that escape the blueprint directory", async () => {
    await expect(
      actionApply("default", blueprint({ identity: { okta: oktaIdentity("../outside.yaml") } })),
    ).rejects.toThrow(/profile_path must stay inside/i);
  });

  it("configures refresh from scoped environment material and attaches the runtime provider", async () => {
    process.env.OKTA_CLIENT_ID = "client-id";
    process.env.OKTA_REFRESH_TOKEN = "refresh-secret";
    process.env.OKTA_CLIENT_SECRET = "client-secret";

    await actionApply("default", blueprint({ identity: { okta: oktaIdentity() } }));

    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      ["provider", "profile", "import", "--file", "provider-profiles/okta-runtime-v1.yaml"],
      expect.objectContaining({ reject: false }),
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
      expect.objectContaining({ reject: false }),
    );
    const refreshCall = mockExeca.mock.calls.find(
      (call) => Array.isArray(call[1]) && call[1][0] === "provider" && call[1][2] === "configure",
    );
    if (!refreshCall) throw new Error("Okta refresh configure call not found");
    expect(refreshCall[1]).toContain("client_id=client-id");
    expect(refreshCall[1]).not.toContain("refresh-secret");
    expect(refreshCall[1]).not.toContain("client-secret");
    expect(refreshCall[2].env.OKTA_REFRESH_TOKEN).toBe("refresh-secret");
    expect(refreshCall[2].env.OKTA_CLIENT_SECRET).toBe("client-secret");
    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "provider", "attach", "test-sandbox", "acme-okta-runtime"],
      expect.objectContaining({ reject: false }),
    );
  });

  it("configures and attaches the Microsoft Entra reference without an Azure runtime dependency", async () => {
    process.env.ENTRA_CLIENT_ID = "entra-client-id";
    process.env.ENTRA_REFRESH_TOKEN = "entra-refresh-secret";
    process.env.ENTRA_CLIENT_SECRET = "entra-client-secret";

    await actionApply("default", blueprint({ identity: { entra: entraIdentity() } }));

    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      ["provider", "profile", "import", "--file", "provider-profiles/entra-graph-runtime-v1.yaml"],
      expect.objectContaining({ reject: false }),
    );
    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      [
        "provider",
        "create",
        "--name",
        "acme-entra-runtime",
        "--type",
        "entra-graph-runtime-v1",
        "--runtime-credentials",
      ],
      expect.objectContaining({ reject: false }),
    );
    const refreshCall = mockExeca.mock.calls.find(
      (call) => Array.isArray(call[1]) && call[1][0] === "provider" && call[1][2] === "configure",
    );
    if (!refreshCall) throw new Error("Entra refresh configure call not found");
    expect(refreshCall[1]).toContain("client_id=entra-client-id");
    expect(refreshCall[1]).not.toContain("entra-refresh-secret");
    expect(refreshCall[1]).not.toContain("entra-client-secret");
    expect(refreshCall[2].env.ENTRA_REFRESH_TOKEN).toBe("entra-refresh-secret");
    expect(refreshCall[2].env.ENTRA_CLIENT_SECRET).toBe("entra-client-secret");
    expect(mockExeca).toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "provider", "attach", "test-sandbox", "acme-entra-runtime"],
      expect.objectContaining({ reject: false }),
    );
  });

  it("rejects multiple runtime identity references in one blueprint run", () => {
    const input = blueprint({ identity: { okta: oktaIdentity(), entra: entraIdentity() } });
    store.set("blueprint.yaml", { type: "file", content: YAML.stringify(input) });

    expect(() => loadBlueprint()).toThrow(/valid nested component shapes/i);
  });

  it("composes fail-closed middleware while retaining existing middleware", async () => {
    mockExeca.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === "policy" && args[1] === "get") {
        return {
          exitCode: 0,
          stdout: [
            "Version: 1",
            "Hash: sha256:test",
            "---",
            "version: 1",
            "network_policies: {}",
            "network_middlewares:",
            "  existing:",
            "    middleware: openshell/regex",
            "    endpoints:",
            "      include: [api.example.com]",
            "",
          ].join("\n"),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await actionApply(
      "default",
      blueprint({
        policy: {
          middlewares: {
            identity_guard: {
              middleware: "acme/identity-guard",
              order: 10,
              on_error: "fail_closed",
              endpoints: { include: ["api.example.okta.com"] },
            },
          },
        },
      }),
    );

    const merged = [...store.entries()].find(([path]) => path.endsWith("/merged-policy.yaml"))?.[1]
      .content;
    if (!merged) throw new Error("merged policy file not written");
    expect(YAML.parse(merged).network_middlewares).toMatchObject({
      existing: { middleware: "openshell/regex" },
      identity_guard: {
        middleware: "acme/identity-guard",
        order: 10,
        on_error: "fail_closed",
      },
    });
  });
});
