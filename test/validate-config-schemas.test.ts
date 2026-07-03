// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Validate config files against their JSON Schemas.
 *
 * Complements validate-blueprint.test.ts (business-logic invariants) with
 * structural/type validation via JSON Schema. Runs as part of the "cli"
 * Vitest project.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ValidateFunction } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { discoverTargets } from "../scripts/validate-configs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function repoPath(...segments: string[]): string {
  return join(REPO_ROOT, ...segments);
}

type LooseScalar = string | number | boolean | null;
type LooseValue = LooseScalar | LooseObject | LooseValue[];
type LooseObject = { [key: string]: LooseValue };

function parseJson<T>(text: string): T {
  return JSON.parse(text);
}

function isLooseValue(value: LooseValue | object | undefined): value is LooseValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((entry) => isLooseValue(entry));
  }
  return isLooseObject(value);
}

function isLooseObject(value: LooseValue | object | undefined): value is LooseObject {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => isLooseValue(entry))
  );
}

function loadYAML(path: string): LooseObject {
  const parsed = YAML.parse(readFileSync(path, "utf-8"));
  if (!isLooseObject(parsed)) {
    throw new Error(`Expected YAML object in ${path}`);
  }
  return parsed;
}

function loadJSON(path: string): LooseObject {
  const parsed = parseJson<LooseValue>(readFileSync(path, "utf-8"));
  if (!isLooseObject(parsed)) {
    throw new Error(`Expected JSON object in ${path}`);
  }
  return parsed;
}

function compileSchema(schemaRelPath: string): ValidateFunction {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const schema = loadJSON(repoPath(schemaRelPath));
  return ajv.compile(schema);
}

function asRecord(value: LooseValue | undefined): LooseObject {
  return isLooseObject(value) ? value : {};
}

function cloneObject(value: LooseObject | undefined): LooseObject {
  return { ...asRecord(value) };
}

function expectValid(validate: ValidateFunction, data: object, label: string): void {
  const valid = validate(data);
  if (!valid) {
    const messages = (validate.errors ?? []).map((e) => `  ${e.instancePath || "/"}: ${e.message}`);
    expect.unreachable(`${label} failed schema validation:\n${messages.join("\n")}`);
  }
}

// ── Validation target discovery ─────────────────────────────────────────────

describe("config validation target discovery", () => {
  const targets = discoverTargets();
  const filesBySchema = new Map(targets.map((target) => [target.schema, target.files]));
  const sandboxPolicyFiles = filesBySchema.get("schemas/sandbox-policy.schema.json") ?? [];
  const presetFiles = filesBySchema.get("schemas/policy-preset.schema.json") ?? [];

  it("includes every binary-scoped sandbox policy family", () => {
    expect(sandboxPolicyFiles).toEqual(
      expect.arrayContaining([
        "nemoclaw-blueprint/policies/openclaw-sandbox.yaml",
        "nemoclaw-blueprint/policies/openclaw-sandbox-permissive.yaml",
        "agents/hermes/policy-additions.yaml",
        "agents/hermes/policy-permissive.yaml",
        "agents/openclaw/policy-permissive.yaml",
      ]),
    );
  });

  it("discovers model-specific setup manifests", () => {
    expect(filesBySchema.get("nemoclaw-blueprint/model-specific-setup/schema.json") ?? []).toEqual(
      expect.arrayContaining([
        "nemoclaw-blueprint/model-specific-setup/openclaw/kimi-k2.6-managed-inference.json",
      ]),
    );
  });

  it("discovers channel-owned messaging policy presets", () => {
    expect(presetFiles).toEqual(
      expect.arrayContaining([
        "src/lib/messaging/channels/slack/policy/openclaw.yaml",
        "src/lib/messaging/channels/slack/policy/hermes.yaml",
        "src/lib/messaging/channels/telegram/policy/openclaw.yaml",
        "src/lib/messaging/channels/telegram/policy/hermes.yaml",
      ]),
    );
  });
});

// ── Blueprint ────────────────────────────────────────────────────────────────

