// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";
import { sortCanonicalMappings } from "../../config/canonical-mapping";
import { isSandboxPolicyCredentialFree } from "../../policy/sandbox-policy-validation";
import type { SandboxConfiguration } from "../../domain/sandbox/configuration";
import type { OpenShellSandboxPolicyRead } from "./sandbox-policy";
import { SandboxConfigResponseSchema } from "./sdk-read-schema";
import {
  connectOpenShellReader,
  OpenShellReadError,
  owned,
  readOpenShell,
  readValue,
  text,
  type ConnectOpenShellReader,
  type ReadRequest,
} from "./sdk-read";

/** Read configuration identity and its effective policy in the same gateway response. */
export function createSandboxConfig(
  connect: ConnectOpenShellReader = connectOpenShellReader,
  serializePolicy: (policy: unknown) => Promise<string> = serializeSdkPolicy,
) {
  return {
    get: (
      request: ReadRequest & Readonly<{ sandboxId: string }>,
    ): Promise<SandboxConfiguration & { readonly policy: OpenShellSandboxPolicyRead }> =>
      readOpenShell(request, async () => {
        const sandboxId = text(request.sandboxId);
        const client = await connect(request.target);
        request.signal.throwIfAborted();
        // sandbox.getConfig(name) performs a new name lookup and omits workspace identity.
        const config = readValue(
          SandboxConfigResponseSchema,
          await client.raw.getSandboxConfig({ sandboxId }, { signal: request.signal }),
        );
        if (config.workspace !== request.workspace) {
          throw new OpenShellReadError("schema");
        }
        return owned({
          sandboxId,
          workspace: request.workspace,
          revision: config.version,
          policyHash: config.policyHash,
          configRevision: String(config.configRevision),
          providerEnvRevision: String(config.providerEnvRevision),
          policySource: config.policySource === 1 ? "sandbox" : "global",
          globalPolicyVersion: config.globalPolicyVersion,
          policy: {
            document: await serializePolicy(config.policy),
            appliedRevision:
              config.policySource === 2 && config.globalPolicyVersion > 0
                ? config.globalPolicyVersion
                : config.version,
          },
        });
      }),
  };
}

type Value = string | number | boolean | null | Value[] | Mapping;
type Mapping = { [key: string]: Value };

function mapping(value: unknown): Mapping {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OpenShellReadError("schema");
  }
  return value as Mapping;
}

function rejectUnknownWireFields(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if ("$unknown" in value && (!Array.isArray(value.$unknown) || value.$unknown.length > 0)) {
    throw new OpenShellReadError("schema");
  }
  for (const child of Object.values(value)) rejectUnknownWireFields(child);
}

function matchers(value: Value | undefined): Mapping {
  return Object.fromEntries(
    Object.entries(mapping(value ?? {})).map(([key, value]) => {
      const matcher = mapping(value);
      return [
        key,
        Array.isArray(matcher.any) && matcher.any.length
          ? { any: matcher.any }
          : (matcher.glob ?? ""),
      ];
    }),
  );
}

function nestedParams(flat: Mapping): Mapping {
  const root: Mapping = Object.create(null);
  const leaves = new Set<string>();
  for (const key of Object.keys(flat).sort()) {
    const parts = key.split(".");
    let parent = root;
    for (let index = 0; index < parts.length - 1; index++) {
      if (leaves.has(parts.slice(0, index + 1).join("."))) return flat;
      const part = parts[index];
      if (!Object.hasOwn(parent, part)) parent[part] = Object.create(null);
      parent = mapping(parent[part]);
    }
    parent[parts.at(-1)!] = flat[key];
    leaves.add(key);
  }
  return root;
}

function omittedMcpMethod(rule: Mapping, allowKnownMethods: boolean): boolean {
  return Object.hasOwn(rule, "tool")
    ? allowKnownMethods && rule.method === "tools/call"
    : rule.method === "*";
}

