// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { redactString } from "../scenarios/orchestrators/redaction.ts";

const SENSITIVE_NAME_PATTERN = /(api[_-]?key|token|secret|password|credential)/i;
const EXPLICIT_SECRET_REDACTION = "[REDACTED]";

/**
 * Bridge-only fixture secret helper.
 *
 * The Vitest fixture layer still needs a small SecretStore while the scenario
 * runner migration is in flight; #4989 tracks consolidating it into shared E2E
 * framework infra. Canonical secret-shaped token matching belongs to
 * scenarios/orchestrators/redaction.ts. Keep explicit fixture secret-value
 * replacement here and always layer the parity-tested framework redactor
 * underneath it so this path does not become a second pattern source.
 */

export function redactText(text: string, secretValues: Iterable<string>): string {
  let redacted = text;
  for (const value of secretValues) {
    if (!value) continue;
    redacted = redacted.split(value).join(EXPLICIT_SECRET_REDACTION);
  }
  return redactString(redacted);
}

export class SecretStore {
  private readonly env: NodeJS.ProcessEnv;
  private readonly skip: (note?: string) => never;

  constructor(env: NodeJS.ProcessEnv, skip: (note?: string) => never) {
    this.env = env;
    this.skip = skip;
  }

  optional(name: string): string | undefined {
    const value = this.env[name];
    return value && value.length > 0 ? value : undefined;
  }

  required(name: string): string {
    const value = this.optional(name);
    if (!value) {
      this.skip(`missing required E2E secret: ${name}`);
    }
    return value;
  }

  redactionValues(extraValues: string[] = []): string[] {
    const values = new Set<string>();
    for (const [name, value] of Object.entries(this.env)) {
      if (value && SENSITIVE_NAME_PATTERN.test(name)) {
        values.add(value);
      }
    }
    for (const value of extraValues) {
      if (value) values.add(value);
    }
    return [...values];
  }

  redact(text: string, extraValues: string[] = []): string {
    return redactText(text, this.redactionValues(extraValues));
  }
}
