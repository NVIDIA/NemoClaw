// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import Ajv, {
  type AnySchemaObject,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import YAML from "yaml";
import { unsafeEndpointUrlViolation } from "../core/endpoint-url-safety";
import { cloneAndDeepFreeze } from "../core/immutable";
import { isSandboxPolicyCredentialFree } from "../policy/sandbox-policy-validation";
import {
  isCredentialEnvironmentReferenceName,
  EXPORTED_VLLM_CONTEXT_WINDOW,
  NemoClawConfigSchema,
  type NemoClawConfig,
  type NemoClawInferenceProviderConfig,
  type NemoClawSandboxConfig,
  type ValidatedNemoClawConfig,
} from "./model";

const PACKAGE_ROOT = path.resolve(__dirname, "..", "..", "..");
const HERMES_API_KEY_ENDPOINT = "https://inference-api.nousresearch.com/v1";
const NETWORK_POLICY_SCHEMA_PATH = path.join(PACKAGE_ROOT, "schemas", "network-policy.schema.json");
const SANDBOX_POLICY_SCHEMA_PATH = path.join(PACKAGE_ROOT, "schemas", "sandbox-policy.schema.json");
let validator: ValidateFunction<NemoClawConfig> | undefined;

export class NemoClawConfigValidationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid NemoClawConfig: ${problems.join("; ")}`);
    this.name = "NemoClawConfigValidationError";
  }
}

function readSchema(file: string): AnySchemaObject {
  return JSON.parse(fs.readFileSync(file, "utf8")) as AnySchemaObject;
}

function configValidator(): ValidateFunction<NemoClawConfig> {
  if (validator) return validator;
  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.addSchema(readSchema(NETWORK_POLICY_SCHEMA_PATH));
  ajv.addSchema(readSchema(SANDBOX_POLICY_SCHEMA_PATH));
  validator = ajv.compile<NemoClawConfig>(NemoClawConfigSchema);
  return validator;
}

function schemaProblems(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).slice(0, 20).map((error) => {
    const message = (error.message ?? "validation failed")
      .replace(/[\r\n\t]+/gu, " ")
      .slice(0, 160);
    return `${error.keyword}: ${message}`;
  });
}

function duplicateProblems(values: readonly string[], location: string): string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) (seen.has(value) ? duplicate : seen).add(value);
  return [...duplicate].sort().map(() => `${location} contains a duplicate name`);
}

function agentAuthProblems(
  agent: NemoClawSandboxConfig["agents"][number],
  location: string,
  providers: ReadonlyMap<string, NemoClawInferenceProviderConfig>,
): string[] {
  const auth = agent.auth;
  if (!auth) return [];
  const problems: string[] = [];
  const provider = providers.get(auth.providerRef);
  if (agent.type !== "hermes") problems.push(`${location} is supported only for a Hermes agent`);
  if (!agent.inference.routes.some((route) => route.providerRef === auth.providerRef))
    problems.push(`${location}/providerRef must match an inference route for this agent`);
  if (
    !provider ||
    "serving" in provider ||
    !isDeepStrictEqual(
      [provider.provider, provider.api, provider.endpoint, provider.credential?.env],
      ["hermes-provider", "openai-completions", HERMES_API_KEY_ENDPOINT, "NOUS_API_KEY"],
    )
  )
    problems.push(`${location}/providerRef must reference the managed Nous API-key provider`);
  return problems;
}

function sandboxProblems(
  sandbox: NemoClawSandboxConfig,
  sandboxIndex: number,
  providers: ReadonlyMap<string, NemoClawInferenceProviderConfig>,
): string[] {
  const problems: string[] = [];
  if (!isSandboxPolicyCredentialFree(YAML.stringify(sandbox.network.policy.explicit))) {
    problems.push(
      `/spec/sandboxes/${sandboxIndex}/network/policy/explicit must be credential-free`,
    );
  }
  problems.push(
    ...duplicateProblems(
      sandbox.agents.map(({ name }) => name),
      `/spec/sandboxes/${sandboxIndex}/agents`,
    ),
  );
  for (const [agentIndex, agent] of sandbox.agents.entries()) {
    if (agent.type === "hermes" && "execution" in agent) {
      problems.push(
        `/spec/sandboxes/${sandboxIndex}/agents/${agentIndex}/execution is supported only for OpenClaw agents`,
      );
    }
    problems.push(
      ...duplicateProblems(
        agent.inference.routes.map(({ name }) => name),
        `/spec/sandboxes/${sandboxIndex}/agents/${agentIndex}/inference/routes`,
      ),
    );
    for (const [routeIndex, route] of agent.inference.routes.entries()) {
      if (!providers.has(route.providerRef))
        problems.push(
          `/spec/sandboxes/${sandboxIndex}/agents/${agentIndex}/inference/routes/${routeIndex}/providerRef does not match an inference provider`,
        );
    }
    problems.push(
      ...agentAuthProblems(
        agent,
        `/spec/sandboxes/${sandboxIndex}/agents/${agentIndex}/auth`,
        providers,
      ),
    );
  }
  problems.push(...webSearchProblems(sandbox, sandboxIndex));
  return problems;
}

function webSearchProblems(sandbox: NemoClawSandboxConfig, sandboxIndex: number): string[] {
  const problems: string[] = [];
  const search = sandbox.integrations?.webSearch;
  if (search) {
    const location = `/spec/sandboxes/${sandboxIndex}/integrations/webSearch`;
    if (
      !isCredentialEnvironmentReferenceName(search.credential.env) ||
      search.credential.env !== "BRAVE_API_KEY"
    ) {
      problems.push(`${location}/credential/env must reference the Brave credential`);
    }
    if (
      !search.agentRefs.every((name) =>
        sandbox.agents.some((agent) => agent.name === name && agent.type === "openclaw"),
      )
    ) {
      problems.push(`${location}/agentRefs must reference an OpenClaw agent in this sandbox`);
    }
  }
  return problems;
}

function managedProviderProblems(
  config: NemoClawConfig,
  provider: Extract<NemoClawInferenceProviderConfig, { serving: unknown }>,
  providerIndex: number,
): string[] {
  const matches = config.spec.sandboxes.every((sandbox) =>
    sandbox.agents.every((agent) =>
      agent.inference.routes.every(
        (route) =>
          route.providerRef !== provider.name ||
          isDeepStrictEqual(
            [sandbox.runtime.provider, route.overrides.model, route.overrides.contextWindow],
            ["docker", provider.serving.model.servedName, EXPORTED_VLLM_CONTEXT_WINDOW],
          ),
      ),
    ),
  );
  return matches
    ? []
    : [
        `/spec/inferenceProviders/${providerIndex}/serving does not match the sandbox runtime or route model`,
      ];
}

function semanticProblems(config: NemoClawConfig): string[] {
  const problems = [
    ...duplicateProblems(
      config.spec.inferenceProviders.map(({ name }) => name),
      "/spec/inferenceProviders",
    ),
    ...duplicateProblems(
      config.spec.sandboxes.map(({ name }) => name),
      "/spec/sandboxes",
    ),
  ];
  const providers = new Map(
    config.spec.inferenceProviders.map((provider) => [provider.name, provider]),
  );
  for (const [providerIndex, provider] of config.spec.inferenceProviders.entries()) {
    if ("serving" in provider) {
      problems.push(...managedProviderProblems(config, provider, providerIndex));
      continue;
    }
    const endpointViolation = unsafeEndpointUrlViolation(provider.endpoint);
    if (endpointViolation)
      problems.push(
        `/spec/inferenceProviders/${providerIndex}/endpoint ${endpointViolation.reason}`,
      );
    if (provider.credential && !isCredentialEnvironmentReferenceName(provider.credential.env))
      problems.push(
        `/spec/inferenceProviders/${providerIndex}/credential/env is not an allowed credential reference`,
      );
  }
  for (const [sandboxIndex, sandbox] of config.spec.sandboxes.entries()) {
    problems.push(...sandboxProblems(sandbox, sandboxIndex, providers));
  }
  return problems;
}

/** Validate, own, and freeze one untrusted v1 wire document. */
export function validateNemoClawConfig(value: unknown): ValidatedNemoClawConfig {
  let candidate: unknown;
  try {
    candidate = cloneAndDeepFreeze(value);
    const wireCopy = JSON.parse(JSON.stringify(candidate)) as unknown;
    if (!isDeepStrictEqual(candidate, wireCopy)) throw new TypeError("not exact JSON data");
  } catch {
    throw new NemoClawConfigValidationError(["/ must contain exact plain JSON data"]);
  }
  const validate = configValidator();
  if (!validate(candidate))
    throw new NemoClawConfigValidationError(schemaProblems(validate.errors));
  const problems = semanticProblems(candidate);
  if (problems.length > 0) throw new NemoClawConfigValidationError(problems);
  return candidate as ValidatedNemoClawConfig;
}
