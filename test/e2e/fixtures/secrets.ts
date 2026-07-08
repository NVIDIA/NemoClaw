// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { redactString } from "./redaction.ts";

const SENSITIVE_NAME_PATTERN = /(api[_-]?key|token|secret|password|credential)/i;

/**
 * Fixture-scoped env-secret store.
 *
 * Holds the per-test view of `process.env` and lets fixtures discover
 * sensitive values by name. Redaction itself is owned by the canonical
 * entry point in fixtures/redaction.ts; this class only
 * supplies the explicit values it knows about and delegates. There is
 * no separate fixture redaction pattern source.
 */
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
    return redactString(text, this.redactionValues(extraValues));
  }
}
