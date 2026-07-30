// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const docsIndexPath = path.join(repoRoot, "docs", "index.yml");
const architecturePath = path.join(repoRoot, "docs", "reference", "architecture.mdx");
const runtimeIdentityPath = path.join(
  repoRoot,
  "docs",
  "reference",
  "configure-runtime-identity.mdx",
);
const ollamaPath = path.join(repoRoot, "docs", "inference", "set-up-ollama.mdx");
const memorySearchPath = path.join(
  repoRoot,
  "docs",
  "configure-agents",
  "configure-memory-search.mdx",
);

describe("focused documentation ownership", () => {
  it("keeps runtime identity on one OpenClaw task page", () => {
    const docsIndex = fs.readFileSync(docsIndexPath, "utf8");
    const architecture = fs.readFileSync(architecturePath, "utf8");
    const runtimeIdentity = fs.readFileSync(runtimeIdentityPath, "utf8");

    expect(docsIndex.match(/page: "Configure Runtime Identity"/g)).toHaveLength(1);
    expect(architecture).toContain("### Experimental Runtime Identity");
    expect(architecture).toContain(
      "[Configure Experimental Runtime Identity](configure-runtime-identity)",
    );
    expect(architecture).toContain("Okta and Microsoft Entra reference profiles");
    expect(architecture).not.toContain("identity:\n  profile_path:");
    expect(runtimeIdentity).toContain("identity:\n  profile_path:");
    expect(runtimeIdentity).toContain("## Roll Back Runtime Identity");
    expect(runtimeIdentity).toContain("including its Okta and Microsoft Entra profiles");
    expect(runtimeIdentity).toContain("unset OKTA_REFRESH_TOKEN OKTA_CLIENT_SECRET");
    expect(runtimeIdentity).toContain(
      "OpenShell retains the refresh material in the gateway credential store until rollback or provider deletion",
    );
    expect(runtimeIdentity).not.toContain("$$nemoclaw");
  });

  it("keeps OpenClaw memory-search configuration on one task page", () => {
    const docsIndex = fs.readFileSync(docsIndexPath, "utf8");
    const ollama = fs.readFileSync(ollamaPath, "utf8");
    const memorySearch = fs.readFileSync(memorySearchPath, "utf8");

    expect(docsIndex.match(/page: "Configure Memory Search"/g)).toHaveLength(1);
    expect(ollama).toContain("## Point Memory Search at a Host Ollama Container");
    expect(ollama).toContain(
      "[Configure Memory Search](../../configure-agents/configure-memory-search)",
    );
    expect(ollama).not.toContain("--key agents.defaults.memorySearch.provider");
    expect(memorySearch).toContain("--key agents.defaults.memorySearch.provider");
    expect(memorySearch).toContain("openclaw memory index --force");
    expect(memorySearch).toContain(
      'shields down \\\n  --timeout 5m \\\n  --reason "configure memory search"',
    );
    expect(memorySearch).toContain(
      "If a configuration command or restart fails, run `nemoclaw my-assistant shields up`",
    );
    expect(memorySearch).toContain("nemoclaw my-assistant shields status");
    expect(memorySearch).toContain(
      "Continue only when the command succeeds and reports `Shields: UP (lockdown active)`",
    );
    expect(memorySearch).not.toContain("$$nemoclaw");
  });
});
