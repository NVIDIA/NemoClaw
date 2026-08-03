// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");
const runtimeSource = path.join(repoRoot, "tools", "mcp-tool-discovery-runtime");
const runtimeRoot = "/usr/local/lib/nemoclaw/mcp-tool-discovery-runtime";
const dockerfiles = [
  "Dockerfile",
  "agents/hermes/Dockerfile",
  "agents/langchain-deepagents-code/Dockerfile",
] as const;

describe("MCP tool discovery image contract", () => {
  // source-shape-contract: security -- Exact registry identities bind the production discovery graph to reviewed patched packages
  it("pins the audited MCP discovery transitive graph (#8156)", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(runtimeSource, "package.json"), "utf8"));
    const lock = JSON.parse(fs.readFileSync(path.join(runtimeSource, "package-lock.json"), "utf8"));
    const review = fs.readFileSync(path.join(runtimeSource, "dependency-review.md"), "utf8");

    expect(manifest.overrides).toEqual({
      "@hono/node-server": "2.0.11",
      "fast-uri": "3.1.5",
      hono: "4.12.34",
      "ip-address": "10.3.1",
    });
    expect(lock.packages["node_modules/@hono/node-server"]).toMatchObject({
      version: "2.0.11",
      resolved: "https://registry.npmjs.org/@hono/node-server/-/node-server-2.0.11.tgz",
      integrity:
        "sha512-bjD221KPLoJTWUwso1J6fGKiTXEUFedG/s0visavY4zakFPkeGURMRNly+FhBHs7T8Dz4qHaZIMX9ZoJHSJtKA==",
      engines: { node: ">=20" },
    });
    expect(lock.packages["node_modules/fast-uri"]).toMatchObject({
      version: "3.1.5",
      resolved: "https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.5.tgz",
      integrity:
        "sha512-gHwA1O9LDIcKunMKhObS/HimwtehO1nPUECKAu5TpKgaO19fcWEl4bliWe1jWxVFvIXztJjjQ4L8XQ1EU9f7Jw==",
    });
    expect(lock.packages["node_modules/ip-address"]).toMatchObject({
      version: "10.3.1",
      resolved: "https://registry.npmjs.org/ip-address/-/ip-address-10.3.1.tgz",
      integrity:
        "sha512-1e9d3kb97NHJTIJDZW9rKqW2h6+dFa50Dy0fpPSMQp2ADje5gvKsXmdiK6dwY5t76TaTt5+P5N1Y/LoToIxP6g==",
      engines: { node: ">= 12" },
    });
    expect(lock.packages["node_modules/hono"]).toMatchObject({
      version: "4.12.34",
      resolved: "https://registry.npmjs.org/hono/-/hono-4.12.34.tgz",
      integrity:
        "sha512-GqXJqY/xJkJmuloTrnV1ZEXG3fqte+VjkUqoRNZXcrUidiUOP4fMSIHHY4tsqZBK++kVyWmt/AAfSUuy57/eSA==",
      engines: { node: ">=16.9.0" },
    });
    for (const reviewedPackage of [
      "@hono/node-server@2.0.11",
      "fast-uri@3.1.5",
      "hono@4.12.34",
      "ip-address@10.3.1",
    ]) {
      expect(review).toContain(`\`${reviewedPackage}\``);
    }
  });

  it.each(
    dockerfiles,
  )("%s installs and probes the bundled runtime at its canonical path (#6901)", (relativePath) => {
    const dockerfile = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");

    expect(dockerfile).toContain(
      `COPY --from=mcp-tool-discovery-runtime /opt/mcp-tool-discovery-runtime/dist/ ${runtimeRoot}/`,
    );
    expect(dockerfile).toContain(`node ${runtimeRoot}/mcp-tool-discovery.mjs`);
    expect(dockerfile).not.toContain(`${runtimeRoot}/mcp-tool-discovery.ts`);
  });
});
