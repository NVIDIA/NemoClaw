// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { exportLlamaCppDgxSparkQualificationPlan } from "../../../scripts/checks/export-llama-cpp-dgx-spark-qualification-plan.mts";
import {
  LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROBES,
  parseLlamaCppDgxSparkExecutionPlan,
  parseLlamaCppDgxSparkQualificationPlan,
} from "../../../scripts/checks/llama-cpp-dgx-spark-qualification-contract.mts";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const temporaryRoots: string[] = [];

function candidateRoot(options: { activation?: string; enabled?: boolean } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-llama-cpp-plan-"));
  temporaryRoots.push(root);
  const imageDirectory = path.join(root, "managed-inference", "images", "llama-cpp");
  const qualificationDirectory = path.join(root, "managed-inference", "qualifications");
  const recipeDirectory = path.join(root, "managed-inference", "recipes");
  fs.mkdirSync(imageDirectory, { recursive: true });
  fs.mkdirSync(qualificationDirectory, { recursive: true });
  fs.mkdirSync(recipeDirectory, { recursive: true });

  const sourceImage = fs.readFileSync(
    path.join(repoRoot, "managed-inference", "images", "llama-cpp", "image.yaml"),
    "utf8",
  );
  const imageDocument = YAML.parse(sourceImage) as {
    spec: {
      publication: {
        enabled: boolean;
        qualification: {
          environment: string | null;
          execution: "disabled" | "enabled";
          model: { hostPath: string | null };
          runner: string | null;
        };
      };
    };
  };
  imageDocument.spec.publication.enabled = options.enabled ?? false;
  const qualification = imageDocument.spec.publication.qualification;
  qualification.execution = options.enabled ? "enabled" : "disabled";
  qualification.runner = options.enabled ? "linux-arm64-gpu-dgx-spark-gb10-protected-1" : null;
  qualification.environment = options.enabled ? "approve-dgx-spark-image-qualification" : null;
  qualification.model.hostPath = options.enabled
    ? "/var/lib/nemoclaw/models/Nemotron-3-Nano-30B-A3B-UD-Q4_K_XL.gguf"
    : null;
  const image = YAML.stringify(imageDocument);
  fs.writeFileSync(path.join(imageDirectory, "image.yaml"), image);
  fs.copyFileSync(
    path.join(
      repoRoot,
      "managed-inference",
      "recipes",
      "llama-cpp.nemotron-3-nano-30b-a3b.spark-single.v1.yaml",
    ),
    path.join(recipeDirectory, "llama-cpp.nemotron-3-nano-30b-a3b.spark-single.v1.yaml"),
  );
  fs.copyFileSync(
    path.join(
      repoRoot,
      "managed-inference",
      "qualifications",
      "llama-cpp.openclaw.spark-single.v1.yaml",
    ),
    path.join(qualificationDirectory, "llama-cpp.openclaw.spark-single.v1.yaml"),
  );
  for (const activation of options.activation === undefined ? [] : [options.activation]) {
    const activationPath = path.join(root, "ci", "llama-cpp-dgx-spark-qualification-v1.yaml");
    fs.mkdirSync(path.dirname(activationPath), { recursive: true });
    fs.writeFileSync(activationPath, activation);
  }
  return root;
}

const activation = `contractVersion: 1
jobId: llama-cpp-dgx-spark-qualification
platform: linux/arm64
profile: dgx-spark-gb10-single
`;

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("llama.cpp DGX Spark qualification plan export (#8260)", () => {
  it("exports only an activated, enabled declarative qualification", () => {
    const output = exportLlamaCppDgxSparkQualificationPlan(
      candidateRoot({ activation, enabled: true }),
    );

    expect(output.execution).toBe("enabled");
    expect(output.agent_qualification_execution).toBe("enabled");
    expect(output.runner).toBe("linux-arm64-gpu-dgx-spark-gb10-protected-1");
    expect(parseLlamaCppDgxSparkQualificationPlan(JSON.parse(output.qualification))).toMatchObject({
      execution: "enabled",
      platform: "linux/arm64",
      profile: "dgx-spark-gb10-single",
    });
    expect(
      parseLlamaCppDgxSparkExecutionPlan(JSON.parse(output.plan), output.plan_sha256),
    ).toMatchObject({
      contractVersion: 1,
      qualification: {
        agentQualification: {
          agent: "openclaw",
          execution: "enabled",
          runtimeProvider: "docker",
        },
        probeBounds: {
          cancellationMaxTokens: 4096,
          clientTimeoutMilliseconds: 250,
          maxResponseBytes: 16777216,
          maxStreamEvents: 512,
          maxTokens: {
            streamingChat: 32,
            structuredOutput: 64,
            synchronousChat: 16,
            toolCall: 256,
            toolResultContinuation: 64,
          },
        },
        probes: LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROBES,
      },
      recipe: {
        capabilities: {
          agents: [],
          protocols: ["openai-completions"],
          streaming: true,
          structuredOutputs: true,
          toolCalls: true,
        },
      },
    });
  });

  it("exports the checked-in main qualification as enabled", () => {
    const output = exportLlamaCppDgxSparkQualificationPlan(repoRoot);

    expect(output).toMatchObject({
      agent_qualification_execution: "enabled",
      environment: "approve-dgx-spark-image-qualification",
      execution: "enabled",
      model_host_path: "/var/lib/nemoclaw/models/Nemotron-3-Nano-30B-A3B-UD-Q4_K_XL.gguf",
      runner: "linux-arm64-gpu-dgx-spark-gb10-protected-1",
    });
  });

  it("rejects a dormant image even when an activation file exists", () => {
    expect(() => exportLlamaCppDgxSparkQualificationPlan(candidateRoot({ activation }))).toThrow(
      "protected llama.cpp DGX Spark qualification is not enabled",
    );
  });

  it("rejects enabled infrastructure without the explicit activation file", () => {
    expect(() =>
      exportLlamaCppDgxSparkQualificationPlan(candidateRoot({ enabled: true })),
    ).toThrow();
  });

  it("rejects duplicate activation keys", () => {
    expect(() =>
      exportLlamaCppDgxSparkQualificationPlan(
        candidateRoot({
          activation: `${activation}profile: dgx-spark-gb10-single\n`,
          enabled: true,
        }),
      ),
    ).toThrow();
  });
});
