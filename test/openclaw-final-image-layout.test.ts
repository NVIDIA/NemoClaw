// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOCKERFILE = path.join(ROOT, "Dockerfile");

describe("OpenClaw final image layout", () => {
  // source-shape-contract: compatibility -- Grouped payload layers preserve cold-onboard export work while retaining intentional cache and scan boundaries
  it("keeps repository payload layers at their cache boundaries (#6660)", () => {
    const dockerfile = fs.readFileSync(DOCKERFILE, "utf-8");
    const stages = dockerfile.split(/(?=^FROM )/mu).filter((stage) => stage.startsWith("FROM "));
    const finalStageIndex = stages.findIndex((stage) => stage.startsWith("FROM ${BASE_IMAGE}"));
    const finalStage = stages[finalStageIndex] ?? "";
    const payloads = [
      {
        stage: "openclaw-dependency-payload",
        copies: 9,
        metadata: "/ /usr /usr/local /usr/local/lib",
      },
      {
        stage: "openclaw-plugin-payload",
        copies: 3,
        metadata: "/ /opt /opt/nemoclaw",
      },
      {
        stage: "openclaw-patch-payload",
        copies: 8,
        metadata: "/ /usr /usr/local /usr/local/lib /usr/local/lib/nemoclaw",
      },
      {
        stage: "openclaw-runtime-payload",
        copies: 19,
        metadata:
          "/ /usr /usr/local /usr/local/bin /usr/local/lib /usr/local/lib/nemoclaw /usr/local/share /usr/local/share/nemoclaw /scripts",
      },
    ] as const;

    for (const payload of payloads) {
      const stage = stages.find((entry) => entry.startsWith(`FROM scratch AS ${payload.stage}`));
      const layer = `RUN --mount=type=bind,from=${payload.stage},source=/,target=/run/nemoclaw-payload`;
      const layerStart = finalStage.indexOf(layer);
      const layerBlock = finalStage.slice(layerStart, finalStage.indexOf("\n\n", layerStart));

      expect(stage?.match(/^COPY\b.*$/gmu)).toHaveLength(payload.copies);
      expect(layerBlock).toContain("/bin/bash -euo pipefail -c");
      expect(layerBlock).toContain(`stat -c "%u:%g:%a:%n" ${payload.metadata}`);
      expect(layerBlock.match(/stat -c "%u:%g:%a:%n"/gu)).toHaveLength(2);
      expect(layerBlock).toContain("tar --numeric-owner -C /run/nemoclaw-payload -cpf - . \\");
      expect(layerBlock).toContain(
        "| tar --no-overwrite-dir --same-owner --numeric-owner --preserve-permissions -C / -xpf -;",
      );
      expect(layerBlock).toContain('[[ "$payload_metadata_before" == "$payload_metadata_after" ]]');
      expect(layerBlock).not.toMatch(/\b(?:mktemp|trap|rm)\b/u);
    }

    expect(finalStageIndex).toBe(stages.length - 1);
    expect(finalStage.match(/^RUN --mount=.*$/gmu)).toEqual(
      payloads.map(
        (payload) =>
          `RUN --mount=type=bind,from=${payload.stage},source=/,target=/run/nemoclaw-payload \\`,
      ),
    );
    expect(finalStage.match(/^COPY\b.*$/gmu)).toEqual([
      "COPY --from=builder /usr/local/bin/node /usr/local/bin/node",
      "COPY nemoclaw/package.json nemoclaw/package-lock.json /opt/nemoclaw/",
      "COPY scripts/checks/node-tar-image-scan.mts /scripts/checks/node-tar-image-scan.mts",
    ]);
    for (const metadataContract of [
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

    const [dependency, plugin, patch, runtime] = payloads.map((payload) =>
      finalStage.indexOf(`RUN --mount=type=bind,from=${payload.stage}`),
    );
    expect(dependency).toBeLessThan(
      finalStage.indexOf("RUN node --experimental-strip-types /scripts/patch-bundled-npm-tar.mts"),
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
  });
});
