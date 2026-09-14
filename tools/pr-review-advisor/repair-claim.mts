// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

type CheckRun = { external_id?: unknown };
type CheckRunPage = { check_runs?: unknown; total_count?: unknown };

export function assertRepairAttemptUnclaimed(pages: unknown, attemptKey: string): void {
  if (!/^sha256:[0-9a-f]{64}$/u.test(attemptKey)) throw new Error("repair attempt key is invalid");
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 100)
    throw new Error("repair attempt check-run pages are invalid");
  const runs: CheckRun[] = [];
  let totalCount: number | undefined;
  for (const page of pages) {
    const checkRunPage = page as CheckRunPage;
    if (
      typeof page !== "object" ||
      page === null ||
      !Number.isSafeInteger(checkRunPage.total_count) ||
      (checkRunPage.total_count as number) < 0 ||
      !Array.isArray(checkRunPage.check_runs) ||
      checkRunPage.check_runs.length > 100
    )
      throw new Error("repair attempt check-run page is invalid");
    if (totalCount === undefined) totalCount = checkRunPage.total_count as number;
    else if (checkRunPage.total_count !== totalCount)
      throw new Error("repair attempt check-run page totals are inconsistent");
    runs.push(...(checkRunPage.check_runs as CheckRun[]));
  }
  if (runs.length !== totalCount)
    throw new Error("repair attempt check-run page set is incomplete");
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