describe("blueprint.schema.json", () => {
  const validate = compileSchema("schemas/blueprint.schema.json");
  const data = loadYAML(repoPath("nemoclaw-blueprint/blueprint.yaml"));

  it("blueprint.yaml passes schema validation", () => {
    expectValid(validate, data, "blueprint.yaml");
  });

  it("rejects blueprint with missing required field", () => {
    const bad = cloneObject(data);
    delete bad.version;
    expect(validate(bad)).toBe(false);
  });

  it("rejects blueprint with wrong type for version", () => {
    const bad = { ...cloneObject(data), version: 123 };
    expect(validate(bad)).toBe(false);
  });

  it("rejects blueprint with unknown top-level property", () => {
    const bad = { ...cloneObject(data), unknownField: true };
    expect(validate(bad)).toBe(false);
  });

  it("rejects blueprint with unknown nested component property", () => {
    const root = asRecord(data);
    const components = asRecord(root.components);
    const inference = asRecord(components.inference);
    const bad = {
      ...root,
      components: {
        ...components,
        inference: {
          ...inference,
          extraField: true,
        },
      },
    };
    expect(validate(bad)).toBe(false);
  });

  it("rejects blueprint inference profile with unknown property", () => {
    const root = asRecord(data);
    const components = asRecord(root.components);
    const inference = asRecord(components.inference);
    const profiles = asRecord(inference.profiles);
    const defaultProfile = asRecord(profiles.default);
    const bad = {
      ...root,
      components: {
        ...components,
        inference: {
          ...inference,
          profiles: {
            ...profiles,
            default: {
              ...defaultProfile,
              typoField: true,
            },
          },
        },
      },
    };
    expect(validate(bad)).toBe(false);
  });

  it("rejects blueprint policyAddition endpoint with protocol rest but no rules", () => {
    const bad = {
      version: "1.0.0",
      profiles: ["default"],
      components: {
        sandbox: { image: "img:latest", name: "test-sandbox" },
        inference: {
          profiles: {
            default: { provider_type: "openai", endpoint: "https://api.openai.com" },
          },
        },
        policy: {
          base: "policies/openclaw-sandbox.yaml",
          additions: {
            my_service: {
              name: "My Service",
              endpoints: [{ host: "api.example.com", port: 443, protocol: "rest" }],
            },
          },
        },
      },
    };
    expect(validate(bad)).toBe(false);
  });
});

// ── Model Router pool config ────────────────────────────────────────────────

describe("router-pool-config.schema.json", () => {
  const validate = compileSchema("schemas/router-pool-config.schema.json");
  const data = loadYAML(repoPath("nemoclaw-blueprint/router/pool-config.yaml"));

  it("pool-config.yaml passes schema validation", () => {
    expectValid(validate, data, "pool-config.yaml");
  });

  it("rejects router pool config without routing settings", () => {
    const bad = cloneObject(data);
    delete bad.routing;
    expect(validate(bad)).toBe(false);
  });

  it("rejects router pool config models without LiteLLM model IDs", () => {
    const root = asRecord(data);
    const firstModel = asRecord(Array.isArray(root.models) ? root.models[0] : undefined);
    const { litellm_model: _litellmModel, ...modelWithoutId } = firstModel;
    const bad = { ...root, models: [modelWithoutId] };
    expect(validate(bad)).toBe(false);
  });

  it("rejects router pool config api_base without HTTPS", () => {
    const root = asRecord(data);
    const firstModel = asRecord(Array.isArray(root.models) ? root.models[0] : undefined);
    const bad = {
      ...root,
      models: [{ ...firstModel, api_base: "http://integrate.api.nvidia.com/v1" }],
    };
    expect(validate(bad)).toBe(false);
  });
});

// ── Base sandbox policy ──────────────────────────────────────────────────────

