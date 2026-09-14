// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

type CheckRun = { external_id?: unknown };

export function assertRepairAttemptUnclaimed(pages: unknown, attemptKey: string): void {
  if (!/^sha256:[0-9a-f]{64}$/u.test(attemptKey)) throw new Error("repair attempt key is invalid");
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 100)
    throw new Error("repair attempt check-run pages are invalid");
  const runs: CheckRun[] = [];
  for (const page of pages) {
    if (
      typeof page !== "object" ||
      page === null ||
      !Array.isArray((page as { check_runs?: unknown }).check_runs) ||
      (page as { check_runs: unknown[] }).check_runs.length > 100
    )
      throw new Error("repair attempt check-run page is invalid");
    runs.push(...((page as { check_runs: CheckRun[] }).check_runs ?? []));
  }
  if (runs.some((run) => run.external_id === attemptKey))
    throw new Error("this exact Advisor repair attempt was already claimed");
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function main(): void {
  const pages = JSON.parse(
    readFileSync(required(process.env.ATTEMPT_PAGES_FILE, "ATTEMPT_PAGES_FILE"), "utf8"),
  ) as unknown;
  assertRepairAttemptUnclaimed(pages, required(process.env.ATTEMPT_KEY, "ATTEMPT_KEY"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
