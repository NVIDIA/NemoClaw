// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type fs from "node:fs";
import YAML from "yaml";

// ── In-memory filesystem ────────────────────────────────────────

interface FsEntry {
  type: "file" | "dir";
  content?: string;
}

const store = new Map<string, FsEntry>();

function addFile(p: string, content: string): void {
  store.set(p, { type: "file", content });
}

function addDir(p: string): void {
  store.set(p, { type: "dir" });
}

const FAKE_HOME = "/fakehome";

vi.mock("node:os", () => ({
  homedir: () => FAKE_HOME,
}));

vi.mock("node:crypto", () => ({
  randomUUID: () => "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return {
    ...original,
    existsSync: (p: string) => store.has(p),
    mkdirSync: vi.fn((p: string) => {
      addDir(p);
    }),
    readFileSync: (p: string) => {
      const entry = store.get(p);
      if (entry?.type !== "file") throw new Error(`ENOENT: ${p}`);
      return entry.content ?? "";
    },
    writeFileSync: vi.fn((p: string, data: string) => {
      store.set(p, { type: "file", content: data });
    }),
    readdirSync: (p: string) => {
      const prefix = p.endsWith("/") ? p : p + "/";
      const entries = new Set<string>();
      for (const k of store.keys()) {
        if (k.startsWith(prefix)) {
          const rest = k.slice(prefix.length);
          const first = rest.split("/")[0];
          if (first) entries.add(first);
        }
      }
      if (entries.size === 0 && !store.has(p)) {
        throw new Error(`ENOENT: ${p}`);
      }
      return [...entries].sort();
    },
  };
});

const mockExeca = vi.fn();
vi.mock("execa", () => ({
  execa: (...args: unknown[]) => mockExeca(...args),
}));

vi.mock("./ssrf.js", () => ({
  validateEndpointUrl: vi.fn(async (url: string) => ({ url, pinnedUrl: url })),
}));

const { validateEndpointUrl } = await import("./ssrf.js");
const mockedValidateEndpoint = vi.mocked(validateEndpointUrl);

const { emitRunId, loadBlueprint, actionPlan, actionApply, actionStatus, actionRollback, main } =
  await import("./runner.js");

// ── Helpers ─────────────────────────────────────────────────────

const stdoutChunks: string[] = [];

function captureStdout(): void {
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdoutChunks.push(String(chunk));
    return true;
  });
}

function stdoutText(): string {
  return stdoutChunks.join("");
}

function minimalBlueprint(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    version: "1.0",
    components: {
      inference: {
        profiles: {
          default: {
            provider_type: "openai",
            provider_name: "my-provider",
            endpoint: "https://api.example.com/v1",
            model: "gpt-4",
            credential_env: "MY_API_KEY",
          },
        },
      },
      sandbox: {
        image: "openclaw",
        name: "test-sandbox",
        forward_ports: [18789],
      },
      policy: { additions: {} },
    },
    ...overrides,
  };
}

function routedBlueprint(): Record<string, unknown> {
  return {
    version: "1.0",
    components: {
      inference: {
        profiles: {
          routed: {
            provider_type: "openai",
            provider_name: "nvidia-router",
            endpoint: "http://localhost:4000/v1",
            model: "routed",
            credential_env: "NVIDIA_API_KEY",
            credential_default: "router-local",
            timeout_secs: 180,
          },
        },
      },
      sandbox: {
        image: "openclaw",
        name: "test-sandbox",
        forward_ports: [18789],
      },
      router: {
        enabled: true,
        port: 4000,
        pool_config_path: "router/pool-config.yaml",
      },
      policy: { additions: {} },
    },
  };
}

function seedBlueprintFile(bp?: Record<string, unknown>): void {
  addFile("blueprint.yaml", YAML.stringify(bp ?? minimalBlueprint()));
}

function blueprintWithPolicyAdditions(additions: Record<string, unknown>): Record<string, unknown> {
  const bp = minimalBlueprint();
  const components = bp.components as Record<string, unknown>;
  return {
    ...bp,
    components: {
      ...components,
      policy: { additions },
    },
  };
}