describe("sandbox-policy.schema.json", () => {
  const validate = compileSchema("schemas/sandbox-policy.schema.json");
  const data = loadYAML(repoPath("nemoclaw-blueprint/policies/openclaw-sandbox.yaml"));

  it("openclaw-sandbox.yaml passes schema validation", () => {
    expectValid(validate, data, "openclaw-sandbox.yaml");
  });

  it("openclaw-sandbox-permissive.yaml passes schema validation", () => {
    expectValid(
      validate,
      loadYAML(repoPath("nemoclaw-blueprint/policies/openclaw-sandbox-permissive.yaml")),
      "openclaw-sandbox-permissive.yaml",
    );
  });

  for (const file of [
    "agents/openclaw/policy-permissive.yaml",
    "agents/hermes/policy-additions.yaml",
    "agents/hermes/policy-permissive.yaml",
  ]) {
    if (existsSync(repoPath(file))) {
      it(`${file} passes schema validation`, () => {
        expectValid(validate, loadYAML(repoPath(file)), file);
      });
    }
  }

  it("rejects policy with missing network_policies", () => {
    const bad = cloneObject(data);
    delete bad.network_policies;
    expect(validate(bad)).toBe(false);
  });

  it("rejects policy with unknown top-level property", () => {
    const bad = { ...cloneObject(data), extra: true };
    expect(validate(bad)).toBe(false);
  });

  it("rejects sandbox-policy endpoint with protocol rest but no rules", () => {
    const bad = {
      version: 1,
      network_policies: {
        test_service: {
          name: "Test Service",
          binaries: [{ path: "/usr/bin/node" }],
          endpoints: [{ host: "api.example.com", port: 443, protocol: "rest" }],
        },
      },
    };
    expect(validate(bad)).toBe(false);
  });

  it("rejects sandbox-policy network entries without explicit binary scoping", () => {
    const bad = {
      version: 1,
      network_policies: {
        test_service: {
          name: "Test Service",
          endpoints: [{ host: "api.example.com", port: 443, access: "full" }],
        },
      },
    };
    expect(validate(bad)).toBe(false);
  });

  it("accepts sandbox-policy native WebSocket text rules and credential rewrite", () => {
    const valid = {
      version: 1,
      network_policies: {
        test_service: {
          name: "Test Service",
          binaries: [{ path: "/usr/bin/node" }],
          endpoints: [
            {
              host: "gateway.example.com",
              port: 443,
              protocol: "websocket",
              enforcement: "enforce",
              websocket_credential_rewrite: true,
              allowed_ips: ["10.0.0.0/8", "172.16.0.0/12"],
              rules: [
                { allow: { method: "GET", path: "/**" } },
                { allow: { method: "WEBSOCKET_TEXT", path: "/**" } },
              ],
            },
          ],
        },
      },
    };
    expectValid(validate, valid, "websocket policy");
  });

  it("accepts sandbox-policy request-body credential rewrite on REST endpoints", () => {
    const valid = {
      version: 1,
      network_policies: {
        slack: {
          name: "Slack",
          binaries: [{ path: "/usr/bin/node" }],
          endpoints: [
            {
              host: "api.slack.com",
              port: 443,
              protocol: "rest",
              enforcement: "enforce",
              request_body_credential_rewrite: true,
              rules: [{ allow: { method: "POST", path: "/**" } }],
            },
          ],
        },
      },
    };
    expectValid(validate, valid, "rest body rewrite policy");
  });

  it("accepts sandbox-policy JSON-RPC and MCP endpoints with explicit L7 matchers", () => {
    const valid = {
      version: 1,
      network_policies: {
        mcp_bridge: {
          name: "MCP Bridge",
          binaries: [{ path: "/usr/local/bin/mcporter" }],
          endpoints: [
            {
              host: "host.openshell.internal",
              port: 31337,
              protocol: "json-rpc",
              enforcement: "enforce",
              json_rpc: { max_body_bytes: 131072 },
              rules: [{ allow: { method: "tools/list", path: "/mcp" } }],
            },
            {
              host: "host.openshell.internal",
              port: 31337,
              protocol: "mcp",
              enforcement: "enforce",
              mcp: { max_body_bytes: 131072, strict_tool_names: true },
              rules: [
                {
                  allow: {
                    method: "tools/call",
                    path: "/mcp",
                    tool: { any: ["search", "read"] },
                    params: { query: { any: ["safe", "readonly"] } },
                  },
                },
              ],
              deny_rules: [{ tool: "admin" }],
            },
          ],
        },
      },
    };
    expectValid(validate, valid, "json-rpc and mcp policy");
  });

  it("rejects sandbox-policy MCP endpoints without rules or explicit MCP allow-all", () => {
    const bad = {
      version: 1,
      network_policies: {
        mcp_bridge: {
          name: "MCP Bridge",
          binaries: [{ path: "/usr/local/bin/mcporter" }],
          endpoints: [
            {
              host: "host.openshell.internal",
              port: 31337,
              protocol: "mcp",
              mcp: { max_body_bytes: 131072 },
            },
          ],
        },
      },
    };
    expect(validate(bad)).toBe(false);
  });

  it("accepts sandbox-policy MCP endpoint allow-all without REST access presets", () => {
    const valid = {
      version: 1,
      network_policies: {
        mcp_bridge: {
          name: "MCP Bridge",
          binaries: [{ path: "/usr/local/bin/mcporter" }],
          endpoints: [
            {
              host: "host.openshell.internal",
              port: 31337,
              protocol: "mcp",
              mcp: { max_body_bytes: 131072, allow_all_known_mcp_methods: true },
            },
          ],
        },
      },
    };
    expectValid(validate, valid, "mcp policy allow-all");
  });

  it("rejects sandbox-policy JSON-RPC and MCP endpoints above the body-size cap", () => {
    const oversizedJsonRpc = {
      version: 1,
      network_policies: {
        rpc: {
          name: "RPC",
          binaries: [{ path: "/usr/local/bin/tool" }],
          endpoints: [
            {
              host: "mcp.example.com",
              port: 443,
              protocol: "json-rpc",
              json_rpc: { max_body_bytes: 1048577 },
              rules: [{ allow: { method: "initialize" } }],
            },
          ],
        },
      },
    };
    expect(validate(oversizedJsonRpc)).toBe(false);

    const oversizedMcp = {
      version: 1,
      network_policies: {
        mcp_bridge: {
          name: "MCP Bridge",
          binaries: [{ path: "/usr/local/bin/mcporter" }],
          endpoints: [
            {
              host: "mcp.example.com",
              port: 443,
              protocol: "mcp",
              mcp: { max_body_bytes: 1048577, allow_all_known_mcp_methods: true },
            },
          ],
        },
      },
    };
    expect(validate(oversizedMcp)).toBe(false);
  });

  it("rejects sandbox-policy JSON-RPC and MCP endpoints with REST access presets", () => {
    const base = {
      version: 1,
      network_policies: {
        rpc: {
          name: "RPC",
          binaries: [{ path: "/usr/local/bin/mcporter" }],
          endpoints: [
            {
              host: "rpc.example.com",
              port: 443,
              protocol: "json-rpc",
              access: "full",
              rules: [{ allow: { method: "initialize" } }],
            },
          ],
        },
      },
    };
    expect(validate(base)).toBe(false);

    const mcp = {
      version: 1,
      network_policies: {
        rpc: {
          name: "RPC",
          binaries: [{ path: "/usr/local/bin/mcporter" }],
          endpoints: [
            {
              host: "mcp.example.com",
              port: 443,
              protocol: "mcp",
              access: "full",
              mcp: { allow_all_known_mcp_methods: true },
            },
          ],
        },
      },
    };
    expect(validate(mcp)).toBe(false);
  });

  it("rejects sandbox-policy endpoint with protocol websocket but no rules or access", () => {
    const bad = {
      version: 1,
      network_policies: {
        test_service: {
          name: "Test Service",
          binaries: [{ path: "/usr/bin/node" }],
          endpoints: [{ host: "gateway.example.com", port: 443, protocol: "websocket" }],
        },
      },
    };
    expect(validate(bad)).toBe(false);
  });
});

