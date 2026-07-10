// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as TypeScript from "typescript";
import { describe, expect, it } from "vitest";
import { shouldForceCompletionsApi } from "../src/lib/validation.js";
import { getSandboxRuntimeInferenceEndpoint } from "../src/lib/onboard/docker-gpu-local-inference.js";

const require = createRequire(import.meta.url);
const ts = require("typescript") as typeof TypeScript;
const { probeOpenAiLikeEndpoint } = require("../src/lib/inference/onboard-probes") as {
  probeOpenAiLikeEndpoint: (
    endpointUrl: string,
    model: string,
    apiKey: string,
    options?: { requireChatCompletionsToolCalling?: boolean },
  ) => { api: string | null; label: string | null; note?: string; ok: boolean };
};
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inferenceOptionsPath = path.join(repoRoot, "docs", "inference", "inference-options.mdx");
const releaseNotesPath = path.join(repoRoot, "docs", "about", "release-notes.mdx");
const selfHostedInferenceSetupPath = path.join(
  repoRoot,
  "docs",
  "inference",
  "local-compatible-inference-setup.mdx",
);
const toolCallingReliabilityPath = path.join(
  repoRoot,
  "docs",
  "inference",
  "tool-calling-reliability.mdx",
);
const subAgentSetupPath = path.join(repoRoot, "docs", "inference", "set-up-sub-agent.mdx");
const inferenceConfigPath = path.join(repoRoot, "src", "lib", "inference", "config.ts");
const modelPromptsPath = path.join(repoRoot, "src", "lib", "inference", "model-prompts.ts");

/**
 * Removes TypeScript `as const` wrappers before inspecting literal AST nodes.
 */
function unwrapConstAssertion(expression: TypeScript.Expression): TypeScript.Expression {
  return ts.isAsExpression(expression) ? unwrapConstAssertion(expression.expression) : expression;
}

function readExportedConstInitializer(
  sourcePath: string,
  exportName: string,
): { sourceFile: TypeScript.SourceFile; initializer: TypeScript.Expression } {
  const source = fs.readFileSync(sourcePath, "utf8");
  const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true);

  const declaration = sourceFile.statements
    .filter(
      (statement): statement is TypeScript.VariableStatement =>
        ts.isVariableStatement(statement) &&
        (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
          false),
    )
    .flatMap((statement) => Array.from(statement.declarationList.declarations))
    .find((candidate) => candidate.name.getText(sourceFile) === exportName);
  expect(declaration).toBeTruthy();

  const initializer = declaration?.initializer && unwrapConstAssertion(declaration.initializer);
  expect(initializer).toBeTruthy();

  return { sourceFile, initializer: initializer as TypeScript.Expression };
}

function readCuratedCloudModelIds(): string[] {
  const { sourceFile, initializer } = readExportedConstInitializer(
    inferenceConfigPath,
    "CLOUD_MODEL_OPTIONS",
  );
  expect(ts.isArrayLiteralExpression(initializer)).toBe(true);

  return (initializer as TypeScript.ArrayLiteralExpression).elements.map((element) => {
    expect(ts.isObjectLiteralExpression(element)).toBe(true);
    const idProperty = (element as TypeScript.ObjectLiteralExpression).properties.find(
      (property) =>
        ts.isPropertyAssignment(property) &&
        property.name.getText(sourceFile) === "id" &&
        ts.isStringLiteralLike(unwrapConstAssertion(property.initializer)),
    );
    expect(idProperty).toBeTruthy();
    const idInitializer = unwrapConstAssertion(
      (idProperty as TypeScript.PropertyAssignment).initializer,
    );
    return (idInitializer as TypeScript.StringLiteral).text;
  });
}

function readRemoteModelIds(providerKey: string): string[] {
  const { sourceFile, initializer } = readExportedConstInitializer(
    modelPromptsPath,
    "REMOTE_MODEL_OPTIONS",
  );
  expect(ts.isObjectLiteralExpression(initializer)).toBe(true);

  const providerProperty = (initializer as TypeScript.ObjectLiteralExpression).properties.find(
    (property) =>
      ts.isPropertyAssignment(property) && property.name.getText(sourceFile) === providerKey,
  );
  expect(providerProperty).toBeTruthy();

  const providerInitializer = unwrapConstAssertion(
    (providerProperty as TypeScript.PropertyAssignment).initializer,
  );
  expect(ts.isArrayLiteralExpression(providerInitializer)).toBe(true);

  return (providerInitializer as TypeScript.ArrayLiteralExpression).elements.map((element) => {
    expect(ts.isStringLiteralLike(unwrapConstAssertion(element))).toBe(true);
    return (unwrapConstAssertion(element) as TypeScript.StringLiteral).text;
  });
}

/**
 * Reads curated onboarding model IDs from source config instead of duplicating them in docs tests.
 */
function readCuratedOnboardingModelIds(): string[] {
  return [
    ...readCuratedCloudModelIds(),
    ...readRemoteModelIds("openai"),
    ...readRemoteModelIds("anthropic"),
    ...readRemoteModelIds("gemini"),
  ];
}

