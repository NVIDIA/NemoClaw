// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import Ajv, { type AnySchemaObject, type ValidateFunction } from "ajv/dist/2020.js";
import { unsafeEndpointUrlViolation } from "../core/endpoint-url-safety";
import { isSandboxPolicyCredentialFree } from "../policy/sandbox-policy-validation";
import {
  NemoClawAgentExecutionSchema,
  NemoClawAgentToolsConfigSchema,
  NemoClawHermesInterfacesSchema,
  NemoClawInferenceTuningSchema,
  NemoClawOpenClawInterfacesSchema,
  NemoClawOpenClawObservabilitySchema,
  NEMOCLAW_CONFIG_KIND,
  NEMOCLAW_SANDBOX_POLICY_SCHEMA_ID,
  isCredentialEnvironmentReferenceName,
} from "./model";

export const V1ALPHA1_EXPORT_API_VERSION = "nemoclaw.nvidia.com/v1alpha1" as const;
export const V1ALPHA1_EXPORT_SCHEMA_ID =
  "https://github.com/NVIDIA/NemoClaw/schemas/nemoclaw-v1alpha1-export.schema.json" as const;

const PACKAGE_ROOT = path.resolve(__dirname, "..", "..", "..");
const NETWORK_POLICY_SCHEMA_PATH = path.join(PACKAGE_ROOT, "schemas", "network-policy.schema.json");
const SANDBOX_POLICY_SCHEMA_PATH = path.join(PACKAGE_ROOT, "schemas", "sandbox-policy.schema.json");
const BRAVE_INTEGRATION_NAME = "brave-search";
const V1_SLUG_PATTERN = "^[a-z][a-z0-9-]{0,39}$";

export function isV1Alpha1ExportName(value: unknown): value is string {
  return typeof value === "string" && new RegExp(V1_SLUG_PATTERN, "u").test(value);
}