// ── Policy presets ───────────────────────────────────────────────────────────

describe("policy-preset.schema.json", () => {
  const validate = compileSchema("schemas/policy-preset.schema.json");
  const presetFiles =
    discoverTargets().find((target) => target.schema === "schemas/policy-preset.schema.json")
      ?.files ?? [];

  for (const file of presetFiles) {
    it(`${file} passes schema validation`, () => {
      const data = loadYAML(repoPath(file));
      expectValid(validate, data, file);
    });
  }

  it("rejects preset without preset metadata", () => {
    const bad = {
      network_policies: {
        test: { name: "test", endpoints: [{ host: "a.com", port: 443, access: "full" }] },
      },
    };
    expect(validate(bad)).toBe(false);
  });

  it("rejects preset without network_policies", () => {
    const bad = { preset: { name: "test", description: "test" } };
    expect(validate(bad)).toBe(false);
  });

  it("rejects preset endpoint with protocol rest but no rules", () => {
    const bad = {
      preset: { name: "test", description: "test" },
      network_policies: {
        test_service: {
          name: "Test Service",
          binaries: [{ path: "/usr/bin/node" }],
          endpoints: [{ host: "api.example.com", port: 443, protocol: "rest" }],
        },
      },
    };
    expect(validate(bad)).toBe(false);
  });

  it("rejects preset network entries without explicit binary scoping", () => {
    const bad = {
      preset: { name: "test", description: "test" },
      network_policies: {
        test_service: {
          name: "Test Service",
          endpoints: [{ host: "api.example.com", port: 443, access: "full" }],
        },
      },
    };
    expect(validate(bad)).toBe(false);
  });

  it("accepts preset native WebSocket text rules and credential rewrite", () => {
    const valid = {
      preset: { name: "test", description: "test" },
      network_policies: {
        test_service: {
          name: "Test Service",
          binaries: [{ path: "/usr/bin/node" }],
          endpoints: [
            {
              host: "gateway.example.com",
              port: 443,
              protocol: "websocket",
              enforcement: "enforce",
              websocket_credential_rewrite: true,
              allowed_ips: ["10.0.0.0/8", "172.16.0.0/12"],
              rules: [
                { allow: { method: "GET", path: "/**" } },
                { allow: { method: "WEBSOCKET_TEXT", path: "/**" } },
              ],
            },
          ],
        },
      },
    };
    expectValid(validate, valid, "websocket preset");
  });

  it("accepts preset request-body credential rewrite on REST endpoints", () => {
    const valid = {
      preset: { name: "slack", description: "Slack" },
      network_policies: {
        slack: {
          name: "Slack",
          binaries: [{ path: "/usr/bin/node" }],
          endpoints: [
            {
              host: "api.slack.com",
              port: 443,
              protocol: "rest",
              enforcement: "enforce",
              request_body_credential_rewrite: true,
              rules: [{ allow: { method: "POST", path: "/**" } }],
            },
          ],
        },
      },
    };
    expectValid(validate, valid, "rest body rewrite preset");
  });

  it("accepts preset JSON-RPC and MCP endpoints with focused option objects", () => {
    const valid = {
      preset: { name: "mcp", description: "MCP" },
      network_policies: {
        mcp_bridge: {
          name: "MCP Bridge",
          binaries: [{ path: "/usr/local/bin/mcporter" }],
          endpoints: [
            {
              host: "mcp.example.com",
              port: 443,
              protocol: "json-rpc",
              json_rpc: { max_body_bytes: 131072 },
              rules: [{ allow: { method: "initialize", path: "/mcp" } }],
            },
            {
              host: "mcp.example.com",
              port: 443,
              protocol: "mcp",
              mcp: { max_body_bytes: 131072, allow_all_known_mcp_methods: false },
              rules: [{ allow: { method: "tools/call", path: "/mcp", tool: "search" } }],
              deny_rules: [{ params: { mode: "admin" } }],
            },
          ],
        },
      },
    };
    expectValid(validate, valid, "json-rpc and mcp preset");
  });

  it("rejects preset MCP endpoints with missing rules, invalid options, or invalid matchers", () => {
    const base = {
      preset: { name: "mcp", description: "MCP" },
      network_policies: {
        mcp_bridge: {
          name: "MCP Bridge",
          binaries: [{ path: "/usr/local/bin/mcporter" }],
          endpoints: [
            {
              host: "mcp.example.com",
              port: 443,
              protocol: "mcp",
              mcp: { max_body_bytes: 131072 },
              rules: [{ allow: { method: "tools/list", path: "/mcp" } }],
            },
          ],
        },
      },
    };
    type McpPresetFixture = {
      network_policies: {
        mcp_bridge: {
          endpoints: Array<{
            rules?: unknown[];
            deny_rules?: unknown[];
            mcp: { allow_all_known_mcp_methods?: unknown };
          }>;
        };
      };
    };
    const missingRules = cloneObject(base) as McpPresetFixture;
    delete missingRules.network_policies.mcp_bridge.endpoints[0]!.rules;
    expect(validate(missingRules)).toBe(false);

    const invalidOptions = cloneObject(base) as McpPresetFixture;
    invalidOptions.network_policies.mcp_bridge.endpoints[0]!.mcp.allow_all_known_mcp_methods =
      "yes";
    expect(validate(invalidOptions)).toBe(false);

    const invalidMatcher = cloneObject(base) as McpPresetFixture;
    invalidMatcher.network_policies.mcp_bridge.endpoints[0]!.deny_rules = [{ tool: { any: [] } }];
    expect(validate(invalidMatcher)).toBe(false);
  });

  it("accepts preset MCP allow-all and rejects JSON-RPC or MCP access presets", () => {
    const allowAll = {
      preset: { name: "mcp", description: "MCP" },
      network_policies: {
        mcp_bridge: {
          name: "MCP Bridge",
          binaries: [{ path: "/usr/local/bin/mcporter" }],
          endpoints: [
            {
              host: "mcp.example.com",
              port: 443,
              protocol: "mcp",
              mcp: { allow_all_known_mcp_methods: true },
            },
          ],
        },
      },
    };
    expectValid(validate, allowAll, "mcp preset allow-all");

    const jsonRpcAccess = {
      preset: { name: "mcp", description: "MCP" },
      network_policies: {
        mcp_bridge: {
          name: "MCP Bridge",
          binaries: [{ path: "/usr/local/bin/mcporter" }],
          endpoints: [
            {
              host: "rpc.example.com",
              port: 443,
              protocol: "json-rpc",
              access: "full",
              rules: [{ allow: { method: "initialize" } }],
            },
          ],
        },
      },
    };
    expect(validate(jsonRpcAccess)).toBe(false);

    const mcpAccess = {
      preset: { name: "mcp", description: "MCP" },
      network_policies: {
        mcp_bridge: {
          name: "MCP Bridge",
          binaries: [{ path: "/usr/local/bin/mcporter" }],
          endpoints: [
            {
              host: "mcp.example.com",
              port: 443,
              protocol: "mcp",
              access: "full",
              mcp: { allow_all_known_mcp_methods: true },
            },
          ],
        },
      },
    };
    expect(validate(mcpAccess)).toBe(false);
  });

  it("rejects preset JSON-RPC and MCP endpoints above the body-size cap", () => {
    const oversizedJsonRpc = {
      preset: { name: "rpc", description: "RPC" },
      network_policies: {
        rpc: {
          name: "RPC",
          binaries: [{ path: "/usr/local/bin/tool" }],
          endpoints: [
            {
              host: "mcp.example.com",
              port: 443,
              protocol: "json-rpc",
              json_rpc: { max_body_bytes: 1048577 },
              rules: [{ allow: { method: "initialize" } }],
            },
          ],
        },
      },
    };
    expect(validate(oversizedJsonRpc)).toBe(false);

    const oversizedMcp = {
      preset: { name: "mcp", description: "MCP" },
      network_policies: {
        mcp_bridge: {
          name: "MCP Bridge",
          binaries: [{ path: "/usr/local/bin/mcporter" }],
          endpoints: [
            {
              host: "mcp.example.com",
              port: 443,
              protocol: "mcp",
              mcp: { max_body_bytes: 1048577, allow_all_known_mcp_methods: true },
            },
          ],
        },
      },
    };
    expect(validate(oversizedMcp)).toBe(false);
  });

  it("rejects preset endpoint with protocol websocket but no rules", () => {
    const bad = {
      preset: { name: "test", description: "test" },
      network_policies: {
        test_service: {
          name: "Test Service",
          binaries: [{ path: "/usr/bin/node" }],
          endpoints: [{ host: "gateway.example.com", port: 443, protocol: "websocket" }],
        },
      },
    };
    expect(validate(bad)).toBe(false);
  });
});

