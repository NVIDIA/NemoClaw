// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import Ajv, {
  type AnySchemaObject,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import type { NemoClawConfig } from "./model";

const PACKAGE_ROOT = path.resolve(__dirname, "..", "..", "..");
const CONFIG_SCHEMA_PATH = path.join(PACKAGE_ROOT, "schemas", "nemoclaw-config-v1.schema.json");
const NETWORK_POLICY_SCHEMA_PATH = path.join(PACKAGE_ROOT, "schemas", "network-policy.schema.json");
const SANDBOX_POLICY_SCHEMA_PATH = path.join(PACKAGE_ROOT, "schemas", "sandbox-policy.schema.json");
const FORBIDDEN_CREDENTIAL_NAMES = new Set([
  "CI",
  "NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE",
  "NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE",
  "NEMOCLAW_RECREATE_WITHOUT_BACKUP",
]);
const FORBIDDEN_CREDENTIAL_PREFIXES = ["DSH_", "NEMOCLAW_", "OPENSHELL_", "VITEST_"] as const;
let validator: ValidateFunction<unknown> | undefined;

export class NemoClawConfigValidationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid NemoClawConfig: ${problems.join("; ")}`);
    this.name = "NemoClawConfigValidationError";
  }
}

function readSchema(file: string): AnySchemaObject {
  return JSON.parse(fs.readFileSync(file, "utf8")) as AnySchemaObject;
}

function configValidator(): ValidateFunction<unknown> {
  if (validator) return validator;
  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.addSchema(readSchema(NETWORK_POLICY_SCHEMA_PATH));
  ajv.addSchema(readSchema(SANDBOX_POLICY_SCHEMA_PATH));
  validator = ajv.compile(readSchema(CONFIG_SCHEMA_PATH));
  return validator;
}

function schemaProblems(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? [])
    .slice(0, 20)
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`);
}

export function isCredentialEnvironmentReferenceName(value: string): boolean {
  return (
    /^[A-Z][A-Z0-9_]{0,127}$/u.test(value) &&
    !FORBIDDEN_CREDENTIAL_NAMES.has(value) &&
    !FORBIDDEN_CREDENTIAL_PREFIXES.some((prefix) => value.startsWith(prefix))
  );
}

function duplicateProblems(values: readonly string[], location: string): string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) (seen.has(value) ? duplicate : seen).add(value);
  return [...duplicate].sort().map((value) => `${location} contains duplicate name '${value}'`);
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
    if (provider.credential && !isCredentialEnvironmentReferenceName(provider.credential.env))
      problems.push(
        `/spec/inferenceProviders/${providerIndex}/credential/env is not an allowed credential reference`,
      );
  }
  for (const [sandboxIndex, sandbox] of config.spec.sandboxes.entries()) {
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

export function validateNemoClawConfig(value: unknown): NemoClawConfig {
  const validate = configValidator();
  if (!validate(value)) throw new NemoClawConfigValidationError(schemaProblems(validate.errors));
  const config = value as NemoClawConfig;
  const problems = semanticProblems(config);
  if (problems.length > 0) throw new NemoClawConfigValidationError(problems);
  return config;
}
