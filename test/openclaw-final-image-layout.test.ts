// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOCKERFILE = path.join(ROOT, "Dockerfile");

describe("OpenClaw final image layout", () => {
  // source-shape-contract: compatibility -- Gateway-bound Dockerfiles remain parseable by Docker Engine's legacy builder while retaining intentional cache and scan boundaries
  it("uses legacy-compatible copy boundaries for repository payloads (#7611)", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
    const stages = dockerfile.split(/(?=^FROM )/mu).filter((stage) => stage.startsWith("FROM "));
    const finalStageIndex = stages.findIndex((stage) => stage.startsWith("FROM ${BASE_IMAGE}"));
    const finalStage = stages[finalStageIndex] ?? "";
    const dependencyCopy =
      "COPY agents/openclaw/openclaw-runtime/package.json /usr/local/lib/nemoclaw/openclaw-runtime/package.json";
    const pluginCopy = "COPY --from=builder /opt/nemoclaw/dist/ /opt/nemoclaw/dist/";
    const patchCopy =
      "COPY scripts/patch-openclaw-tool-catalog.mts /usr/local/lib/nemoclaw/patch-openclaw-tool-catalog.mts";
    const runtimeCopy = "COPY scripts/lib/sandbox-init.sh /usr/local/lib/nemoclaw/sandbox-init.sh";
    const scanCopy =
      "COPY scripts/checks/node-tar-image-scan.mts /scripts/checks/node-tar-image-scan.mts";

    expect(finalStageIndex).toBe(stages.length - 1);
    expect(dockerfile).not.toContain("RUN --mount");
    expect(dockerfile).not.toMatch(/^FROM scratch AS openclaw-.*-payload$/mu);
    for (const copy of [dependencyCopy, pluginCopy, patchCopy, runtimeCopy, scanCopy]) {
      expect(finalStage).toContain(copy);
    }
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

    const dependency = finalStage.indexOf(dependencyCopy);
    const plugin = finalStage.indexOf(pluginCopy);
    const patch = finalStage.indexOf(patchCopy);
    const runtime = finalStage.indexOf(runtimeCopy);
    expect(dependency).toBeLessThan(
      finalStage.indexOf("RUN node --experimental-strip-types /scripts/patch-bundled-npm-tar.mts"),
    );
    expect(
      finalStage.indexOf("RUN node --experimental-strip-types /scripts/patch-bundled-npm-tar.mts"),
    ).toBeLessThan(
      finalStage.indexOf(
        "RUN node --experimental-strip-types /scripts/patch-bundled-npm-brace-expansion.mts",
      ),
    );
    expect(plugin).toBeGreaterThan(finalStage.indexOf("RUN npm ci --omit=dev"));
    expect(plugin).toBeLessThan(
      finalStage.indexOf("RUN chmod -R a+rX /opt/nemoclaw /opt/nemoclaw-blueprint/"),
    );
    expect(patch).toBeGreaterThan(
      finalStage.indexOf("RUN npm ci --prefix /usr/local/lib/nemoclaw/wechat-runtime"),
    );
    expect(patch).toBeLessThan(
      finalStage.indexOf("RUN chmod 755 /usr/local/lib/nemoclaw/patch-openclaw-tool-catalog.mts"),
    );
    expect(runtime).toBeGreaterThan(
      finalStage.indexOf("RUN mkdir -p /sandbox/.nemoclaw/blueprints/0.1.0"),
    );
    expect(runtime).toBeLessThan(finalStage.indexOf("RUN chmod 755 /usr/local/bin/nemoclaw-start"));
    expect(finalStage.indexOf(scanCopy)).toBeLessThan(finalStage.indexOf("RUN check_metadata()"));
  });
});
