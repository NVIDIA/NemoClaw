// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import YAML from "yaml";
import { sortCanonicalMappings } from "../../config/canonical-mapping";
import { isSandboxPolicyCredentialFree } from "../../policy/sandbox-policy-validation";
import type { SandboxConfiguration } from "../../domain/sandbox/configuration";
import type { OpenShellSandboxPolicyRead } from "./sandbox-policy";
import {
  PolicyJsonSchema,
  SandboxConfigResponseSchema,
  type PolicyEndpointJson,
  type PolicyMatcherJson,
} from "./sdk-read-schema";
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
  serializePolicy: (policy: unknown, signal?: AbortSignal) => Promise<string> = serializeSdkPolicy,
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
        request.signal.throwIfAborted();
        const document = await serializePolicy(config.policy, request.signal);
        request.signal.throwIfAborted();
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
            document,
            appliedRevision:
              config.policySource === 2 && config.globalPolicyVersion > 0
                ? config.globalPolicyVersion
                : config.version,
          },
        });
      }),
  };
}

type PolicyDocument = Record<string, unknown>;
type ParameterMatcher = string | { any: string[] };
type ParameterTree = { [key: string]: ParameterMatcher | ParameterTree };

function rejectUnknownWireFields(value: unknown): void {
  if (!value || typeof value !== "object") return;
  if ("$unknown" in value && (!Array.isArray(value.$unknown) || value.$unknown.length > 0)) {
    throw new OpenShellReadError("schema");
  }
  for (const child of Object.values(value)) rejectUnknownWireFields(child);
}

function matchers(value: PolicyMatcherJson["params"]): Record<string, ParameterMatcher> {
  return Object.fromEntries(
    Object.entries(value ?? {}).map(([key, matcher]) => [
      key,
      matcher.any?.length ? { any: matcher.any } : (matcher.glob ?? ""),
    ]),
  );
}

function nestedParams(flat: Record<string, ParameterMatcher>): ParameterTree {
  const root: ParameterTree = Object.create(null);
  const branches = new WeakMap<ParameterTree, Map<string, ParameterTree>>();
  for (const key of Object.keys(flat).sort()) {
    const parts = key.split(".");
    let parent = root;
    for (let index = 0; index < parts.length - 1; index++) {
      const part = parts[index];
      const siblings = branches.get(parent) ?? new Map<string, ParameterTree>();
      if (Object.hasOwn(parent, part) && !siblings.has(part)) return flat;
      const child: ParameterTree = siblings.get(part) ?? Object.create(null);
      parent[part] = child;
      siblings.set(part, child);
      branches.set(parent, siblings);
      parent = child;
    }
    parent[parts[parts.length - 1]] = flat[key];
  }
  return root;
}

function omittedMcpMethod(
  method: PolicyMatcherJson["method"],
  hasTool: boolean,
  allowKnownMethods: boolean,
): boolean {
  return hasTool ? allowKnownMethods && method === "tools/call" : method === "*";
}

function convertMatcher(
  value: PolicyMatcherJson,
  mcp: boolean,
  allowKnownMethods: boolean,
): PolicyDocument {
  const result: PolicyDocument = { ...value };
  if (value.query) result.query = matchers(value.query);
  const params = matchers(value.params);
  if (mcp && Object.hasOwn(params, "name")) {
    result.tool = params.name;
    delete params.name;
  }
  if (Object.keys(params).length) result.params = mcp ? nestedParams(params) : params;
  else delete result.params;
  if (mcp && omittedMcpMethod(value.method, Object.hasOwn(result, "tool"), allowKnownMethods))
    delete result.method;
  return result;
}

function compactEndpointPorts(endpoint: PolicyDocument, ports: PolicyEndpointJson["ports"]): void {
  if (ports?.length) {
    if (ports.length === 1) {
      endpoint.port = ports[0];
      delete endpoint.ports;
    } else delete endpoint.port;
  }
}

function convertEndpoint(value: PolicyEndpointJson): PolicyDocument {
  const endpoint: PolicyDocument = { ...value };
  const mcp = value.protocol?.toLowerCase() === "mcp";
  const options: NonNullable<PolicyEndpointJson["mcp"]> & { max_body_bytes?: number } = {
    ...value.mcp,
  };
  const allowKnownMethods = options.allow_all_known_mcp_methods === true;
  compactEndpointPorts(endpoint, value.ports);
  if (value.json_rpc_max_body_bytes) options.max_body_bytes = value.json_rpc_max_body_bytes;
  delete endpoint.json_rpc_max_body_bytes;
  delete endpoint.mcp;
  if (mcp && Object.keys(options).length) endpoint.mcp = options;
  else if (!mcp && options.max_body_bytes)
    endpoint.json_rpc = { max_body_bytes: options.max_body_bytes };
  if (value.rules) {
    endpoint.rules = value.rules.map((rule) => ({
      allow: convertMatcher(rule.allow ?? {}, mcp, allowKnownMethods),
    }));
  }
  if (value.deny_rules) {
    endpoint.deny_rules = value.deny_rules.map((rule) =>
      convertMatcher(rule, mcp, allowKnownMethods),
    );
  }
  return endpoint;
}

/** Convert released protobuf JSON to the document shape owned by openshell-policy. */
export function sdkPolicyDocument(value: unknown): PolicyDocument {
  const input = readValue(PolicyJsonSchema, value);
  const policy: PolicyDocument = { ...input, version: input.version ?? 0 };
  if (input.filesystem) {
    policy.filesystem_policy = { include_workdir: false, ...input.filesystem };
    delete policy.filesystem;
  }
  if (input.process && Object.keys(input.process).length === 0) delete policy.process;
  if (input.network_policies) {
    policy.network_policies = Object.fromEntries(
      Object.entries(input.network_policies).map(([name, value]) => {
        const rule: PolicyDocument = { ...value };
        if (value.endpoints) rule.endpoints = value.endpoints.map(convertEndpoint);
        if (value.binaries)
          rule.binaries = value.binaries.map((binary) => ({ path: binary.path ?? "" }));
        return [name, rule];
      }),
    );
  }
  return policy;
}

const MAX_POLICY_BYTES = 1024 * 1024;

/** Keep generated messages and optional SDK dependencies inside the adapter. */
export async function serializeSdkPolicy(policy: unknown, signal?: AbortSignal): Promise<string> {
  try {
    signal?.throwIfAborted();
    const sdkPackage = "@nvidia/openshell-sdk/raw";
    const protobufPackage = "@bufbuild/protobuf";
    const [{ SandboxPolicySchema }, { isMessage, toBinary, toJson }] = await Promise.all([
      import(sdkPackage),
      import(protobufPackage),
    ]);
    signal?.throwIfAborted();
    if (!isMessage(policy, SandboxPolicySchema)) throw new OpenShellReadError("schema");
    if (toBinary(SandboxPolicySchema, policy).byteLength > MAX_POLICY_BYTES) {
      throw new OpenShellReadError("schema");
    }
    rejectUnknownWireFields(policy);
    const document = YAML.stringify(
      sortCanonicalMappings(
        sdkPolicyDocument(toJson(SandboxPolicySchema, policy, { useProtoFieldName: true })),
      ),
    );
    if (
      Buffer.byteLength(document, "utf8") > MAX_POLICY_BYTES ||
      !isSandboxPolicyCredentialFree(document)
    ) {
      throw new OpenShellReadError("schema");
    }
    return document;
  } catch {
    throw new OpenShellReadError(signal?.aborted ? "timeout" : "schema");
  }
}