// ── OpenClaw plugin manifest ─────────────────────────────────────────────────

describe("openclaw-plugin.schema.json", () => {
  const validate = compileSchema("schemas/openclaw-plugin.schema.json");
  const data = loadJSON(repoPath("nemoclaw/openclaw.plugin.json"));
  const validPluginFixture = {
    id: "fixture-plugin",
    name: "Fixture Plugin",
    version: "1.2.3",
    description: "Schema fixture",
    configSchema: { type: "object" },
    commandAliases: [{ name: "fixture", kind: "runtime-slash" }],
    activation: { onStartup: true },
  };

  it("openclaw.plugin.json passes schema validation", () => {
    expectValid(validate, data, "openclaw.plugin.json");
  });

  it("accepts runtime slash activation metadata", () => {
    expectValid(validate, validPluginFixture, "runtime slash activation fixture");
  });

  it("rejects command alias without kind", () => {
    const bad = {
      ...validPluginFixture,
      commandAliases: [{ name: "fixture" }],
      activation: { onStartup: true },
    };
    expect(validate(bad)).toBe(false);
  });

  it("rejects empty activation metadata", () => {
    const bad = { ...validPluginFixture, activation: {} };
    expect(validate(bad)).toBe(false);
  });

  it("rejects activation properties NemoClaw does not use", () => {
    const bad = { ...validPluginFixture, activation: { onStartup: true, onProviders: ["demo"] } };
    expect(validate(bad)).toBe(false);
  });

  it("rejects plugin with missing id", () => {
    const { id: _id, ...bad } = validPluginFixture;
    expect(validate(bad)).toBe(false);
  });

  it("rejects plugin with invalid version format", () => {
    const bad = { ...validPluginFixture, version: "not-semver" };
    expect(validate(bad)).toBe(false);
  });
});

