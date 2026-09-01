// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UUID_V4_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

export function bindE2eCorrelationIdentity(
  outputPath: string,
  generate: () => string = randomUUID,
): string {
  if (!outputPath || /[\r\n]/u.test(outputPath)) {
    throw new Error("GITHUB_ENV must be a non-empty single-line path");
  }
  const correlationId = generate();
  if (!UUID_V4_PATTERN.test(correlationId)) {
    throw new Error("generated E2E correlation identity must be a lowercase UUIDv4");
  }
  fs.appendFileSync(outputPath, `NEMOCLAW_E2E_CORRELATION_ID=${correlationId}\n`, "utf8");
  return correlationId;
}

export function main(environment: NodeJS.ProcessEnv = process.env): void {
  bindE2eCorrelationIdentity(environment.GITHUB_ENV ?? "");
  console.log("e2e-correlation-identity outcome=bound");
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "unknown E2E correlation error");
    process.exitCode = 1;
  }
}