function mockCurrentPolicy(stdout: string): void {
  mockExeca.mockImplementation(async (_cmd: string, args: string[]) => {
    if (
      args[0] === "policy" &&
      args[1] === "get" &&
      args[2] === "--full" &&
      args[3] === "test-sandbox"
    ) {
      return { exitCode: 0, stdout, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  });
}

// ── Tests ───────────────────────────────────────────────────────

describe("runner", () => {
  beforeEach(() => {
    store.clear();
    stdoutChunks.length = 0;
    vi.clearAllMocks();
    delete process.env.NEMOCLAW_BLUEPRINT_PATH;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("emitRunId", () => {
    it("returns an ID matching nc-YYYYMMDD-HHMMSS-<hex8> pattern", () => {
      captureStdout();
      const rid = emitRunId();
      expect(rid).toMatch(/^nc-\d{8}-\d{6}-[a-f0-9]{8}$/);
    });

    it("writes RUN_ID line to stdout", () => {
      captureStdout();
      const rid = emitRunId();
      expect(stdoutText()).toContain(`RUN_ID:${rid}`);
    });
  });

  describe("loadBlueprint", () => {
    it("throws when blueprint.yaml is missing", () => {
      expect(() => loadBlueprint()).toThrow(/blueprint\.yaml not found/);
    });

    it("parses blueprint.yaml from current directory", () => {
      addFile("blueprint.yaml", YAML.stringify({ version: "2.0" }));
      expect(loadBlueprint()).toEqual({ version: "2.0" });
    });

    it("parses schema-valid policy additions", () => {
      addFile(
        "blueprint.yaml",
        YAML.stringify({
          version: "2.0",
          components: {
            policy: {
              additions: {
                internal_api: {
                  name: "internal_api",
                  endpoints: [
                    {
                      host: "api.internal.example.com",
                      port: 443,
                      access: "full",
                    },
                  ],
                },
              },
            },
          },
        }),
      );
      expect(loadBlueprint()).toEqual({
        version: "2.0",
        components: {
          policy: {
            additions: {
              internal_api: {
                name: "internal_api",
                endpoints: [
                  {
                    host: "api.internal.example.com",
                    port: 443,
                    access: "full",
                  },
                ],
              },
            },
          },
        },
      });
    });

    it("rejects policy additions that do not match the policy schema", () => {
      addFile(
        "blueprint.yaml",
        YAML.stringify({
          version: "2.0",
          components: {
            policy: {
              additions: {
                extra: {
                  mode: "allow",
                  endpoints: ["https://api.example.com"],
                },
              },
            },
          },
        }),
      );
      expect(() => loadBlueprint()).toThrow(/valid nested component shapes/);
    });

    it("parses REST policy additions with explicit allow rules", () => {
      const bp = blueprintWithPolicyAdditions({
        internal_api: {
          name: "internal_api",
          endpoints: [
            {
              host: "api.internal.example.com",
              port: 443,
              protocol: "rest",
              enforcement: "enforce",
              tls: "terminate",
              rules: [
                { allow: { method: "GET", path: "/health" } },
                { allow: { method: "POST", path: "/v1/chat/completions" } },
              ],
            },
          ],
        },
      });
      addFile("blueprint.yaml", YAML.stringify(bp));

      expect(loadBlueprint()).toEqual(bp);
    });

    it.each([
      ["missing host", { port: 443, access: "full" }],
      ["invalid port", { host: "api.internal.example.com", port: 0, access: "full" }],
      ["unknown protocol", { host: "api.internal.example.com", port: 443, protocol: "grpc" }],
      ["REST without rules", { host: "api.internal.example.com", port: 443, protocol: "rest" }],
      [
        "empty REST rules",
        { host: "api.internal.example.com", port: 443, protocol: "rest", rules: [] },
      ],
      [
        "invalid rule method",
        {
          host: "api.internal.example.com",
          port: 443,
          protocol: "rest",
          rules: [{ allow: { method: "TRACE", path: "/" } }],
        },
      ],
      [
        "invalid rule path",
        {
          host: "api.internal.example.com",
          port: 443,
          protocol: "rest",
          rules: [{ allow: { method: "GET", path: "relative" } }],
        },
      ],
      [
        "invalid enforcement",
        { host: "api.internal.example.com", port: 443, enforcement: "block" },
      ],
      ["invalid TLS mode", { host: "api.internal.example.com", port: 443, tls: "off" }],
      ["invalid access mode", { host: "api.internal.example.com", port: 443, access: "read" }],
      ["unknown endpoint field", { host: "api.internal.example.com", port: 443, extra: true }],
    ])("rejects policy additions with %s", (_name, endpoint) => {
      addFile(
        "blueprint.yaml",
        YAML.stringify(
          blueprintWithPolicyAdditions({
            internal_api: {
              name: "internal_api",
              endpoints: [endpoint],
            },
          }),
        ),
      );

      expect(() => loadBlueprint()).toThrow(/valid nested component shapes/);
    });

    it("respects NEMOCLAW_BLUEPRINT_PATH env var", () => {
      process.env.NEMOCLAW_BLUEPRINT_PATH = "/custom/path";
      addFile("/custom/path/blueprint.yaml", YAML.stringify({ version: "3.0" }));
      expect(loadBlueprint()).toEqual({ version: "3.0" });
    });

    it("rejects a YAML sequence at the root", () => {
      addFile("blueprint.yaml", YAML.stringify(["not", "a", "mapping"]));
      expect(() => loadBlueprint()).toThrow(/valid nested component shapes/);
    });

    it("rejects a non-string version", () => {
      addFile("blueprint.yaml", YAML.stringify({ version: 2 }));
      expect(() => loadBlueprint()).toThrow(/valid nested component shapes/);
    });

    it("rejects a non-object components block", () => {
      addFile("blueprint.yaml", YAML.stringify({ components: [] }));
      expect(() => loadBlueprint()).toThrow(/valid nested component shapes/);
    });

    it("rejects a non-object inference block", () => {
      addFile(
        "blueprint.yaml",
        YAML.stringify({
          components: {
            inference: [],
          },
        }),
      );
      expect(() => loadBlueprint()).toThrow(/valid nested component shapes/);
    });

    it("rejects nested component shapes that do not match the blueprint schema", () => {
      addFile(
        "blueprint.yaml",
        YAML.stringify({
          version: "2.0",
          components: {
            inference: { profiles: 1 },
          },
        }),
      );
      expect(() => loadBlueprint()).toThrow(/valid nested component shapes/);
    });

    it("rejects invalid inference profile field types", () => {
      addFile(
        "blueprint.yaml",
        YAML.stringify({
          version: "2.0",
          components: {
            inference: {
              profiles: {
                default: {
                  timeout_secs: Number.POSITIVE_INFINITY,
                },
              },
            },
          },
        }),
      );
      expect(() => loadBlueprint()).toThrow(/valid nested component shapes/);
    });

    it("rejects invalid sandbox forward ports", () => {
      addFile(
        "blueprint.yaml",
        YAML.stringify({
          version: "2.0",
          components: {
            sandbox: {
              forward_ports: [70000],
            },
          },
        }),
      );
      expect(() => loadBlueprint()).toThrow(/valid nested component shapes/);
    });

    it("rejects non-plain policy additions values", () => {
      addFile(
        "blueprint.yaml",
        [
          'version: "2.0"',
          "components:",
          "  policy:",
          "    additions:",
          "      extra: !!set",
          "        ? /tmp",
        ].join("\n"),
      );
      expect(() => loadBlueprint()).toThrow(/valid nested component shapes/);
    });
  });

  describe("actionPlan", () => {
    it("throws when profile is not found", async () => {
      captureStdout();
      const bp = minimalBlueprint();
      await expect(actionPlan("nonexistent", bp)).rejects.toThrow(/not found.*Available: default/);
    });

    it("throws when openshell is not available", async () => {
      captureStdout();
      mockExeca.mockResolvedValue({ exitCode: 1 });
      await expect(actionPlan("default", minimalBlueprint())).rejects.toThrow(
        /openshell CLI not found/,
      );
    });

    it("returns a valid plan when openshell is available", async () => {
      captureStdout();
      mockExeca.mockResolvedValue({ exitCode: 0 });

      const plan = await actionPlan("default", minimalBlueprint());

      expect(plan.profile).toBe("default");
      expect(plan.sandbox.name).toBe("test-sandbox");
      expect(plan.sandbox.image).toBe("openclaw");
      expect(plan.sandbox.forward_ports).toEqual([18789]);
      expect(plan.inference.model).toBe("gpt-4");
      expect(plan.inference.endpoint).toBe("https://api.example.com/v1");
      expect(plan.dry_run).toBe(false);
    });

    it("passes dryRun through to the plan", async () => {
      captureStdout();
      mockExeca.mockResolvedValue({ exitCode: 0 });

      const plan = await actionPlan("default", minimalBlueprint(), { dryRun: true });
      expect(plan.dry_run).toBe(true);
    });

    it("validates and applies endpoint URL override", async () => {
      captureStdout();
      mockExeca.mockResolvedValue({ exitCode: 0 });

      const plan = await actionPlan("default", minimalBlueprint(), {
        endpointUrl: "https://override.example.com/v1",
      });
      expect(plan.inference.endpoint).toBe("https://override.example.com/v1");
      expect(mockedValidateEndpoint).toHaveBeenCalledWith("https://override.example.com/v1");
    });

    it("SSRF-validates the blueprint-defined endpoint even without --endpoint-url override", async () => {
      captureStdout();
      mockExeca.mockResolvedValue({ exitCode: 0 });
      mockedValidateEndpoint.mockRejectedValueOnce(new Error("SSRF blocked: private IP"));

      const bp = minimalBlueprint({
        components: {
          inference: {
            profiles: {
              malicious: {
                provider_type: "openai",
                endpoint: "http://169.254.169.254/latest/meta-data",
                model: "gpt-4",
                credential_env: "KEY",
              },
            },
          },
          sandbox: { name: "sb" },
        },
      });

      await expect(actionPlan("malicious", bp)).rejects.toThrow("SSRF blocked: private IP");
      expect(mockedValidateEndpoint).toHaveBeenCalledWith(
        "http://169.254.169.254/latest/meta-data",
      );
    });

    it("emits progress and RUN_ID lines", async () => {
      captureStdout();
      mockExeca.mockResolvedValue({ exitCode: 0 });

      await actionPlan("default", minimalBlueprint());
      const out = stdoutText();
      expect(out).toContain("RUN_ID:");
      expect(out).toContain("PROGRESS:10:Validating blueprint");
      expect(out).toContain("PROGRESS:100:Plan complete");
    });

    it("includes router info when router is enabled", async () => {
      captureStdout();
      mockExeca.mockResolvedValue({ exitCode: 0 });

      const plan = await actionPlan("routed", routedBlueprint());
      expect(plan.router.enabled).toBe(true);
      expect(plan.router.port).toBe(4000);
      expect(plan.router.pool_config_path).toBe("router/pool-config.yaml");
    });

    it("defaults router to disabled when not in blueprint", async () => {
      captureStdout();
      mockExeca.mockResolvedValue({ exitCode: 0 });

      const plan = await actionPlan("default", minimalBlueprint());
      expect(plan.router.enabled).toBe(false);
      expect(plan.router.port).toBe(4000);
    });
  });

  describe("actionApply", () => {
    beforeEach(() => {
      captureStdout();
      // Default: all subprocess calls succeed
      mockExeca.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    });

    it("creates sandbox with correct arguments", async () => {
      await actionApply("default", minimalBlueprint());

      expect(mockExeca).toHaveBeenCalledWith(
        "openshell",
        ["sandbox", "create", "--from", "openclaw", "--name", "test-sandbox", "--forward", "18789"],
        expect.objectContaining({ reject: false }),
      );
    });

    it("applies blueprint policy additions by merging into the live policy", async () => {
      const bp = minimalBlueprint({
        components: {
          inference: {
            profiles: {
              default: {
                provider_type: "openai",
                provider_name: "my-provider",
                endpoint: "https://api.example.com/v1",
                model: "gpt-4",
                credential_env: "MY_API_KEY",
              },
            },
          },
          sandbox: {
            image: "openclaw",
            name: "test-sandbox",
            forward_ports: [18789],
          },
          policy: {
            additions: {
              nim_service: {
                name: "nim_service",
                endpoints: [
                  {
                    host: "integrate.api.nvidia.com",
                    port: 443,
                    access: "full",
                  },
                ],
              },
            },
          },
        },
      });

      mockExeca.mockImplementation(async (_cmd: string, args: string[]) => {
        if (
          args[0] === "policy" &&
          args[1] === "get" &&
          args[2] === "--full" &&
          args[3] === "test-sandbox"
        ) {
          return {
            exitCode: 0,
            stdout: [
              "Version: 1",
              "Hash: sha256:test",
              "---",
              "version: 1",
              "network_policies:",
              "  existing_service:",
              "    mode: allow",
              "    endpoints:",
              "      - https://api.example.com",
              "",
            ].join("\n"),
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });

      await actionApply("default", bp);

      expect(mockExeca).toHaveBeenCalledWith(
        "openshell",
        [
          "policy",
          "set",
          "--policy",
          expect.stringContaining("merged-policy.yaml"),
          "--wait",
          "test-sandbox",
        ],
        expect.objectContaining({ reject: false }),
      );

      const mergedPolicyKey = [...store.keys()].find(
        (k) => k.endsWith("/merged-policy.yaml") || k.endsWith("\\merged-policy.yaml"),
      );
      if (!mergedPolicyKey) throw new Error("merged policy file not written");
      const mergedEntry = store.get(mergedPolicyKey);
      if (!mergedEntry?.content) throw new Error("merged policy file is empty");
      const merged = YAML.parse(mergedEntry.content) as {
        network_policies?: Record<string, unknown>;
      };
      expect(merged.network_policies).toHaveProperty("existing_service");
      expect(merged.network_policies).toHaveProperty("nim_service");
    });

    it("fails closed when the live policy cannot be parsed", async () => {
      const bp = blueprintWithPolicyAdditions({
        nim_service: {
          name: "nim_service",
          endpoints: [
            {
              host: "integrate.api.nvidia.com",
              port: 443,
              access: "full",
            },
          ],
        },
      });

      mockCurrentPolicy(
        ["Version: 1", "Hash: sha256:test", "---", "network_policies: ["].join("\n"),
      );

      await expect(actionApply("default", bp)).rejects.toThrow(/current policy.*not valid YAML/i);
      const policySetCalls = mockExeca.mock.calls.filter(
        (c) => Array.isArray(c[1]) && c[1][0] === "policy" && c[1][1] === "set",
      );
      expect(policySetCalls).toEqual([]);
    });

    it("fails closed when live network_policies is not a mapping", async () => {
      const bp = blueprintWithPolicyAdditions({
        nim_service: {
          name: "nim_service",
          endpoints: [{ host: "integrate.api.nvidia.com", port: 443, access: "full" }],
        },
      });
      mockCurrentPolicy(
        ["Version: 1", "Hash: sha256:test", "---", "network_policies: []"].join("\n"),
      );

      await expect(actionApply("default", bp)).rejects.toThrow(
        /network_policies must be a YAML mapping/i,
      );
      const policySetCalls = mockExeca.mock.calls.filter(
        (c) => Array.isArray(c[1]) && c[1][0] === "policy" && c[1][1] === "set",
      );
      expect(policySetCalls).toEqual([]);
    });

    it("fails closed when policy get --full does not include a policy document", async () => {
      const bp = blueprintWithPolicyAdditions({
        nim_service: {
          name: "nim_service",
          endpoints: [{ host: "integrate.api.nvidia.com", port: 443, access: "full" }],
        },
      });
      mockCurrentPolicy(["Version: 1", "Hash: sha256:test"].join("\n"));

      await expect(actionApply("default", bp)).rejects.toThrow(
        /does not contain a policy YAML document/i,
      );
      const policySetCalls = mockExeca.mock.calls.filter(
        (c) => Array.isArray(c[1]) && c[1][0] === "policy" && c[1][1] === "set",
      );
      expect(policySetCalls).toEqual([]);
    });

    it("can merge policy additions into an empty policy document", async () => {
      const bp = blueprintWithPolicyAdditions({
        nim_service: {
          name: "nim_service",
          endpoints: [{ host: "integrate.api.nvidia.com", port: 443, access: "full" }],
        },
      });
      mockCurrentPolicy(["Version: 1", "Hash: sha256:test", "---"].join("\n"));

      await actionApply("default", bp);

      const mergedPolicyKey = [...store.keys()].find(
        (k) => k.endsWith("/merged-policy.yaml") || k.endsWith("\\merged-policy.yaml"),
      );
      if (!mergedPolicyKey) throw new Error("merged policy file not written");
      const mergedEntry = store.get(mergedPolicyKey);
      if (!mergedEntry?.content) throw new Error("merged policy file is empty");
      const merged = YAML.parse(mergedEntry.content) as {
        version?: number;
        network_policies?: Record<string, unknown>;
      };
      expect(merged.version).toBe(1);
      expect(merged.network_policies).toHaveProperty("nim_service");
    });

    it("skips policy commands when policy additions are empty", async () => {
      await actionApply("default", minimalBlueprint());
      const policyCalls = mockExeca.mock.calls.filter(
        (c) => Array.isArray(c[1]) && c[1][0] === "policy",
      );
      expect(policyCalls).toEqual([]);
    });

    it("reuses sandbox when 'already exists' error", async () => {
      mockExeca.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "already exists" });
      // Subsequent calls succeed
      mockExeca.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

      await actionApply("default", minimalBlueprint());
      expect(stdoutText()).toContain("already exists, reusing");
    });

    it("throws when sandbox creation fails with other error", async () => {
      mockExeca.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "disk full" });

      await expect(actionApply("default", minimalBlueprint())).rejects.toThrow(
        /Failed to create sandbox.*disk full/,
      );
    });

    it("passes credential via subprocess env, not global env", async () => {
      process.env.MY_API_KEY = "secret-key-123";
      try {
        await actionApply("default", minimalBlueprint());

        // The provider create call should scope credentials to env
        const providerCall = mockExeca.mock.calls.find(
          (c) => Array.isArray(c[1]) && c[1].includes("provider"),
        );
        if (!providerCall) throw new Error("provider create call not found");
        expect(providerCall[2].env.OPENAI_API_KEY).toBe("secret-key-123");
        expect(providerCall[2].env.MY_API_KEY).toBeUndefined();
        // Args pass the env var NAME, not the value
        expect(providerCall[1]).toContain("--credential");
        expect(providerCall[1]).toContain("OPENAI_API_KEY");
        expect(providerCall[1]).not.toContain("secret-key-123");
      } finally {
        delete process.env.MY_API_KEY;
      }
    });

    it("saves run state to disk", async () => {
      await actionApply("default", minimalBlueprint());

      const stateKeys = [...store.keys()].filter((k) => k.includes("/state/runs/"));
      const planKey = stateKeys.find((k) => k.endsWith("/plan.json"));
      if (!planKey) throw new Error("plan.json not written to state dir");
      const entry = store.get(planKey);
      if (!entry?.content) throw new Error("plan.json has no content");

      const plan = JSON.parse(entry.content);
      expect(plan.profile).toBe("default");
      expect(plan.sandbox_name).toBe("test-sandbox");
      expect(plan.timestamp).toBeDefined();
    });

    it("excludes secret fields from persisted plan.json", async () => {
      const bp = {
        components: {
          inference: {
            profiles: {
              secrets: {
                provider_type: "openai",
                endpoint: "https://api.example.com",
                model: "gpt-4",
                credential_env: "SECRET_KEY",
                credential_default: "default-secret-value",
              },
            },
          },
          sandbox: { name: "sb" },
        },
      };
      process.env.SECRET_KEY = "real-secret";
      try {
        await actionApply("secrets", bp);
      } finally {
        delete process.env.SECRET_KEY;
      }

      const planKey = [...store.keys()].find((k) => k.endsWith("/plan.json"));
      if (!planKey) throw new Error("plan.json not written to state dir");
      const entry = store.get(planKey);
      if (!entry?.content) throw new Error("plan.json has no content");
      const persisted = JSON.parse(entry.content);

      expect(persisted.inference).not.toHaveProperty("credential_env");
      expect(persisted.inference).not.toHaveProperty("credential_default");
      // Ensure non-secret fields are still present
      expect(persisted.inference.provider_type).toBe("openai");
      expect(persisted.inference.endpoint).toBe("https://api.example.com");
    });

    it("emits all progress milestones", async () => {
      await actionApply("default", minimalBlueprint());
      const out = stdoutText();
      expect(out).toContain("PROGRESS:20:Creating OpenClaw sandbox");
      expect(out).toContain("PROGRESS:50:Configuring inference provider");
      expect(out).toContain("PROGRESS:70:Setting inference route");
      expect(out).toContain("PROGRESS:85:Saving run state");
      expect(out).toContain("PROGRESS:100:Apply complete");
    });

    it("uses defaults when profile fields are missing", async () => {
      const sparseBlueprint = {
        components: {
          inference: { profiles: { bare: {} } },
          sandbox: {},
        },
      };

      await actionApply("bare", sparseBlueprint);

      // Provider create should use fallback defaults
      const providerCall = mockExeca.mock.calls.find(
        (c) => Array.isArray(c[1]) && c[1].includes("provider"),
      );
      if (!providerCall) throw new Error("provider create call not found");
      expect(providerCall[1]).toContain("default"); // provider_name fallback
      expect(providerCall[1]).toContain("openai"); // provider_type fallback

      // Sandbox create should use fallback defaults
      const sandboxCall = mockExeca.mock.calls.find(
        (c) => Array.isArray(c[1]) && c[1].includes("sandbox"),
      );
      if (!sandboxCall) throw new Error("sandbox create call not found");
      expect(sandboxCall[1]).toContain("openclaw"); // image & name fallback

      const out = stdoutText();
      expect(out).toContain("Apply complete");
    });

    it("skips credential when credential_env is not set", async () => {
      const noCredBlueprint = {
        components: {
          inference: {
            profiles: {
              nocred: {
                provider_type: "openai",
                endpoint: "https://api.example.com",
                model: "gpt-4",
              },
            },
          },
          sandbox: { name: "sb" },
        },
      };

      await actionApply("nocred", noCredBlueprint);

      const providerCall = mockExeca.mock.calls.find(
        (c) => Array.isArray(c[1]) && c[1].includes("provider"),
      );
      if (!providerCall) throw new Error("provider create call not found");
      expect(providerCall[1]).not.toContain("--credential");
    });

    it("does not leak parent secrets into subprocess env", async () => {
      const prevMyApiKey = process.env.MY_API_KEY;
      const prevGithubToken = process.env.GITHUB_TOKEN;
      const prevAwsKey = process.env.AWS_ACCESS_KEY_ID;
      const prevNvidiaKey = process.env.NVIDIA_API_KEY;
      const prevProxy = process.env.HTTPS_PROXY;
      const prevOsDebug = process.env.OPENSHELL_DEBUG;
      process.env.MY_API_KEY = "secret-key-123";
      process.env.GITHUB_TOKEN = "ghp_leaked";
      process.env.AWS_ACCESS_KEY_ID = "AKIA_leaked";
      process.env.NVIDIA_API_KEY = "nvapi-leaked";
      process.env.HTTPS_PROXY = "http://proxy.corp:8080";
      process.env.OPENSHELL_DEBUG = "1";
      try {
        await actionApply("default", minimalBlueprint());

        const providerCall = mockExeca.mock.calls.find(
          (c) => Array.isArray(c[1]) && c[1].includes("provider"),
        );
        if (!providerCall) throw new Error("provider create call not found");
        const subEnv = providerCall[2].env;

        // The explicitly injected credential must be present
        expect(subEnv.OPENAI_API_KEY).toBe("secret-key-123");

        // Secrets from the parent process must NOT be present
        expect(subEnv).not.toHaveProperty("GITHUB_TOKEN");
        expect(subEnv).not.toHaveProperty("AWS_ACCESS_KEY_ID");
        expect(subEnv).not.toHaveProperty("NVIDIA_API_KEY");
        expect(subEnv).not.toHaveProperty("MY_API_KEY");

        // Allowed system vars should still be present
        expect(subEnv).toHaveProperty("PATH");
        expect(subEnv).toHaveProperty("HOME");

        // Proxy, TLS, and openshell vars must pass through
        expect(subEnv.HTTPS_PROXY).toBe("http://proxy.corp:8080");
        expect(subEnv.OPENSHELL_DEBUG).toBe("1");
      } finally {
        if (prevMyApiKey === undefined) delete process.env.MY_API_KEY;
        else process.env.MY_API_KEY = prevMyApiKey;
        if (prevGithubToken === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = prevGithubToken;
        if (prevAwsKey === undefined) delete process.env.AWS_ACCESS_KEY_ID;
        else process.env.AWS_ACCESS_KEY_ID = prevAwsKey;
        if (prevNvidiaKey === undefined) delete process.env.NVIDIA_API_KEY;
        else process.env.NVIDIA_API_KEY = prevNvidiaKey;
        if (prevProxy === undefined) delete process.env.HTTPS_PROXY;
        else process.env.HTTPS_PROXY = prevProxy;
        if (prevOsDebug === undefined) delete process.env.OPENSHELL_DEBUG;
        else process.env.OPENSHELL_DEBUG = prevOsDebug;
      }
    });

    it("falls back to credential_default when env var is unset", async () => {
      const bp = {
        components: {
          inference: {
            profiles: {
              withdefault: {
                credential_env: "UNSET_CRED_VAR",
                credential_default: "fallback-key",
              },
            },
          },
          sandbox: {},
        },
      };

      await actionApply("withdefault", bp);

      const providerCall = mockExeca.mock.calls.find(
        (c) => Array.isArray(c[1]) && c[1].includes("provider"),
      );
      if (!providerCall) throw new Error("provider create call not found");
      expect(providerCall[2].env.OPENAI_API_KEY).toBe("fallback-key");
    });

    it("validates and applies endpoint URL override", async () => {
      await actionApply("default", minimalBlueprint(), {
        endpointUrl: "https://override.example.com/v1",
      });
      expect(mockedValidateEndpoint).toHaveBeenCalledWith("https://override.example.com/v1");
    });

    it("passes --timeout when timeout_secs is set in profile", async () => {
      const bp = {
        components: {
          inference: {
            profiles: {
              local: {
                provider_type: "openai",
                provider_name: "ollama-local",
                endpoint: "http://localhost:11434/v1",
                model: "nemotron-3-super:120b",
                credential_env: "OPENAI_API_KEY",
                credential_default: "ollama",
                timeout_secs: 180,
              },
            },
          },
          sandbox: { name: "sb" },
        },
      };
      process.env.OPENAI_API_KEY = "ollama";
      try {
        await actionApply("local", bp);
      } finally {
        delete process.env.OPENAI_API_KEY;
      }

      const inferenceCall = mockExeca.mock.calls.find(
        (c) => Array.isArray(c[1]) && c[1].includes("inference") && c[1].includes("set"),
      );
      if (!inferenceCall) throw new Error("inference set call not found");
      expect(inferenceCall[1]).toContain("--timeout");
      expect(inferenceCall[1]).toContain("180");
    });

    it("omits --timeout when timeout_secs is not set in profile", async () => {
      await actionApply("default", minimalBlueprint());

      const inferenceCall = mockExeca.mock.calls.find(
        (c) => Array.isArray(c[1]) && c[1].includes("inference") && c[1].includes("set"),
      );
      if (!inferenceCall) throw new Error("inference set call not found");
      expect(inferenceCall[1]).not.toContain("--timeout");
    });

    it("passes endpoint as-is from blueprint (no rewriting)", async () => {
      process.env.NVIDIA_API_KEY = "test-key";
      try {
        await actionApply("routed", routedBlueprint());

        const providerCall = mockExeca.mock.calls.find(
          (c) => Array.isArray(c[1]) && c[1].includes("provider"),
        );
        if (!providerCall) throw new Error("provider create call not found");
        const configArg = (providerCall[1] as string[]).find((a: string) =>
          a.startsWith("OPENAI_BASE_URL="),
        );
        expect(configArg).toBe("OPENAI_BASE_URL=http://localhost:4000/v1");
      } finally {
        delete process.env.NVIDIA_API_KEY;
      }
    });
  });

  describe("actionStatus", () => {
    const RUNS_DIR = `${FAKE_HOME}/.nemoclaw/state/runs`;

    beforeEach(() => {
      captureStdout();
    });

    it("prints 'No runs found.' when runs dir does not exist", () => {
      actionStatus();
      expect(stdoutText()).toContain("No runs found.");
    });

    it("prints 'No runs found.' when runs dir is empty", () => {
      addDir(RUNS_DIR);
      actionStatus();
      expect(stdoutText()).toContain("No runs found.");
    });

    it("prints plan.json for most recent run", () => {
      const plan = { run_id: "nc-run-2", profile: "default" };
      addDir(`${RUNS_DIR}/nc-run-1`);
      addFile(`${RUNS_DIR}/nc-run-1/plan.json`, JSON.stringify({ run_id: "nc-run-1" }));
      addDir(`${RUNS_DIR}/nc-run-2`);
      addFile(`${RUNS_DIR}/nc-run-2/plan.json`, JSON.stringify(plan));

      actionStatus();
      // Should pick the latest (nc-run-2 sorts after nc-run-1)
      expect(stdoutText()).toContain('"nc-run-2"');
    });

    it("prints plan.json for a specific run ID", () => {
      addDir(`${RUNS_DIR}/nc-run-1`);
      addFile(`${RUNS_DIR}/nc-run-1/plan.json`, JSON.stringify({ run_id: "nc-run-1" }));

      actionStatus("nc-run-1");
      expect(stdoutText()).toContain('"nc-run-1"');
    });

    it("prints unknown status when plan.json is missing", () => {
      addDir(`${RUNS_DIR}/nc-run-1`);

      actionStatus("nc-run-1");
      expect(stdoutText()).toContain('"status":"unknown"');
    });

    // ── Path traversal rejection ──────────────────────────────────

    it.each([
      "../../etc",
      "../tmp",
      "valid.with.dots",
      "foo\x00bar",
      "/absolute/path",
    ])("rejects malicious run ID: %j", (rid) => {
      expect(() => {
        actionStatus(rid);
      }).toThrow(/Invalid run ID/);
    });

    it("accepts a legitimate hyphenated run ID", () => {
      const rid = "nc-20260406-abc12345";
      addDir(`${RUNS_DIR}/${rid}`);
      addFile(`${RUNS_DIR}/${rid}/plan.json`, JSON.stringify({ run_id: rid }));
      actionStatus(rid);
      expect(stdoutText()).toContain(rid);
    });
  });

  describe("actionRollback", () => {
    const RUNS_DIR = `${FAKE_HOME}/.nemoclaw/state/runs`;

    beforeEach(() => {
      captureStdout();
      mockExeca.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    });

    it("throws when run ID is not found", async () => {
      await expect(actionRollback("nc-missing")).rejects.toThrow(/nc-missing not found/);
    });

    it("stops and removes sandbox from plan", async () => {
      const runDir = `${RUNS_DIR}/nc-run-1`;
      addDir(runDir);
      addFile(`${runDir}/plan.json`, JSON.stringify({ sandbox_name: "my-sandbox" }));

      await actionRollback("nc-run-1");

      expect(mockExeca).toHaveBeenCalledWith(
        "openshell",
        ["sandbox", "stop", "my-sandbox"],
        expect.objectContaining({ reject: false }),
      );
      expect(mockExeca).toHaveBeenCalledWith(
        "openshell",
        ["sandbox", "remove", "my-sandbox"],
        expect.objectContaining({ reject: false }),
      );
    });

    it("writes rolled_back marker file", async () => {
      const runDir = `${RUNS_DIR}/nc-run-1`;
      addDir(runDir);
      addFile(`${runDir}/plan.json`, JSON.stringify({ sandbox_name: "sb" }));

      await actionRollback("nc-run-1");

      expect(store.has(`${runDir}/rolled_back`)).toBe(true);
    });

    it("still writes marker when plan.json is missing", async () => {
      const runDir = `${RUNS_DIR}/nc-run-1`;
      addDir(runDir);
      // No plan.json — should skip sandbox stop/remove but still mark rolled_back

      await actionRollback("nc-run-1");

      expect(mockExeca).not.toHaveBeenCalled();
      expect(store.has(`${runDir}/rolled_back`)).toBe(true);
    });

    // ── Path traversal rejection ──────────────────────────────────

    it.each([
      "../../etc",
      "../tmp",
      "valid.with.dots",
      "foo\x00bar",
      "/absolute/path",
      "",
    ])("rejects malicious run ID: %j", async (rid) => {
      await expect(actionRollback(rid)).rejects.toThrow(/Invalid run ID/);
    });

    it("defaults sandbox_name to 'openclaw' when not in plan", async () => {
      const runDir = `${RUNS_DIR}/nc-run-1`;
      addDir(runDir);
      addFile(`${runDir}/plan.json`, JSON.stringify({}));

      await actionRollback("nc-run-1");

      expect(mockExeca).toHaveBeenCalledWith(
        "openshell",
        ["sandbox", "stop", "openclaw"],
        expect.anything(),
      );
    });
  });

  describe("main (CLI)", () => {
    beforeEach(() => {
      captureStdout();
      mockExeca.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
      seedBlueprintFile();
    });

    it("throws on unknown action with the raw invalid token", async () => {
      store.clear();
      await expect(main(["bogus"])).rejects.toThrow(/Unknown action 'bogus'/);
    });

    it("throws on missing action with a clear marker", async () => {
      store.clear();
      await expect(main([])).rejects.toThrow(/Unknown action '\(missing\)'/);
    });

    it("parses plan with --profile and --dry-run", async () => {
      await main(["plan", "--profile", "default", "--dry-run"]);
      const out = stdoutText();
      expect(out).toContain('"dry_run": true');
    });

    it("parses rollback with --run-id", async () => {
      const runDir = `${FAKE_HOME}/.nemoclaw/state/runs/nc-run-1`;
      addDir(runDir);
      addFile(`${runDir}/plan.json`, JSON.stringify({ sandbox_name: "sb" }));

      await main(["rollback", "--run-id", "nc-run-1"]);
      expect(store.has(`${runDir}/rolled_back`)).toBe(true);
    });

    it("throws when rollback has no --run-id", async () => {
      await expect(main(["rollback"])).rejects.toThrow(/--run-id is required/);
    });

    it("parses status with --run-id", async () => {
      const runDir = `${FAKE_HOME}/.nemoclaw/state/runs/nc-run-1`;
      addDir(runDir);
      addFile(`${runDir}/plan.json`, JSON.stringify({ run_id: "nc-run-1" }));

      await main(["status", "--run-id", "nc-run-1"]);
      expect(stdoutText()).toContain("nc-run-1");
    });

    it("parses apply with --profile and --endpoint-url", async () => {
      await main(["apply", "--profile", "default", "--endpoint-url", "https://override.test/v1"]);
      expect(mockedValidateEndpoint).toHaveBeenCalledWith("https://override.test/v1");
      expect(stdoutText()).toContain("PROGRESS:100:Apply complete");
    });

    it("rejects --plan flag (not yet implemented)", async () => {
      await expect(
        main(["apply", "--profile", "default", "--plan", "/tmp/saved-plan.json"]),
      ).rejects.toThrow(/--plan is not yet implemented/);
    });

    it("parses --dry-run and --endpoint-url for plan", async () => {
      await main([
        "plan",
        "--profile",
        "default",
        "--dry-run",
        "--endpoint-url",
        "https://ep.test",
      ]);
      const out = stdoutText();
      expect(out).toContain('"dry_run": true');
      expect(out).toContain('"endpoint": "https://ep.test"');
      expect(mockedValidateEndpoint).toHaveBeenCalledWith("https://ep.test");
    });
  });
});