// ── Model-Specific Setup ────────────────────────────────────────────────────

describe("model-specific-setup/schema.json", () => {
  const validate = compileSchema("nemoclaw-blueprint/model-specific-setup/schema.json");
  const data = loadJSON(
    repoPath("nemoclaw-blueprint/model-specific-setup/openclaw/kimi-k2.6-managed-inference.json"),
  );

  it("accepts the OpenClaw Kimi manifest", () => {
    expectValid(validate, data, "kimi-k2.6-managed-inference.json");
  });

  it("rejects OpenClaw manifests with Hermes effects", () => {
    const bad = {
      ...cloneObject(data),
      effects: {
        hermesCompat: {
          future: true,
        },
      },
    };
    expect(validate(bad)).toBe(false);
  });

  it("rejects manifests with empty match objects", () => {
    const bad = {
      ...cloneObject(data),
      match: {},
    };
    expect(validate(bad)).toBe(false);
  });

  it("rejects whitespace-only manifest strings", () => {
    const bad = {
      ...cloneObject(data),
      description: "   ",
      match: {
        modelIds: ["   "],
      },
    };
    expect(validate(bad)).toBe(false);
  });

  it("rejects OpenClaw plugin paths outside the staged plugin trees", () => {
    for (const [pathValue, loadPathValue] of [
      ["/etc/passwd", "/usr/local/share/nemoclaw/openclaw-plugins/fixture"],
      ["../secrets", "/usr/local/share/nemoclaw/openclaw-plugins/fixture"],
      ["openclaw-plugins/subdir/../escape", "/usr/local/share/nemoclaw/openclaw-plugins/fixture"],
      ["openclaw-plugins/fixture", "/etc/passwd"],
      ["openclaw-plugins/fixture", "/usr/local/share/nemoclaw/openclaw-plugins/subdir/../escape"],
    ]) {
      const bad = {
        ...cloneObject(data),
        effects: {
          openclawPlugins: [
            {
              id: "fixture-plugin",
              path: pathValue,
              loadPath: loadPathValue,
            },
          ],
        },
      };
      expect(validate(bad)).toBe(false);
    }
  });

  it("accepts OpenClaw plugin paths inside the staged plugin trees", () => {
    const valid = {
      ...cloneObject(data),
      effects: {
        openclawPlugins: [
          {
            id: "fixture-plugin",
            path: "openclaw-plugins/pluginA/main.js",
            loadPath: "/usr/local/share/nemoclaw/openclaw-plugins/dir/sub_dir/plugin.so",
          },
        ],
      },
    };
    expectValid(validate, valid, "fixture plugin paths");
  });

  it("rejects Hermes manifests with OpenClaw effects", () => {
    const bad = {
      id: "fixture-hermes",
      agent: "hermes",
      description: "Fixture Hermes setup",
      match: {
        modelIds: ["fixture/hermes"],
      },
      effects: {
        openclawCompat: {},
      },
    };
    expect(validate(bad)).toBe(false);
  });
});
