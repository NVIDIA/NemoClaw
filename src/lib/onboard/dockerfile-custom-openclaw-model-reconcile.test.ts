// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { patchStagedDockerfile } from "./dockerfile-patch";

describe("custom OpenClaw Dockerfile model reconciliation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function customRouteProgram(root: string): { configPath: string; program: string } {
    const dockerfilePath = path.join(root, "Dockerfile");
    fs.writeFileSync(
      dockerfilePath,
      [
        "FROM example.invalid/openclaw@sha256:" + "1".repeat(64),
        "ARG NEMOCLAW_TOOL_DISCLOSURE=progressive",
      ].join("\n"),
    );
    patchStagedDockerfile(
      dockerfilePath,
      "provider/selected-model",
      "http://127.0.0.1:18789",
      "build-1",
      null,
      null,
      null,
      null,
      false,
      null,
      [],
      { agentName: "openclaw", reconcileCustomOpenClawModel: true },
    );
    const embedded = fs
      .readFileSync(dockerfilePath, "utf8")
      .match(/<<'PYNEMOCLAWCUSTOMROUTE'\n([\s\S]*?)\nPYNEMOCLAWCUSTOMROUTE/u)?.[1];
    expect(embedded).toBeDefined();
    const configPath = path.join(root, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agents: { defaults: { model: { primary: "inference/baked-model" } } },
        models: {
          providers: {
            inference: {
              models: [{ id: "baked-model", name: "inference/baked-model" }],
            },
          },
        },
      }),
    );
    return {
      configPath,
      program: embedded!.replace(
        'config_path = "/sandbox/.openclaw/openclaw.json"',
        `config_path = ${JSON.stringify(configPath)}`,
      ),
    };
  }

  it.each([
    {
      behavior: "drops inherited limits",
      contextWindow: "",
      maxTokens: "",
      inheritedModelId: "baked-model",
      expectedLimits: {},
    },
    {
      behavior: "retains explicit limits",
      contextWindow: "65536",
      maxTokens: "8192",
      inheritedModelId: "baked-model",
      expectedLimits: { contextWindow: 65_536, maxTokens: 8_192 },
    },
    {
      behavior: "replaces only the explicit context window",
      contextWindow: "65536",
      maxTokens: "",
      inheritedModelId: "baked-model",
      expectedLimits: { contextWindow: 65_536 },
    },
    {
      behavior: "replaces only the explicit maximum output-token count",
      contextWindow: "",
      maxTokens: "8192",
      inheritedModelId: "baked-model",
      expectedLimits: { maxTokens: 8_192 },
    },
    {
      behavior: "overrides inherited limits when the model already matches",
      contextWindow: "65536",
      maxTokens: "8192",
      inheritedModelId: "provider/selected-model",
      expectedLimits: { contextWindow: 65_536, maxTokens: 8_192 },
    },
  ])("$behavior for the selected model and preserves the final image user", (testCase) => {
    vi.stubEnv("NEMOCLAW_CONTEXT_WINDOW", testCase.contextWindow);
    vi.stubEnv("NEMOCLAW_MAX_TOKENS", testCase.maxTokens);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-model-patch-"));
    try {
      const dockerfilePath = path.join(root, "Dockerfile");
      fs.writeFileSync(
        dockerfilePath,
        [
          "FROM example.invalid/openclaw@sha256:" + "1".repeat(64),
          "ARG NEMOCLAW_TOOL_DISCLOSURE=progressive",
          "USER 1001:1001",
        ].join("\n"),
      );

      patchStagedDockerfile(
        dockerfilePath,
        "provider/selected-model",
        "http://127.0.0.1:18789",
        "build-1",
        null,
        null,
        null,
        null,
        false,
        null,
        [],
        { agentName: "openclaw", reconcileCustomOpenClawModel: true },
      );

      const patched = fs.readFileSync(dockerfilePath, "utf-8");
      const encodedModel = /^ARG NEMOCLAW_CUSTOM_ROUTE_MODEL_B64=(.+)$/mu.exec(patched)?.[1] ?? "";
      const encodedLimits =
        /^ARG NEMOCLAW_CUSTOM_ROUTE_LIMITS_B64=(.+)$/mu.exec(patched)?.[1] ?? "";
      expect(encodedModel).not.toBe("");
      expect(encodedLimits).not.toBe("");
      expect(patched).toContain("sha256sum openclaw.json > .config-hash");
      expect(patched).toContain(".nemoclaw-custom-route-pending");
      expect(patched.trimEnd().endsWith("USER 1001:1001")).toBe(true);

      const embedded = patched.match(
        /<<'PYNEMOCLAWCUSTOMROUTE'\n([\s\S]*?)\nPYNEMOCLAWCUSTOMROUTE/u,
      )?.[1];
      expect(embedded).toBeDefined();
      const configPath = path.join(root, "openclaw.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          agents: { defaults: { model: { primary: "inference/baked-model" } } },
          models: {
            providers: {
              inference: {
                models: [
                  {
                    id: testCase.inheritedModelId,
                    name: `inference/${testCase.inheritedModelId}`,
                    contextWindow: 131_072,
                    maxTokens: 4_096,
                  },
                ],
              },
            },
          },
        }),
      );
      const program = embedded!.replace(
        'config_path = "/sandbox/.openclaw/openclaw.json"',
        `config_path = ${JSON.stringify(configPath)}`,
      );
      const result = spawnSync("/usr/bin/python3", ["-I", "-c", program], {
        encoding: "utf-8",
        env: {
          ...process.env,
          NEMOCLAW_CUSTOM_ROUTE_MODEL_B64: encodedModel,
          NEMOCLAW_CUSTOM_ROUTE_LIMITS_B64: encodedLimits,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({
        agents: { defaults: { model: { primary: "inference/provider/selected-model" } } },
        models: {
          providers: {
            inference: {
              models: [
                {
                  id: "provider/selected-model",
                  name: "inference/provider/selected-model",
                  ...testCase.expectedLimits,
                },
              ],
            },
          },
        },
      });
      const configBytes = fs.readFileSync(configPath);
      expect(fs.readFileSync(path.join(root, ".nemoclaw-custom-route-pending"), "utf8")).toBe(
        `${createHash("sha256").update(configBytes).digest("hex")}  openclaw.json\n`,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not invent a final image user when the Dockerfile declares no USER", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-model-user-patch-"));
    try {
      const dockerfilePath = path.join(root, "Dockerfile");
      fs.writeFileSync(
        dockerfilePath,
        [
          "FROM example.invalid/openclaw@sha256:" + "1".repeat(64),
          "ARG NEMOCLAW_TOOL_DISCLOSURE=progressive",
        ].join("\n"),
      );

      patchStagedDockerfile(
        dockerfilePath,
        "provider/selected-model",
        "http://127.0.0.1:18789",
        "build-1",
        null,
        null,
        null,
        null,
        false,
        null,
        [],
        { agentName: "openclaw", reconcileCustomOpenClawModel: true },
      );

      const patched = fs.readFileSync(dockerfilePath, "utf-8");
      expect(patched.match(/^USER(?:\s|$).*$/gimu)).toBeNull();
      expect(patched.trimEnd().endsWith("fi")).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("atomically replaces a pre-existing custom-route receipt symlink", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-model-marker-link-"));
    try {
      const { program } = customRouteProgram(root);
      const targetPath = path.join(root, "receipt-target");
      const markerPath = path.join(root, ".nemoclaw-custom-route-pending");
      fs.writeFileSync(targetPath, "unchanged\n");
      fs.symlinkSync(targetPath, markerPath);

      const result = spawnSync("/usr/bin/python3", ["-I", "-c", program], {
        encoding: "utf-8",
        env: {
          ...process.env,
          NEMOCLAW_CUSTOM_ROUTE_MODEL_B64:
            Buffer.from("provider/selected-model").toString("base64"),
          NEMOCLAW_CUSTOM_ROUTE_LIMITS_B64: Buffer.from("{}").toString("base64"),
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(fs.lstatSync(markerPath).isFile()).toBe(true);
      expect(fs.readFileSync(targetPath, "utf8")).toBe("unchanged\n");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed for a pre-existing custom-route receipt directory", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-custom-model-marker-dir-"));
    try {
      const { program } = customRouteProgram(root);
      const markerPath = path.join(root, ".nemoclaw-custom-route-pending");
      fs.mkdirSync(markerPath);

      const result = spawnSync("/usr/bin/python3", ["-I", "-c", program], {
        encoding: "utf-8",
        env: {
          ...process.env,
          NEMOCLAW_CUSTOM_ROUTE_MODEL_B64:
            Buffer.from("provider/selected-model").toString("base64"),
          NEMOCLAW_CUSTOM_ROUTE_LIMITS_B64: Buffer.from("{}").toString("base64"),
        },
      });

      expect(result.status).not.toBe(0);
      expect(fs.lstatSync(markerPath).isDirectory()).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