/** The exact v1alpha1 subset emitted by the v0 exporter. */
export const V1Alpha1ExportSchema: AnySchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: V1ALPHA1_EXPORT_SCHEMA_ID,
  title: "NemoClaw v1alpha1 configuration export",
  type: "object",
  required: ["apiVersion", "kind", "metadata", "spec"],
  additionalProperties: false,
  properties: {
    apiVersion: { const: V1ALPHA1_EXPORT_API_VERSION },
    kind: { const: NEMOCLAW_CONFIG_KIND },
    metadata: {
      type: "object",
      required: ["name", "uid"],
      additionalProperties: false,
      properties: {
        name: {
          type: "string",
          minLength: 1,
          maxLength: 40,
          pattern: V1_SLUG_PATTERN,
        },
        uid: {
          type: "string",
          pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
        },
      },
    },
    spec: {
      type: "object",
      required: ["gateway", "inferenceProviders", "sandboxes"],
      additionalProperties: false,
      properties: {
        gateway: {
          type: "object",
          required: ["management", "endpoint"],
          additionalProperties: false,
          properties: {
            management: { const: "managed" },
            endpoint: { type: "string", pattern: "^http://127\\.0\\.0\\.1:[0-9]+$" },
          },
        },
        inferenceProviders: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["name", "provider", "api", "endpoint"],
            additionalProperties: false,
            properties: {
              name: { $ref: "#/$defs/name" },
              provider: { enum: ["openai", "anthropic"] },
              api: { enum: ["openai-completions", "openai-responses", "anthropic-messages"] },
              endpoint: { type: "string", maxLength: 2048, pattern: "^https?://[^\\s]+$" },
              credential: { $ref: "#/$defs/credential" },
            },
          },
        },
        sandboxes: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["name", "runtime", "network", "harness", "agents"],
            additionalProperties: false,
            properties: {
              name: { $ref: "#/$defs/name" },
              runtime: {
                type: "object",
                required: ["provider"],
                additionalProperties: false,
                properties: { provider: { const: "docker" } },
              },
              network: {
                type: "object",
                required: ["policy"],
                additionalProperties: false,
                properties: {
                  policy: {
                    type: "object",
                    required: ["explicit"],
                    additionalProperties: false,
                    properties: {
                      explicit: { $ref: NEMOCLAW_SANDBOX_POLICY_SCHEMA_ID },
                    },
                  },
                  proxy: {
                    type: "object",
                    required: ["host", "port"],
                    additionalProperties: false,
                    properties: {
                      host: { type: "string", minLength: 1, maxLength: 256 },
                      port: { type: "integer", minimum: 1, maximum: 65535 },
                    },
                  },
                },
              },
              harness: {
                type: "object",
                required: ["kind"],
                additionalProperties: false,
                properties: {
                  kind: { enum: ["openclaw", "hermes"] },
                  execution: NemoClawAgentExecutionSchema,
                  interfaces: {
                    anyOf: [NemoClawOpenClawInterfacesSchema, NemoClawHermesInterfacesSchema],
                  },
                  observability: NemoClawOpenClawObservabilitySchema,
                },
              },
              agents: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  required: ["name", "inference"],
                  additionalProperties: false,
                  properties: {
                    name: { $ref: "#/$defs/name" },
                    inference: {
                      type: "object",
                      required: ["routes"],
                      additionalProperties: false,
                      properties: {
                        routes: {
                          type: "array",
                          minItems: 1,
                          items: {
                            type: "object",
                            required: ["name", "providerRef", "overrides"],
                            additionalProperties: false,
                            properties: {
                              name: { $ref: "#/$defs/name" },
                              providerRef: { $ref: "#/$defs/name" },
                              overrides: {
                                type: "object",
                                required: ["model"],
                                additionalProperties: false,
                                properties: {
                                  model: {
                                    type: "string",
                                    pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$",
                                  },
                                  ...NemoClawInferenceTuningSchema.properties,
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                    auth: {
                      type: "object",
                      required: ["method"],
                      additionalProperties: false,
                      properties: { method: { const: "api-key" } },
                    },
                    tools: NemoClawAgentToolsConfigSchema,
                    integrationRefs: {
                      type: "array",
                      minItems: 1,
                      maxItems: 1,
                      items: { const: BRAVE_INTEGRATION_NAME },
                    },
                  },
                },
              },
              integrations: {
                type: "object",
                required: [BRAVE_INTEGRATION_NAME],
                additionalProperties: false,
                properties: {
                  [BRAVE_INTEGRATION_NAME]: {
                    type: "object",
                    required: ["kind", "provider", "credential"],
                    additionalProperties: false,
                    properties: {
                      kind: { const: "webSearch" },
                      provider: { const: "brave" },
                      credential: { $ref: "#/$defs/credential" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  $defs: {
    name: {
      type: "string",
      minLength: 1,
      maxLength: 40,
      pattern: V1_SLUG_PATTERN,
    },
    credential: {
      type: "object",
      required: ["env"],
      additionalProperties: false,
      properties: { env: { type: "string", pattern: "^[A-Z][A-Z0-9_]{0,127}$" } },
    },
  },
};

export interface V1Alpha1Export {
  readonly apiVersion: typeof V1ALPHA1_EXPORT_API_VERSION;
  readonly kind: typeof NEMOCLAW_CONFIG_KIND;
  readonly metadata: Readonly<{ name: string; uid: string }>;
  readonly spec: Readonly<{
    gateway: Readonly<{ management: "managed"; endpoint: string }>;
    inferenceProviders: readonly Readonly<{
      name: string;
      provider: "anthropic" | "openai";
      api: "anthropic-messages" | "openai-completions" | "openai-responses";
      endpoint: string;
      credential?: Readonly<{ env: string }>;
    }>[];
    sandboxes: readonly Readonly<{
      name: string;
      runtime: Readonly<{ provider: "docker" }>;
      network: Readonly<{
        policy: Readonly<{ explicit: Readonly<Record<string, unknown>> }>;
        proxy?: Readonly<{ host: string; port: number }>;
      }>;
      harness: Readonly<{
        kind: "hermes" | "openclaw";
        execution?: Readonly<{ timeoutSeconds?: number; heartbeatEvery?: string }>;
        interfaces?: Readonly<Record<string, unknown>>;
        observability?: Readonly<Record<string, unknown>>;
      }>;
      agents: readonly Readonly<{
        name: string;
        inference: Readonly<{
          routes: readonly Readonly<{
            name: string;
            providerRef: string;
            overrides: Readonly<Record<string, unknown> & { model: string }>;
          }>[];
        }>;
        auth?: Readonly<{ method: "api-key" }>;
        tools?:
          | Readonly<{ disclosure: "direct" | "progressive" }>
          | Readonly<{ allow: readonly "read"[] }>;
        integrationRefs?: readonly "brave-search"[];
      }>[];
      integrations?: Readonly<{
        "brave-search": Readonly<{
          kind: "webSearch";
          provider: "brave";
          credential: Readonly<{ env: string }>;
        }>;
      }>;
    }>[];
  }>;
}
declare const VALIDATED_V1ALPHA1_EXPORT: unique symbol;
export type ValidatedV1Alpha1Export = V1Alpha1Export & {
  readonly [VALIDATED_V1ALPHA1_EXPORT]: true;
};

let validator: ValidateFunction<V1Alpha1Export> | undefined;

function readSchema(file: string): AnySchemaObject {
  return JSON.parse(fs.readFileSync(file, "utf8")) as AnySchemaObject;
}

function exportValidator(): ValidateFunction<V1Alpha1Export> {
  if (validator) return validator;
  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.addSchema(readSchema(NETWORK_POLICY_SCHEMA_PATH));
  ajv.addSchema(readSchema(SANDBOX_POLICY_SCHEMA_PATH));
  validator = ajv.compile<V1Alpha1Export>(V1Alpha1ExportSchema);
  return validator;
}

type ExportProvider = V1Alpha1Export["spec"]["inferenceProviders"][number];
type ExportSandbox = V1Alpha1Export["spec"]["sandboxes"][number];
type ExportAgent = ExportSandbox["agents"][number];

function validateGateway(config: V1Alpha1Export, problems: string[]): void {
  const port = Number(new URL(config.spec.gateway.endpoint).port);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535)
    problems.push("managed gateway endpoint must use an unprivileged TCP port");
}

function validateProvider(provider: ExportProvider, problems: string[]): void {
  const expectedDriver = provider.api === "anthropic-messages" ? "anthropic" : "openai";
  if (provider.provider !== expectedDriver)
    problems.push("inference API must match its v1 provider driver");
  if (unsafeEndpointUrlViolation(provider.endpoint)) problems.push("inference endpoint is unsafe");
  if (provider.endpoint.startsWith("http:") && provider.credential)
    problems.push("inference credentials require HTTPS");
  if (provider.credential && !isCredentialEnvironmentReferenceName(provider.credential.env))
    problems.push("inference credential reference is invalid");
}

function validateProviders(
  config: V1Alpha1Export,
  problems: string[],
): Map<string, ExportProvider> {
  const providers = new Map<string, ExportProvider>();
  for (const provider of config.spec.inferenceProviders) {
    if (providers.has(provider.name)) problems.push("inference provider names must be unique");
    providers.set(provider.name, provider);
    validateProvider(provider, problems);
  }
  return providers;
}

function validatePolicy(sandbox: ExportSandbox, problems: string[]): void {
  const policy = sandbox.network.policy.explicit;
  if (!isSandboxPolicyCredentialFree(JSON.stringify(policy)))
    problems.push("explicit policy must be credential-free");
  const process = policy.process as Record<string, unknown> | undefined;
  if (process && (process.run_as_user !== "1000" || process.run_as_group !== "1000"))
    problems.push("v1 Fabric exports require the 1000:1000 process principal");
  const filesystem = policy.filesystem_policy as Record<string, unknown> | undefined;
  if (!filesystem) return;
  const readable = [filesystem.read_only, filesystem.read_write].filter(Array.isArray).flat();
  const agentRoot = sandbox.harness.kind === "openclaw" ? "/app" : "/opt/hermes";
  if (!["/opt/fabric", "/opt/nemoclaw", agentRoot].every((root) => readable.includes(root)))
    problems.push("explicit policy must grant the v1 Fabric runtime roots");
}

function validateAgentRoutes(
  agent: ExportAgent,
  providers: ReadonlyMap<string, ExportProvider>,
  problems: string[],
): void {
  const routeNames = new Set<string>();
  for (const route of agent.inference.routes) {
    if (routeNames.has(route.name)) problems.push("route names must be unique");
    routeNames.add(route.name);
    if (!providers.has(route.providerRef))
      problems.push("route providerRef must reference an inference provider");
  }
}

function validateAgent(
  agent: ExportAgent,
  sandbox: ExportSandbox,
  providers: ReadonlyMap<string, ExportProvider>,
  problems: string[],
): void {
  if (agent.auth && sandbox.harness.kind !== "hermes")
    problems.push("agent authentication requires Hermes");
  if (
    agent.auth &&
    !agent.inference.routes.every((route) => providers.get(route.providerRef)?.credential)
  )
    problems.push("Hermes authentication requires a routed provider credential");
  if (agent.tools && sandbox.harness.kind !== "openclaw")
    problems.push("agent tools require OpenClaw");
  validateAgentRoutes(agent, providers, problems);
  if (agent.integrationRefs && !sandbox.integrations?.[BRAVE_INTEGRATION_NAME])
    problems.push("integrationRefs must reference a sandbox integration");
}

function validateSandbox(
  sandbox: ExportSandbox,
  providers: ReadonlyMap<string, ExportProvider>,
  problems: string[],
): void {
  validatePolicy(sandbox, problems);
  if (sandbox.harness.kind === "hermes" && sandbox.harness.execution)
    problems.push("harness execution settings require OpenClaw");
  if (sandbox.harness.kind === "hermes" && sandbox.harness.observability)
    problems.push("harness observability settings require OpenClaw");
  const agents = new Set<string>();
  for (const agent of sandbox.agents) {
    if (agents.has(agent.name)) problems.push("agent names must be unique");
    agents.add(agent.name);
    validateAgent(agent, sandbox, providers, problems);
  }
}

function semanticProblems(config: V1Alpha1Export): string[] {
  const problems: string[] = [];
  validateGateway(config, problems);
  const providers = validateProviders(config, problems);
  const sandboxNames = new Set<string>();
  for (const sandbox of config.spec.sandboxes) {
    if (sandboxNames.has(sandbox.name)) problems.push("sandbox names must be unique");
    sandboxNames.add(sandbox.name);
    validateSandbox(sandbox, providers, problems);
  }
  return problems;
}

/** Validate, own, and freeze one export document before publication. */
export function validateV1Alpha1Export(value: unknown): ValidatedV1Alpha1Export {
  let candidate: unknown;
  try {
    candidate = structuredClone(value);
    const wireCopy = JSON.parse(JSON.stringify(candidate)) as unknown;
    if (!isDeepStrictEqual(candidate, wireCopy)) throw new TypeError("not exact JSON data");
    candidate = deepFreezeJson(wireCopy);
  } catch {
    throw new Error("Invalid v1alpha1 export: document must contain exact plain JSON data");
  }
  const validate = exportValidator();
  if (!validate(candidate))
    throw new Error("Invalid v1alpha1 export: structural validation failed");
  const problems = semanticProblems(candidate);
  if (problems.length > 0) throw new Error(`Invalid v1alpha1 export: ${problems.join("; ")}`);
  return candidate as ValidatedV1Alpha1Export;
}

function deepFreezeJson(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  for (const child of Object.values(value)) deepFreezeJson(child);
  return Object.freeze(value);
}