function convertMatcher(value: Value, mcp: boolean, allowKnownMethods: boolean): Mapping {
  const result = { ...mapping(value) };
  if (result.query) result.query = matchers(result.query);
  const params = matchers(result.params);
  if (mcp && Object.hasOwn(params, "name")) {
    result.tool = params.name;
    delete params.name;
  }
  if (Object.keys(params).length) result.params = mcp ? nestedParams(params) : params;
  else delete result.params;
  if (mcp && omittedMcpMethod(result, allowKnownMethods)) delete result.method;
  return result;
}

function compactEndpointPorts(endpoint: Mapping): void {
  if (Array.isArray(endpoint.ports) && endpoint.ports.length) {
    if (endpoint.ports.length === 1) {
      endpoint.port = endpoint.ports[0];
      delete endpoint.ports;
    } else delete endpoint.port;
  }
}

function convertEndpoint(value: Value): Mapping {
  const endpoint = { ...mapping(value) };
  const mcp = typeof endpoint.protocol === "string" && endpoint.protocol.toLowerCase() === "mcp";
  const options = mapping(endpoint.mcp ?? {});
  const allowKnownMethods = options.allow_all_known_mcp_methods === true;
  compactEndpointPorts(endpoint);
  if (endpoint.json_rpc_max_body_bytes) options.max_body_bytes = endpoint.json_rpc_max_body_bytes;
  delete endpoint.json_rpc_max_body_bytes;
  delete endpoint.mcp;
  if (mcp && Object.keys(options).length) endpoint.mcp = options;
  else if (!mcp && options.max_body_bytes)
    endpoint.json_rpc = { max_body_bytes: options.max_body_bytes };
  if (Array.isArray(endpoint.rules)) {
    endpoint.rules = endpoint.rules.map((rule) => ({
      allow: convertMatcher(mapping(rule).allow ?? {}, mcp, allowKnownMethods),
    }));
  }
  if (Array.isArray(endpoint.deny_rules)) {
    endpoint.deny_rules = endpoint.deny_rules.map((rule) =>
      convertMatcher(rule, mcp, allowKnownMethods),
    );
  }
  return endpoint;
}

/** Convert released protobuf JSON to the document shape owned by openshell-policy. */
export function sdkPolicyDocument(value: unknown): Mapping {
  const policy = { ...mapping(value) };
  policy.version ??= 0;
  if (policy.filesystem) {
    policy.filesystem_policy = { include_workdir: false, ...mapping(policy.filesystem) };
    delete policy.filesystem;
  }
  if (policy.process && Object.keys(mapping(policy.process)).length === 0) delete policy.process;
  if (policy.network_policies) {
    policy.network_policies = Object.fromEntries(
      Object.entries(mapping(policy.network_policies)).map(([name, value]) => {
        const rule = { ...mapping(value) };
        if (Array.isArray(rule.endpoints)) rule.endpoints = rule.endpoints.map(convertEndpoint);
        if (Array.isArray(rule.binaries))
          rule.binaries = rule.binaries.map((binary) => ({ path: mapping(binary).path ?? "" }));
        return [name, rule];
      }),
    );
  }
  return policy;
}

/** Keep generated messages and optional SDK dependencies inside the adapter. */
export async function serializeSdkPolicy(policy: unknown): Promise<string> {
  try {
    const sdkPackage = "@nvidia/openshell-sdk/raw";
    const protobufPackage = "@bufbuild/protobuf";
    const [{ SandboxPolicySchema }, { isMessage, toJson }] = await Promise.all([
      import(sdkPackage),
      import(protobufPackage),
    ]);
    if (!isMessage(policy, SandboxPolicySchema)) throw new OpenShellReadError("schema");
    rejectUnknownWireFields(policy);
    const document = YAML.stringify(
      sortCanonicalMappings(
        sdkPolicyDocument(toJson(SandboxPolicySchema, policy, { useProtoFieldName: true })),
      ),
    );
    if (!isSandboxPolicyCredentialFree(document)) throw new OpenShellReadError("schema");
    return document;
  } catch {
    throw new OpenShellReadError("schema");
  }
}