describe("inference options model task-fit docs (#4755)", () => {
  it("keeps a per-model task-fit comparison table for curated onboarding models", () => {
    const markdown = fs.readFileSync(inferenceOptionsPath, "utf8");
    const start = markdown.indexOf("## Model Task-Fit Guide");
    const end = markdown.indexOf("## Choosing the Right Option for Nemotron", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const section = markdown.slice(start, end);

    expect(section).toContain(
      "| Model | Best-for task type | Relative latency | Tool-use quality | Context-window fit | Relative cost |",
    );
    expect(section).toContain(
      "Successful runtime route validation determines current availability",
    );
    expect(section).not.toMatch(/\bTBD\b|\bTODO\b/i);
    expect(section).not.toContain("Very large context");

    const documentedModelIds = Array.from(
      section.matchAll(/^\| `([^`]+)` \|/gm),
      (match) => match[1],
    );
    expect(documentedModelIds).toEqual(readCuratedOnboardingModelIds());
  });

  it.each([
    ["GLM 5.1", /GLM-?5\.1|z-ai\/glm-5\.1/i, "`z-ai/glm-5.1`"],
    ["Kimi K2.6", /Kimi K2\.6|moonshotai\/kimi-k2\.6/i, "`moonshotai/kimi-k2.6`"],
  ])("keeps %s scoped to the independent Hermes Provider catalog", (_label, matcher, id) => {
    const markdown = fs.readFileSync(inferenceOptionsPath, "utf8");
    const start = markdown.indexOf("## Provider Options");
    const end = markdown.indexOf("## Model Task-Fit Guide", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const section = markdown.slice(start, end);
    const lines = section.split("\n");
    const nvidiaRow = lines.find((line) => line.startsWith("| NVIDIA Endpoints |"));
    const hermesRow = lines.find((line) => line.startsWith("| Hermes Provider |"));

    expect(nvidiaRow).toBeDefined();
    expect(nvidiaRow).not.toMatch(matcher as RegExp);
    expect(hermesRow).toContain(id);
  });
});

describe("inference setup navigation", () => {
  it("routes the latest local and compatible inference release note to both setup guides (#6590)", () => {
    const markdown = fs.readFileSync(releaseNotesPath, "utf8");
    const releaseStart = markdown.indexOf("## v0.0.79");
    const releaseEnd = markdown.indexOf("## v0.0.78", releaseStart);
    expect(releaseStart).toBeGreaterThanOrEqual(0);
    expect(releaseEnd).toBeGreaterThan(releaseStart);
    const release = markdown.slice(releaseStart, releaseEnd);
    const bulletStart = release.indexOf("- Local and compatible inference setup");
    const bulletEnd = release.indexOf("\n- ", bulletStart + 1);
    expect(bulletStart).toBeGreaterThanOrEqual(0);
    expect(bulletEnd).toBeGreaterThan(bulletStart);
    const bullet = release.slice(bulletStart, bulletEnd);

    expect(bullet).toContain("[Use Ollama for Local Inference](../inference/use-local-inference)");
    expect(bullet).toContain(
      "[Set Up Self-Hosted Inference Servers](../inference/local-compatible-inference-setup)",
    );
    expect(bullet).not.toContain("[Use a Local Inference Server]");
  });

  it("routes caveated vLLM and NIM setup to the self-hosted server guide", () => {
    const markdown = fs.readFileSync(inferenceOptionsPath, "utf8");
    const start = markdown.indexOf("## Caveated Local Options");
    const end = markdown.indexOf("## Validation", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const section = markdown.slice(start, end);

    expect(section).toContain(
      "[Set Up Self-Hosted Inference Servers](local-compatible-inference-setup)",
    );
    expect(section).toContain("[Use Ollama for Local Inference](use-local-inference)");
  });

  it("uses a loopback-only bind for the raw model server example", () => {
    const markdown = fs.readFileSync(selfHostedInferenceSetupPath, "utf8");

    expect(markdown).toContain("--host 127.0.0.1");
    expect(markdown).not.toContain("--host 0.0.0.0");
  });

  it("routes vLLM tool-calling remediation to the self-hosted server guide", () => {
    const markdown = fs.readFileSync(toolCallingReliabilityPath, "utf8");
    const start = markdown.indexOf("## Next Steps");
    expect(start).toBeGreaterThanOrEqual(0);
    const section = markdown.slice(start);

    expect(section).toContain(
      "[Set Up Self-Hosted Inference Servers](local-compatible-inference-setup)",
    );
  });

  it("documents compatible-endpoint probing separately from runtime API selection", () => {
    const markdown = fs.readFileSync(selfHostedInferenceSetupPath, "utf8");

    expect(shouldForceCompletionsApi("openai-completions")).toBe(true);
    expect(shouldForceCompletionsApi("openai-responses")).toBe(false);
    expect(markdown).toContain(
      "the wizard probes `/v1/responses` first with tool-calling and streaming checks, then falls back to `/v1/chat/completions`.",
    );
    expect(markdown).toContain(
      "Unless you explicitly set `NEMOCLAW_PREFERRED_API=openai-responses`, the runtime still uses `/v1/chat/completions`.",
    );
    expect(markdown).toContain(
      "Set `NEMOCLAW_PREFERRED_API=openai-completions` to skip the Responses probe and validate Chat Completions only.",
    );
  });

  it("scopes post-ready sandbox route verification to local inference providers", () => {
    const markdown = fs.readFileSync(selfHostedInferenceSetupPath, "utf8");
    const start = markdown.indexOf("## Verify the Local vLLM Sandbox Route");
    const end = markdown.indexOf("## Timeout Configuration", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const section = markdown.slice(start, end);

    expect(getSandboxRuntimeInferenceEndpoint("ollama-local")).toBe(
      "https://inference.local/v1/models",
    );
    expect(getSandboxRuntimeInferenceEndpoint("vllm-local")).toBe(
      "https://inference.local/v1/models",
    );
    expect(getSandboxRuntimeInferenceEndpoint("nvidia-nim")).toBeNull();
    expect(getSandboxRuntimeInferenceEndpoint("compatible-endpoint")).toBeNull();
    expect(section).toContain("For a local vLLM server on a Linux Docker-driver GPU sandbox");
    expect(section).toContain("The same post-ready check also applies to local Ollama.");
    expect(section).toContain(
      "NIM and other compatible endpoints receive their onboarding endpoint validation, but not this post-ready sandbox route check.",
    );
  });

  it("explains the host-side validation limit of the containerized gateway alias", () => {
    const markdown = fs.readFileSync(selfHostedInferenceSetupPath, "utf8");
    const hostGatewayAlias = "`http://host.openshell.internal:8000/v1`";
    const result = probeOpenAiLikeEndpoint(
      "http://host.openshell.internal:8000/v1",
      "test-model",
      "test-key",
    );

    expect(result).toMatchObject({ api: null, label: null, ok: true });
    expect(result.note).toContain("validation skipped");
    expect(markdown).toContain("`http://host.openshell.internal:8000/v1`");
    expect(markdown).toContain(
      "This is a sandbox-internal alias, so host-side endpoint probing is skipped during onboarding.",
    );
    expect(markdown).toContain(
      "Use a routable endpoint when you need onboarding to verify the API, tool-calling, and streaming paths.",
    );
    const textAfterEachAlias = markdown.split(hostGatewayAlias).slice(1);
    expect(textAfterEachAlias).toHaveLength(2);
    for (const followingText of textAfterEachAlias) {
      expect(followingText.slice(0, 450)).toMatch(
        /host-side endpoint probing is skipped during onboarding/i,
      );
    }
  });

  it("keeps provider credentials out of documented helper argv", () => {
    const markdown = fs.readFileSync(subAgentSetupPath, "utf8");

    for (const secretName of [
      "NVIDIA_API_KEY",
      "NGC_API_KEY",
      "HF_TOKEN",
      "HUGGING_FACE_HUB_TOKEN",
    ]) {
      const positionalSecret = new RegExp(
        String.raw`\b(?:python3?|node|bash|sh)\b[^\n]*\$(?:\{)?${secretName}(?:\})?`,
      );
      expect(markdown).not.toMatch(positionalSecret);
    }
    expect(markdown).toContain('os.environ["NVIDIA_API_KEY"]');
  });

  it("retains shared self-hosted setup and verification guidance after the Ollama split", () => {
    const markdown = fs.readFileSync(selfHostedInferenceSetupPath, "utf8");
    const nonInteractiveStart = markdown.indexOf("### Non-Interactive Setup");
    const nonInteractiveEnd = markdown.indexOf("### Selecting the API Path", nonInteractiveStart);
    expect(nonInteractiveStart).toBeGreaterThanOrEqual(0);
    expect(nonInteractiveEnd).toBeGreaterThan(nonInteractiveStart);
    const nonInteractiveSection = markdown.slice(nonInteractiveStart, nonInteractiveEnd);

    expect(markdown).toContain("The agent inside the sandbox connects through `inference.local`");
    expect(markdown).toContain("NEMOCLAW_MODEL=NVIDIA-Nemotron3-Nano-4B-Q4_K_M.gguf");
    expect(markdown).toContain(
      "NemoClaw uses that value for the configured context window unless you set `NEMOCLAW_CONTEXT_WINDOW` yourself.",
    );
    expect(markdown).not.toContain("baked into `openclaw.json`");
    expect(markdown).toContain(
      "The Chat Completions default avoids local backends that accept Responses requests but drop system prompts or tool definitions.",
    );
    expect(markdown).toContain(
      "Port `8000` is included in NemoClaw's `local-inference` policy preset.",
    );
    expect(markdown).toContain(
      "The managed container uses Docker's `--restart unless-stopped` policy, so Docker restarts it after a host or Docker daemon restart unless an operator explicitly stopped it.",
    );
    expect(markdown).toContain("## Verify the Configuration");
    expect(markdown).toContain(
      "The `Inference` row checks `inference.local` from inside the sandbox",
    );
    expect(nonInteractiveSection).not.toMatch(/^\s+NEMOCLAW_REASONING=true \\/m);
  });
});
