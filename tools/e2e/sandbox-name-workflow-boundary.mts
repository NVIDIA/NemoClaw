// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as sandboxNameContractModule from "../../nemoclaw/dist/shared/sandbox-name.cjs";

const sandboxNameContract = (
  "default" in sandboxNameContractModule && sandboxNameContractModule.default
    ? sandboxNameContractModule.default
    : sandboxNameContractModule
) as typeof import("../../nemoclaw/dist/shared/sandbox-name.cjs");
const { NAME_ALLOWED_FORMAT, isValidName } = sandboxNameContract;

type WorkflowRecord = Record<string, unknown>;

const SANDBOX_IDENTITY_ENV_NAMES = new Set([
  "NEMOCLAW_GATEWAY_UPGRADE_SURVIVOR_NAME",
  "NEMOCLAW_SANDBOX_NAME",
]);
const MATRIX_EXPRESSION = /\$\{\{\s*matrix\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu;

function record(value: unknown): WorkflowRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as WorkflowRecord)
    : {};
}

function matrixRows(job: WorkflowRecord): WorkflowRecord[] {
  const matrix = record(record(job.strategy).matrix);
  const include = Array.isArray(matrix.include) ? matrix.include.map(record) : [];
  if (include.length > 0) return include;

  const axes = Object.entries(matrix).filter(
    ([name, values]) => name !== "exclude" && Array.isArray(values),
  ) as Array<[string, unknown[]]>;
  return axes.reduce<WorkflowRecord[]>(
    (rows, [name, values]) =>
      rows.flatMap((row) => values.map((value) => ({ ...row, [name]: value }))),
    [{}],
  );
}

function sandboxEnvBindings(job: WorkflowRecord): Array<[string, unknown]> {
  const bindings: Array<[string, unknown]> = [];
  const collect = (scope: string, envValue: unknown) => {
    for (const [name, value] of Object.entries(record(envValue))) {
      if (SANDBOX_IDENTITY_ENV_NAMES.has(name)) bindings.push([`${scope}.${name}`, value]);
    }
  };

  collect("env", job.env);
  const steps = Array.isArray(job.steps) ? job.steps.map(record) : [];
  steps.forEach((step, index) => collect(`steps[${index}].env`, step.env));
  return bindings;
}

function resolveMatrixTemplate(template: string, row: WorkflowRecord): string {
  return template.replace(MATRIX_EXPRESSION, (_expression, name: string) => {
    const value = row[name];
    return typeof value === "string" || typeof value === "number" ? String(value) : "";
  });
}

export type WorkflowSandboxIdentity = {
  job: string;
  location: string;
  name: string;
};

export function resolveWorkflowSandboxIdentities(
  workflowValue: unknown,
): WorkflowSandboxIdentity[] {
  const workflow = record(workflowValue);
  const identities: WorkflowSandboxIdentity[] = [];
  for (const [jobName, jobValue] of Object.entries(record(workflow.jobs))) {
    const job = record(jobValue);
    for (const [location, rawTemplate] of sandboxEnvBindings(job)) {
      const template = typeof rawTemplate === "string" ? rawTemplate : "";
      const rows = matrixRows(job);
      rows.forEach((row, rowIndex) => {
        identities.push({
          job: jobName,
          location: rows.length > 1 ? `${location}.matrix[${rowIndex}]` : location,
          name: resolveMatrixTemplate(template, row),
        });
      });
    }
  }
  return identities;
}

export function validateWorkflowSandboxNames(workflowValue: unknown): string[] {
  const identities = resolveWorkflowSandboxIdentities(workflowValue);
  const errors: string[] = [];

  for (const identity of identities) {
    const owner = `${identity.job}.${identity.location}`;
    if (!isValidName(identity.name)) {
      errors.push(
        `${owner} resolves to invalid sandbox name ${JSON.stringify(identity.name)}; expected ${NAME_ALLOWED_FORMAT}`,
      );
    }
  }
  return errors;
}
