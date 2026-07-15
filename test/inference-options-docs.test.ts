// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as TypeScript from "typescript";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { VLLM_IMAGES } from "../src/lib/inference/vllm.js";
import { getSandboxRuntimeInferenceEndpoint } from "../src/lib/onboard/docker-gpu-local-inference.js";
import { shouldForceCompletionsApi } from "../src/lib/validation.js";

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
const chooseModelPath = path.join(repoRoot, "docs", "inference", "choose-model.mdx");
const hermesProviderPath = path.join(repoRoot, "docs", "inference", "use-hermes-provider.mdx");
const releaseNotesPath = path.join(repoRoot, "docs", "changelog", "2026-07-09.mdx");
const inferenceDocsDir = path.join(repoRoot, "docs", "inference");
const docsNavPath = path.join(repoRoot, "docs", "index.yml");
const fernDocsPath = path.join(repoRoot, "fern", "docs.yml");
const compatibleEndpointPath = path.join(
  repoRoot,
  "docs",
  "inference",
  "set-up-openai-compatible-endpoint.mdx",
);
const inferenceRoutingPath = path.join(
  repoRoot,
  "docs",
  "inference",
  "how-inference-routing-works.mdx",
);
const compatibleApiPath = path.join(
  repoRoot,
  "docs",
  "inference",
  "choose-compatible-inference-api.mdx",
);
const localChoicePath = path.join(
  repoRoot,
  "docs",
  "inference",
  "choose-local-inference-server.mdx",
);
const vllmSetupPath = path.join(repoRoot, "docs", "inference", "set-up-vllm.mdx");
const troubleshootingPath = path.join(repoRoot, "docs", "reference", "troubleshooting.mdx");
const verifyInferenceRoutePath = path.join(
  repoRoot,
  "docs",
  "inference",
  "verify-inference-route.mdx",
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

function stripFencedCodeBlocks(markdown: string): string {
  return markdown.replace(
    /^ {0,3}(`{3,})(?!`)[^\n]*\n[\s\S]*?^ {0,3}\1`*[ \t]*$|^ {0,3}(~{3,})(?!~)[^\n]*\n[\s\S]*?^ {0,3}\2~*[ \t]*$/gm,
    "",
  );
}

describe("inference options model task-fit docs (#4755)", () => {
  // source-shape-contract: compatibility -- Published task-fit guidance must cover every curated onboarding model identifier
  it("keeps a per-model task-fit comparison table for curated onboarding models", () => {
    const markdown = fs.readFileSync(chooseModelPath, "utf8");
    const start = markdown.indexOf("## Model Task Fit");
    const end = markdown.indexOf("## Nemotron Deployment Choice", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const section = markdown.slice(start, end);

    expect(section).toContain(
      "| Model | Best for | Relative latency | Tool use | Context fit | Relative cost |",
    );
    expect(markdown).toContain("Runtime route validation determines current availability");
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
    const modelGuide = fs.readFileSync(chooseModelPath, "utf8");
    const hermesProvider = fs.readFileSync(hermesProviderPath, "utf8");

    expect(modelGuide).not.toMatch(matcher as RegExp);
    expect(hermesProvider).toContain(id);
  });
});

describe("inference setup navigation", () => {
  it("strips indented fenced examples with longer closing markers", () => {
    const prose = stripFencedCodeBlocks(
      "  ````md\n- fenced item\n\n- fenced item\n  `````\n- prose item\n- prose item",
    );

    expect(prose).not.toContain("fenced item");
    expect(prose).toContain("- prose item");
  });

  it("keeps simple list items compact across inference topics", () => {
    const spacedListItems =
      /^([ \t]*)(?:[-*+]|\d+\.)[ \t]+[^\n]+\n[ \t]*\n\1(?:[-*+]|\d+\.)[ \t]+/m;

    for (const fileName of fs
      .readdirSync(inferenceDocsDir)
      .filter((name) => name.endsWith(".mdx"))) {
      const markdown = fs.readFileSync(path.join(inferenceDocsDir, fileName), "utf8");
      const prose = stripFencedCodeBlocks(markdown);
      expect(prose, `${fileName} has a blank line between simple list items`).not.toMatch(
        spacedListItems,
      );
    }
  });

  it("routes the latest local and compatible inference release note through the shared chooser", () => {
    const markdown = fs.readFileSync(releaseNotesPath, "utf8");
    const releaseStart = markdown.indexOf("## v0.0.79");
    expect(releaseStart).toBeGreaterThanOrEqual(0);
    const release = markdown.slice(releaseStart);
    const bulletStart = release.indexOf("- Local and compatible inference setup");
    const bulletEnd = release.indexOf("\n- ", bulletStart + 1);
    expect(bulletStart).toBeGreaterThanOrEqual(0);
    expect(bulletEnd).toBeGreaterThan(bulletStart);
    const bullet = release.slice(bulletStart, bulletEnd);

    expect(bullet).toContain(
      "[Choose a Local Inference Server](/user-guide/openclaw/inference/local-inference/choose-local-inference-server)",
    );
    expect(bullet).not.toContain("/inference/local-inference/set-up-ollama");
  });

  it("routes local options to focused setup pages", () => {
    const markdown = fs.readFileSync(localChoicePath, "utf8");

    expect(markdown).toContain("[Set Up Ollama](set-up-ollama)");
    expect(markdown).toContain("[Set Up vLLM](set-up-vllm)");
    expect(markdown).toContain("[Set Up NVIDIA NIM](set-up-nvidia-nim)");
  });

  it("uses container-reachable binds with restricted exposure guidance (#5744)", () => {
    const markdown = fs.readFileSync(compatibleEndpointPath, "utf8");
    const hostValues = Array.from(
      markdown.matchAll(/--host(?:=|\s+)([^\s`\\]+)/g),
      (match) => match[1],
    );

    expect(hostValues).toEqual(["0.0.0.0", "0.0.0.0"]);
    expect(markdown).toContain("default-deny inbound rules");
    expect(markdown).toContain("only from the OpenShell Docker subnet to its gateway address");
  });

  it("keeps broad flat local-inference redirects on the chooser", () => {
    const config = parse(fs.readFileSync(fernDocsPath, "utf8")) as {
      redirects: Array<{ source: string; destination: string }>;
    };
    const redirects = new Map(
      config.redirects.map(({ source, destination }) => [source, destination]),
    );

    expect(redirects.get("/nemoclaw/latest/inference/use-local-inference")).toBe(
      "/nemoclaw/latest/user-guide/openclaw/inference/local-inference/choose-local-inference-server",
    );
    expect(redirects.get("/nemoclaw/inference/use-local-inference")).toBe(
      "/nemoclaw/user-guide/openclaw/inference/local-inference/choose-local-inference-server",
    );
  });

  it("uses a container-reachable bind with restricted exposure guidance", () => {
    const markdown = fs.readFileSync(vllmSetupPath, "utf8");
    const hostValues = Array.from(
      markdown.matchAll(/--host(?:=|\s+)([^\s`\\]+)/g),
      (match) => match[1],
    );

    expect(hostValues).toEqual(["0.0.0.0"]);
    expect(markdown).toContain("default-deny inbound rules");
    expect(markdown).toContain("only from the OpenShell Docker subnet to its gateway address");
  });

  it("keeps managed image tags, digests, and compressed sizes in sync with source", () => {
    const markdown = fs.readFileSync(vllmSetupPath, "utf8");
    const entries = [
      {
        prefix: "- DGX Spark and DGX Station",
        image: VLLM_IMAGES.ngc2605Post1.arm64,
        tag: VLLM_IMAGES.ngc2605Post1.tag,
      },
      {
        prefix: "- Generic Linux `arm64` hosts",
        image: VLLM_IMAGES.ngc2603Post1.arm64,
        tag: VLLM_IMAGES.ngc2603Post1.tag,
      },
      {
        prefix: "- Generic Linux `amd64` hosts",
        image: VLLM_IMAGES.ngc2603Post1.amd64,
        tag: VLLM_IMAGES.ngc2603Post1.tag,
      },
    ] as const;

    for (const { prefix, image, tag } of entries) {
      const line = markdown.split("\n").find((candidate) => candidate.startsWith(prefix));
      expect(line, `missing managed-image documentation for ${prefix}`).toBeDefined();
      expect(line).toContain(`\`${image.ref.split("@")[1]}\``);
      expect(line).toContain(`\`${(image.downloadSizeBytes / 1_000_000_000).toFixed(2)} GB\``);
      expect(line).toContain(`\`${tag}\``);
    }
  });

  it("keeps tool-calling remediation canonical in troubleshooting", () => {
    const markdown = fs.readFileSync(troubleshootingPath, "utf8");
    const start = markdown.indexOf("### Tool calls appear as assistant text");
    expect(start).toBeGreaterThanOrEqual(0);
    const nextHeading = markdown.indexOf("\n### ", start + 4);
    const end = nextHeading === -1 ? markdown.length : nextHeading;
    const section = markdown.slice(start, end);

    expect(section).toContain("[set up vLLM](../inference/local-inference/set-up-vllm)");
    expect(
      fs.existsSync(path.join(repoRoot, "docs", "inference", "fix-tool-calling-failures.mdx")),
    ).toBe(false);

    const nav = fs.readFileSync(docsNavPath, "utf8");
    expect(nav).toContain('section: "Validate Inference"');
    expect(nav).not.toContain('section: "Validate and Troubleshoot"');
  });

  it("documents compatible-endpoint probing separately from runtime API selection", () => {
    const markdown = fs.readFileSync(compatibleApiPath, "utf8");

    expect(shouldForceCompletionsApi("openai-completions")).toBe(true);
    expect(shouldForceCompletionsApi("openai-responses")).toBe(false);
    expect(markdown).toContain("NemoClaw probes `/v1/responses` first");
    expect(markdown).toContain("the sandbox still uses `/v1/chat/completions`");
    expect(markdown).toContain(
      "Set `NEMOCLAW_PREFERRED_API=openai-completions` to skip the Responses probe and validate only `/v1/chat/completions`.",
    );
  });

  it("scopes post-ready sandbox route verification to local inference providers", () => {
    const markdown = fs.readFileSync(verifyInferenceRoutePath, "utf8");
    const start = markdown.indexOf("## Understand Post-Ready Checks");
    const end = markdown.indexOf("## Send a Short Agent Request", start);
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
    expect(section).toContain("For local Ollama and vLLM");
    expect(section).toContain("NVIDIA NIM and other compatible endpoints");
  });

  it("explains the host-side validation limit of the containerized gateway alias", () => {
    const markdown = fs.readFileSync(compatibleEndpointPath, "utf8");
    const result = probeOpenAiLikeEndpoint(
      "http://host.openshell.internal:8000/v1",
      "test-model",
      "test-key",
    );

    expect(result).toMatchObject({ api: null, label: null, ok: true });
    expect(result.note).toContain("validation skipped");
    expect(markdown).toContain("`http://host.openshell.internal:8000/v1`");
    expect(markdown).toContain(
      "To qualify for automatic rewriting, an HTTP endpoint URL must use the exact loopback host `localhost`, `127.0.0.1`, or `[::1]`.",
    );
    expect(markdown).toContain(
      "Automatic rewriting is limited to NemoClaw's bundled host-gateway ports: `8000`, `11434`, and `11435`.",
    );
    expect(markdown).toContain(
      "NemoClaw validates the entered URL from the host and registers the OpenShell gateway route through `host.openshell.internal:<port>` for sandbox traffic.",
    );
    expect(markdown).toContain(
      "Sandbox inference requests continue to use the base `inference.local` policy, so the managed compatible-endpoint route does not require adding the `local-inference` preset.",
    );
    expect(markdown).toContain(
      "NemoClaw leaves URLs without an explicit port, URLs on `:80` or another privileged port, and URLs on unsupported ports unchanged.",
    );
    expect(markdown).not.toContain("the default HTTP port or an unprivileged port");
    expect(markdown).toContain(
      "if that bridge is unavailable, onboarding can still validate the host URL, but `$$nemoclaw <name> status` is the authoritative runtime check.",
    );
    expect(markdown).toContain(
      "If you manually enter a sandbox-internal alias such as `http://host.openshell.internal:8000/v1`, host-side endpoint probing is skipped during onboarding.",
    );
    expect(markdown).toContain(
      "Use a host-routable endpoint such as `localhost` when you need onboarding to verify the API, tool-calling, and streaming paths",
    );
  });

  it("documents credential-free recovery of automatically bridged routes (#5744)", () => {
    const markdown = fs.readFileSync(inferenceRoutingPath, "utf8");

    expect(markdown).toContain(
      "When a rebuild reuses an automatically bridged compatible-endpoint route without a host API key, NemoClaw reapplies the config-only bridge rewrite without reading or passing the credential stored in OpenShell.",
    );
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

  it("retains self-hosted setup and verification guidance across focused pages", () => {
    const endpoint = fs.readFileSync(compatibleEndpointPath, "utf8");
    const vllm = fs.readFileSync(vllmSetupPath, "utf8");
    const verification = fs.readFileSync(verifyInferenceRoutePath, "utf8");

    expect(endpoint).toContain("NEMOCLAW_MODEL=NVIDIA-Nemotron3-Nano-4B-Q4_K_M.gguf");
    expect(vllm).toContain(
      "NemoClaw uses that value for the configured context window unless you set `NEMOCLAW_CONTEXT_WINDOW`.",
    );
    expect(endpoint).toContain("Port `8000` is one of NemoClaw's bundled host-gateway ports.");
    expect(vllm).toContain("Docker's `--restart unless-stopped` policy");
    expect(verification).toContain(
      "The `Inference` row checks the sandbox's `inference.local` path",
    );
  });
});
