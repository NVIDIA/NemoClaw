// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

const ENTRYPOINTS = [
  {
    agent: "openclaw",
    script: "scripts/nemoclaw-start.sh",
    dockerfile: "Dockerfile",
    managedBlockEnd: "# Reject an invalid explicit dashboard port",
    runtimeUserDefault: "root",
  },
  {
    agent: "hermes",
    script: "agents/hermes/start.sh",
    dockerfile: "agents/hermes/Dockerfile",
    managedBlockEnd: "# ── Source shared sandbox initialisation library",
    runtimeUserDefault: "root",
  },
  {
    agent: "langchain-deepagents-code",
    script: "agents/langchain-deepagents-code/start.sh",
    dockerfile: "agents/langchain-deepagents-code/Dockerfile",
    managedBlockEnd: "# The published managed image uses uid 0",
    runtimeUserDefault: "sandbox",
  },
] as const;

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

describe("managed startup image entrypoint contract", () => {
  it.each(
    ENTRYPOINTS,
  )("$agent applies the profile as root before entering its legacy startup path", (contract) => {
    const script = read(contract.script);
    const normalization = script.indexOf("nemoclaw_normalize_entrypoint_env_wrapper");
    const blockStart = script.indexOf('if [ -n "${NEMOCLAW_STARTUP_PROFILE_B64:-}" ]; then');
    const blockEnd = script.indexOf(contract.managedBlockEnd, blockStart);
    expect(normalization).toBeGreaterThan(-1);
    expect(blockStart).toBeGreaterThan(-1);
    expect(normalization).toBeLessThan(blockStart);
    expect(blockEnd).toBeGreaterThan(blockStart);
    const managedBlock = script.slice(blockStart, blockEnd);

    expect(managedBlock).toContain('if [ "$(id -u)" -ne 0 ]; then');
    expect(managedBlock).toContain("/usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs");
    expect(managedBlock).toContain("/run/nemoclaw/managed-startup-runtime.env");
    expect(managedBlock).toContain("0:0:400");
    expect(managedBlock).toContain("unset NEMOCLAW_STARTUP_PROFILE_B64 NEMOCLAW_CORPORATE_CA_B64");
    expect(managedBlock).not.toMatch(/\b(?:npm|npx|pip|pip3|uv)\b.*\binstall\b/iu);

    if (contract.agent === "langchain-deepagents-code") {
      expect(managedBlock).toContain(
        "exec /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups --",
      );
      expect(script).not.toContain("su -c");
    } else {
      expect(script).toContain('if [ "${NEMOCLAW_MANAGED_STARTUP_APPLIED:-0}" != "1" ]; then');
    }
  });

  it.each(
    ENTRYPOINTS,
  )("$agent image bundles the runtime and preserves its legacy default OCI user", (contract) => {
    const dockerfile = read(contract.dockerfile);

    expect(dockerfile).toContain(
      "FROM mcp-tool-discovery-runtime AS managed-startup-runtime-builder",
    );
    expect(dockerfile).toContain(
      "COPY scripts/lib/entrypoint-env-wrapper.sh /usr/local/lib/nemoclaw/entrypoint-env-wrapper.sh",
    );
    expect(dockerfile).toContain("/usr/local/lib/nemoclaw/entrypoint-env-wrapper.sh");
    expect(dockerfile).toContain("src/lib/onboard/managed-startup/image-runtime.ts");
    expect(dockerfile).toContain("--outfile=/out/managed-startup-image-runtime.cjs");
    expect(dockerfile).toContain("/usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs");
    expect(dockerfile).toContain(
      `ARG NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER=${contract.runtimeUserDefault}`,
    );
  });
});
