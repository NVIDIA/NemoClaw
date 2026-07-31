// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "managed-workload/rebuild");
const CENTRAL_REBUILD_MODULES = [
  "commit.ts",
  "contract.ts",
  "create.ts",
  "plan.ts",
  "prepare.ts",
  "provider-rebind.ts",
  "readiness.ts",
  "recovery.ts",
  "restore.ts",
  "rollback.ts",
  "transaction.ts",
  "validation.ts",
] as const;

function source(file: (typeof CENTRAL_REBUILD_MODULES)[number]): string {
  return fs.readFileSync(path.join(ROOT, file), "utf8");
}

describe("managed workload rebuild source shape", () => {
  it.each(
    CENTRAL_REBUILD_MODULES,
  )("keeps %s free of provider-specific imports and switches", (file) => {
    const text = source(file);

    expect(text).not.toMatch(/from\s+["'][^"']*(?:docker|podman)[^"']*["']/iu);
    expect(text).not.toMatch(
      /(?:providerId|openshellDriver)\s*(?:===|!==)\s*["'](?:docker|podman)["']/iu,
    );
    expect(text).not.toMatch(/switch\s*\(\s*(?:providerId|[^)]*[.]openshellDriver)\s*\)/iu);
  });

  it.each(CENTRAL_REBUILD_MODULES)("keeps %s free of name-only sandbox deletion", (file) => {
    const text = source(file);

    expect(text).not.toMatch(/\bremoveSandbox\s*\(/u);
    expect(text).not.toMatch(/\bdestroySandbox\s*\(\s*(?:plan[.])?sandboxName/u);
    expect(text).not.toMatch(/\bdeleteSandbox\s*\(\s*(?:plan[.])?sandboxName/u);
  });

  it("requires exact provider handles for rollback and retirement", () => {
    const contract = source("contract.ts");

    expect(contract).toContain("previousRuntimeHandle");
    expect(contract).toContain("stagingHandle");
    expect(contract).toContain("retirePrevious(");
    expect(contract).toContain("rollback(");
    expect(contract).toContain("A sandbox name is\n   * intentionally insufficient authority");
  });

  it("publishes only through the rebuild-authority CAS boundary", () => {
    const transaction = source("transaction.ts");
    const commit = source("commit.ts");

    expect(transaction).not.toContain("registerSandbox");
    expect(transaction).not.toContain("updateSandbox");
    expect(commit).toContain("compareAndSwapSandboxRebuildAuthority");
    expect(commit).not.toContain("registerSandbox");
    expect(commit).not.toContain("updateSandbox");
  });
});
