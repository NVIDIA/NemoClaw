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
import { unsafeEndpointUrlViolation } from "../core/endpoint-contract";
import { cloneAndDeepFreeze } from "../core/immutable";
import { isSandboxPolicyCredentialFree } from "../policy/sandbox-policy-validation";
import {
  NEMOCLAW_INFERENCE_ENDPOINT_MAX_LENGTH,
  NEMOCLAW_INFERENCE_ENDPOINT_PATTERN,
  NemoClawConfigSchema,
  type NemoClawConfig,
  type ValidatedNemoClawConfig,
} from "./model";

const PACKAGE_ROOT = path.resolve(__dirname, "..", "..", "..");
const NETWORK_POLICY_SCHEMA_PATH = path.join(PACKAGE_ROOT, "schemas", "network-policy.schema.json");
const SANDBOX_POLICY_SCHEMA_PATH = path.join(PACKAGE_ROOT, "schemas", "sandbox-policy.schema.json");
const FORBIDDEN_CREDENTIAL_NAMES = new Set([
  "CI",
  "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
  "NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE",
  "NEMOCLAW_RECREATE_WITHOUT_BACKUP",
]);
const FORBIDDEN_CREDENTIAL_PREFIXES = ["DSH_", "NEMOCLAW_", "OPENSHELL_", "VITEST_"] as const;
let validator: ValidateFunction<NemoClawConfig> | undefined;
const INFERENCE_ENDPOINT_RE = new RegExp(NEMOCLAW_INFERENCE_ENDPOINT_PATTERN, "u");

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

export function isCredentialEnvironmentReferenceName(value: string): boolean {
  return (
    /^[A-Z][A-Z0-9_]{0,127}$/u.test(value) &&
    !FORBIDDEN_CREDENTIAL_NAMES.has(value) &&
    !FORBIDDEN_CREDENTIAL_PREFIXES.some((prefix) => value.startsWith(prefix))
  );
}

/** True when a value satisfies the complete v1 inference endpoint contract. */
export function isValidNemoClawInferenceEndpoint(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= NEMOCLAW_INFERENCE_ENDPOINT_MAX_LENGTH &&
    INFERENCE_ENDPOINT_RE.test(value) &&
    unsafeEndpointUrlViolation(value) === null
  );
}

function duplicateProblems(values: readonly string[], location: string): string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) (seen.has(value) ? duplicate : seen).add(value);
  return [...duplicate].sort().map(() => `${location} contains a duplicate name`);
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
  const providers = new Set(config.spec.inferenceProviders.map(({ name }) => name));
  for (const [providerIndex, provider] of config.spec.inferenceProviders.entries()) {
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
    }
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
