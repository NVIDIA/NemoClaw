// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOCKERFILE = path.join(ROOT, "Dockerfile");

function indexOfRequired(haystack: string, needle: string): number {
  const index = haystack.indexOf(needle);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

describe("OpenClaw final image layout", () => {
  // source-shape-contract: compatibility -- Legacy-compatible grouped payload copies preserve cold-onboard export work while retaining intentional cache and scan boundaries
  it("uses grouped legacy-compatible payload layers at their cache boundaries (#7611)", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
    const stages = dockerfile.split(/(?=^FROM )/mu).filter((stage) => stage.startsWith("FROM "));
    const finalStageIndex = stages.findIndex((stage) => stage.startsWith("FROM ${BASE_IMAGE}"));
    const finalStage = stages[finalStageIndex] ?? "";
    const payloads = [
      { stage: "openclaw-dependency-payload", copies: 12 },
      { stage: "openclaw-plugin-payload", copies: 3 },
      { stage: "openclaw-patch-payload", copies: 8 },
      { stage: "openclaw-runtime-payload", copies: 20 },
    ] as const;
    const dependencyCopy = "COPY --from=openclaw-dependency-payload / /";
    const pluginCopy = "COPY --from=openclaw-plugin-payload / /";
    const patchCopy = "COPY --from=openclaw-patch-payload / /";
    const runtimeCopy = "COPY --from=openclaw-runtime-payload / /";
    const scanCopy =
      "COPY scripts/checks/node-tar-image-scan.mts /scripts/checks/node-tar-image-scan.mts";

    expect(finalStageIndex).toBe(stages.length - 1);
    expect(dockerfile).not.toContain("RUN --mount");
    for (const payload of payloads) {
      const stage = stages.find((entry) => entry.startsWith(`FROM scratch AS ${payload.stage}`));
      expect(stage?.match(/^COPY\b.*$/gmu)).toHaveLength(payload.copies);
      expect(finalStage).toContain(`COPY --from=${payload.stage} / /`);
    }
    expect(finalStage.match(/^COPY\b.*$/gmu)).toEqual([
      "COPY --from=builder /usr/local/bin/node /usr/local/bin/node",
      dependencyCopy,
      "COPY nemoclaw/package.json nemoclaw/package-lock.json /opt/nemoclaw/",
      pluginCopy,
      patchCopy,
      runtimeCopy,
      scanCopy,
    ]);
    for (const metadataContract of [
      "/scripts/patch-bundled-npm-brace-expansion.mts 'root:root:755'",
      "/scripts/patch-bundled-npm-tar.mts 'root:root:755'",
      "/opt/nemoclaw/openclaw.plugin.json 'root:root:644'",
      "/usr/local/lib/nemoclaw/patch-openclaw-tool-catalog.mts 'root:root:755'",
      "/usr/local/bin/nemoclaw-gateway-control 'root:root:700'",
      "/usr/local/lib/nemoclaw/state-dir-guard.py 'root:root:500'",
      "/usr/local/lib/nemoclaw/preloads/sandbox-safety-net.js 'root:root:644'",
      "/scripts/checks/node-tar-image-scan.mts 'root:root:755'",
    ]) {
      expect(finalStage).toContain(`check_metadata ${metadataContract}`);
    }

    const dependency = indexOfRequired(finalStage, dependencyCopy);
    const plugin = indexOfRequired(finalStage, pluginCopy);
    const patch = indexOfRequired(finalStage, patchCopy);
    const runtime = indexOfRequired(finalStage, runtimeCopy);
    const scan = indexOfRequired(finalStage, scanCopy);
    const tarPatch = indexOfRequired(
      finalStage,
      "RUN node --experimental-strip-types /scripts/patch-bundled-npm-tar.mts",
    );
    const braceExpansionPatch = indexOfRequired(
      finalStage,
      "RUN node --experimental-strip-types /scripts/patch-bundled-npm-brace-expansion.mts",
    );
    const pluginInstall = indexOfRequired(finalStage, "RUN npm ci --omit=dev");
    const pluginChmod = indexOfRequired(
      finalStage,
      "RUN chmod -R a+rX /opt/nemoclaw /opt/nemoclaw-blueprint/",
    );
    const wechatInstall = indexOfRequired(
      finalStage,
      "RUN npm ci --prefix /usr/local/lib/nemoclaw/wechat-runtime",
    );
    const patchChmod = indexOfRequired(
      finalStage,
      "RUN chmod 755 /usr/local/lib/nemoclaw/patch-openclaw-tool-catalog.mts",
    );
    const blueprintSetup = indexOfRequired(
      finalStage,
      "RUN mkdir -p /sandbox/.nemoclaw/blueprints/0.1.0",
    );
    const runtimeChmod = indexOfRequired(finalStage, "RUN chmod 755 /usr/local/bin/nemoclaw-start");
    const metadataCheck = indexOfRequired(finalStage, "RUN check_metadata()");

    expect(dependency).toBeLessThan(tarPatch);
    expect(tarPatch).toBeLessThan(braceExpansionPatch);
    expect(plugin).toBeGreaterThan(pluginInstall);
    expect(plugin).toBeLessThan(pluginChmod);
    expect(patch).toBeGreaterThan(wechatInstall);
    expect(patch).toBeLessThan(patchChmod);
    expect(runtime).toBeGreaterThan(blueprintSetup);
    expect(runtime).toBeLessThan(runtimeChmod);
    expect(scan).toBeLessThan(metadataCheck);
  });
});
