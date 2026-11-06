// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// Execute only the TypeScript files declared by the image, without the checkout,
// compiled CLI, package dependencies, or a TypeScript module-resolution loader.
function imagePayload(agent: "pi" | "langchain-deepagents-code") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-config-payload-"));
  temporary.push(root);
  const dockerfile = fs.readFileSync(`agents/${agent}/Dockerfile`, "utf8");
  copyImageSource(root, dockerfile, `agents/${agent}/generate-config.ts`);
  copyImageSource(root, dockerfile, "src/lib/core/endpoint-url-safety.ts");
  copyImageSource(root, dockerfile, "src/lib/inference/native-local/agent-config.ts");
  copyImageSource(root, dockerfile, "src/lib/inference/native-provider/agent-config.ts");
  copyImageSource(root, dockerfile, "src/lib/inference/native-provider/catalog.ts");
  copyImageSource(root, dockerfile, "src/lib/inference/native-nvidia/contract.ts");
  copyImageSource(
    root,
    dockerfile,
    agent === "pi"
      ? "agents/pi/check-native-credentials.ts"
      : "src/lib/inference/managed-dcode/identity.ts",
  );
  return root;
}

function copyImageSource(root: string, dockerfile: string, source: string) {
  const fields = dockerfile
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .find((parts) => parts[0] === "COPY" && parts.includes(source));
  assert(fields, `Image must copy ${source}`);
  const target = fields.at(-1)!;
  const destination = path.join(
    root,
    target,
    ...(target.endsWith("/") ? [path.basename(source)] : []),
  );
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

describe.each(["pi", "langchain-deepagents-code"] as const)(
  "%s image configuration payload",
  (agent) => {
    it.each([
      ["nvidia-prod", "https://inference.local/v1", undefined, false],
      ["ollama-local", "http://host.openshell.internal:11434/v1", undefined, true],
      [
        "team-router",
        "http://host.openshell.internal:43123/team/v1",
        "openshell:resolve:env:v7_NEMOCLAW_LOCAL_INFERENCE_TOKEN",
        true,
      ],
      ["team-router", "http://host.openshell.internal:43123/team/v1", "raw-key", false],
    ] as const)(
      "generates %s configuration with only image sources",
      (provider, endpoint, handle, native) => {
        const root = imagePayload(agent);
        const script =
          agent === "pi"
            ? "opt/nemoclaw-pi/generate-config.ts"
            : "opt/nemoclaw-deepagents-code/agents/langchain-deepagents-code/generate-config.ts";
        const home = path.join(root, "sandbox");
        const result = spawnSync(process.execPath, [path.join(root, script)], {
          cwd: root,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            HOME: home,
            NEMOCLAW_MODEL: "selected-model",
            NEMOCLAW_INFERENCE_PROVIDER_ID: "inference",
            NEMOCLAW_UPSTREAM_PROVIDER: provider,
            NEMOCLAW_INFERENCE_BASE_URL: endpoint,
            NEMOCLAW_INFERENCE_API: "openai-completions",
            ...(handle ? { NEMOCLAW_LOCAL_INFERENCE_TOKEN: handle } : {}),
          },
        });
        expect(result.status, result.stderr).toBe(0);
        const config = fs.readFileSync(
          path.join(home, agent === "pi" ? ".pi/agent/models.json" : ".deepagents/config.toml"),
          "utf8",
        );
        expect(config).toContain(endpoint);
        expect(config.includes("NEMOCLAW_LOCAL_INFERENCE_TOKEN")).toBe(native);
        expect(config).not.toContain("raw-key");
        expect(config).not.toContain(handle ?? "raw-key");
      },
    );
  },
);

// Reaching the explicit runtime lookup proves copied imports load; credential
// resolution itself remains the pinned Pi image build's acceptance check.
it("loads the Pi credential checker from image sources before resolving its pinned runtime", () => {
  const root = imagePayload("pi");
  const absentRuntime = path.join(root, "uninstalled-pinned-pi-runtime");
  const result = spawnSync(
    process.execPath,
    [path.join(root, "opt/nemoclaw-pi/check-native-credentials.ts"), absentRuntime],
    { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH } },
  );
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(path.join(absentRuntime, "dist/core/resolve-config-value.js"));
});
