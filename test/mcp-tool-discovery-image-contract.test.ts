// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "..");
const runtimeRoot = "/usr/local/lib/nemoclaw/mcp-tool-discovery-runtime";
const dockerfiles = [
  "Dockerfile",
  "agents/hermes/Dockerfile",
  "agents/langchain-deepagents-code/Dockerfile",
] as const;

describe("MCP tool discovery image contract", () => {
  // source-shape-contract: security -- Exact package pins and the production audit command protect the shipped runtime graph
  it("pins reviewed packages and retains the production audit command (#8177)", () => {
    const packageRoot = path.join(repoRoot, "tools", "mcp-tool-discovery-runtime");
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    const lock = JSON.parse(fs.readFileSync(path.join(packageRoot, "package-lock.json"), "utf8"));
    const review = fs.readFileSync(path.join(packageRoot, "dependency-review.md"), "utf8");
    const installer = fs.readFileSync(
      path.join(packageRoot, "install-reviewed-runtime.sh"),
      "utf8",
    );
    const reviewedSdk = {
      name: "@modelcontextprotocol/sdk",
      version: "1.30.0",
      resolved: "https://registry.npmjs.org/@modelcontextprotocol/sdk/-/sdk-1.30.0.tgz",
      integrity:
        "sha512-xKd8OIzlqNzcqcNumGAa6g+PW2kjD5vrpcKOnfldAUPP3j7lnqMPwlTXQm8gF+UwH72z0lqaRbjr9hqGz0eITA==",
    } as const;
    const reviewedPackages = {
      "@hono/node-server": {
        version: "2.0.12",
        resolved: "https://registry.npmjs.org/@hono/node-server/-/node-server-2.0.12.tgz",
        integrity:
          "sha512-eWpQYr67tqJLeaSUl0Q+TquuYfUdTibpOJlUMV2FfUP7+KqCC5TufnwnlXL6mobZBJbGAYRd7ZvEBDCbLInjhg==",
      },
      "fast-uri": {
        version: "3.1.5",
        resolved: "https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.5.tgz",
        integrity:
          "sha512-gHwA1O9LDIcKunMKhObS/HimwtehO1nPUECKAu5TpKgaO19fcWEl4bliWe1jWxVFvIXztJjjQ4L8XQ1EU9f7Jw==",
      },
      hono: {
        version: "4.12.34",
        resolved: "https://registry.npmjs.org/hono/-/hono-4.12.34.tgz",
        integrity:
          "sha512-GqXJqY/xJkJmuloTrnV1ZEXG3fqte+VjkUqoRNZXcrUidiUOP4fMSIHHY4tsqZBK++kVyWmt/AAfSUuy57/eSA==",
      },
      "ip-address": {
        version: "10.3.1",
        resolved: "https://registry.npmjs.org/ip-address/-/ip-address-10.3.1.tgz",
        integrity:
          "sha512-1e9d3kb97NHJTIJDZW9rKqW2h6+dFa50Dy0fpPSMQp2ADje5gvKsXmdiK6dwY5t76TaTt5+P5N1Y/LoToIxP6g==",
      },
    } as const;

    expect(manifest.dependencies[reviewedSdk.name]).toBe(reviewedSdk.version);
    expect(lock.packages[`node_modules/${reviewedSdk.name}`]).toMatchObject({
      version: reviewedSdk.version,
      resolved: reviewedSdk.resolved,
      integrity: reviewedSdk.integrity,
    });
    expect(review).toContain(`\`${reviewedSdk.name}@${reviewedSdk.version}\``);
    expect(review).toContain(`\`${reviewedSdk.integrity}\``);
    expect(manifest.overrides).toEqual(
      Object.fromEntries(
        Object.entries(reviewedPackages).map(([packageName, metadata]) => [
          packageName,
          metadata.version,
        ]),
      ),
    );
    for (const [packageName, metadata] of Object.entries(reviewedPackages)) {
      expect(lock.packages[`node_modules/${packageName}`]).toMatchObject(metadata);
      expect(review).toContain(`\`${packageName}@${metadata.version}\``);
      expect(review).toContain(`\`${metadata.integrity}\``);
    }
    expect(
      installer
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("npm audit")),
    ).toEqual(["npm audit signatures", "npm audit --omit=dev --audit-level=low"]);
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
