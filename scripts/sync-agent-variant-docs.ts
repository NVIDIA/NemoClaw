// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = path.join(repoRoot, "docs");
const sourcePath = path.join(repoRoot, "docs/reference/commands.mdx");
const targetPath = path.join(repoRoot, "docs/reference/commands-nemohermes.mdx");
const generatedDocsRoot = path.join(repoRoot, "docs/_build/agent-variants");
const agentVariants = ["openclaw", "hermes"] as const;

type AgentVariant = (typeof agentVariants)[number];
type RenderedFile = {
  path: string;
  contents: string;
};
type RenderTarget = {
  sourcePath: string;
  variant: AgentVariant;
};
type RenderAgentVariantOptions = {
  outputPath?: string;
  sourcePath?: string;
};
type DocsIndex = {
  navigation?: NavigationItem[];
};
type NavigationItem = {
  variants?: NavigationVariant[];
  layout?: NavigationNode[];
  contents?: NavigationNode[];
  path?: string;
  slug?: string;
};
type NavigationVariant = {
  slug?: string;
  layout?: NavigationNode[];
};
type NavigationNode = {
  contents?: NavigationNode[];
  path?: string;
};

const GENERATED_NOTICE =
  "{/* This file is generated from docs/reference/commands.mdx by scripts/sync-agent-variant-docs.ts. Run `npm run docs:sync-agent-variants` to regenerate it. Do not edit by hand. */}";
const GENERATED_VARIANT_NOTICE =
  "{/* This file is generated from a shared agent-variant source by scripts/sync-agent-variant-docs.ts. Run `npm run docs:sync-agent-variants` to regenerate it. Do not edit by hand. */}";
const CLI_SENTINEL = "$$nemoclaw";

const checkOnly = process.argv.includes("--check");

function main(): void {
  const source = readFileSync(sourcePath, "utf8");
  const rendered = renderHermesCommandsReference(source);
  const existing = readOptionalTarget();
  const generatedVariantPages = renderGeneratedAgentVariantPages();

  if (checkOnly) {
    if (existing !== rendered) {
      console.error(
        "docs/reference/commands-nemohermes.mdx is out of sync. Run `npm run docs:sync-agent-variants`.",
      );
      process.exit(1);
    }
    writeGeneratedFiles(generatedVariantPages);
    return;
  }

  if (existing !== rendered) {
    writeFileSync(targetPath, rendered);
    console.log(`Wrote ${path.relative(repoRoot, targetPath)}`);
  } else {
    console.log(`${path.relative(repoRoot, targetPath)} is already up to date`);
  }
  writeGeneratedFiles(generatedVariantPages);
}

export function renderHermesCommandsReference(source: string): string {
  const { frontmatter, body } = splitFrontmatter(source);
  const hermesFrontmatter = updateFrontmatter(frontmatter);
  const hermesBody = transformNemoclawCliInvocations(
    stripAgentOnlyBlocks(body).replace(
      /^import \{ AgentOnly \} from "\.\.\/_components\/AgentGuide";\n\n?/m,
      "",
    ),
  )
    .replaceAll(CLI_SENTINEL, "nemohermes")
    .replace(/\n{3,}/g, "\n\n")
    .trimStart();

  return `${hermesFrontmatter}${GENERATED_NOTICE}\n\n${hermesBody}`.replace(/\s*$/, "\n");
}

function splitFrontmatter(source: string): { frontmatter: string; body: string } {
  const match = source.match(/^(\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n)([\s\S]*)$/);
  if (!match) {
    throw new Error("commands.mdx must start with YAML frontmatter");
  }
  return { frontmatter: match[1], body: match[2] };
}

function updateFrontmatter(frontmatter: string): string {
  let next = frontmatter;
  next = replaceFrontmatterLine(next, "title", '"NemoHermes CLI Commands Reference"');
  next = replaceFrontmatterLine(next, "sidebar-title", '"Commands"');
  next = replaceFrontmatterLine(
    next,
    "description",
    '"Full CLI reference for standalone NemoHermes commands and Hermes-specific in-sandbox commands."',
  );
  next = replaceFrontmatterLine(
    next,
    "description-agent",
    '"Includes the full CLI reference for standalone NemoHermes commands and Hermes-specific in-sandbox commands. Use when looking up a specific `nemohermes` subcommand, flag, argument, or exit code."',
  );
  next = replaceFrontmatterLine(
    next,
    "keywords",
    '["nemohermes cli commands", "hermes command reference", "nemohermes command reference"]',
  );
  next = upsertFrontmatterLine(next, "exclude-from-skills-gen", "true");
  return next;
}

function replaceFrontmatterLine(frontmatter: string, key: string, value: string): string {
  const pattern = new RegExp(`^${escapeRegExp(key)}:.*$`, "m");
  if (!pattern.test(frontmatter)) {
    throw new Error(`commands.mdx frontmatter is missing '${key}'`);
  }
  return frontmatter.replace(pattern, `${key}: ${value}`);
}

function upsertFrontmatterLine(frontmatter: string, key: string, value: string): string {
  const pattern = new RegExp(`^${escapeRegExp(key)}:.*$`, "m");
  if (pattern.test(frontmatter)) {
    return frontmatter.replace(pattern, `${key}: ${value}`);
  }
  return frontmatter.replace(/\n---\n$/, `\n${key}: ${value}\n---\n`);
}

function stripAgentOnlyBlocks(body: string): string {
  return stripAgentOnlyBlocksForVariant(body, "hermes");
}

function stripAgentOnlyBlocksForVariant(body: string, activeVariant: AgentVariant): string {
  return body.replace(
    /\n?<AgentOnly variant="(openclaw|hermes)">\n([\s\S]*?)\n<\/AgentOnly>\n?/g,
    (_match, variant: string, content: string) => {
      if (variant !== activeVariant) return "\n";
      return `\n${content.trim()}\n`;
    },
  );
}

export function renderAgentVariantPage(
  source: string,
  variant: AgentVariant,
  options: RenderAgentVariantOptions = {},
): string {
  const { frontmatter, body } = splitFrontmatter(source);
  const renderedFrontmatter = frontmatter.replaceAll(
    CLI_SENTINEL,
    variant === "hermes" ? "nemohermes" : "nemoclaw",
  );
  let renderedBody = stripAgentOnlyBlocksForVariant(
    body.replace(/^import \{ AgentOnly \} from "\.\.\/_components\/AgentGuide";\n\n?/m, ""),
    variant,
  )
    .replaceAll(CLI_SENTINEL, variant === "hermes" ? "nemohermes" : "nemoclaw")
    .replace(/\n{3,}/g, "\n\n")
    .trimStart();

  if (options.sourcePath && options.outputPath) {
    renderedBody = rewriteRelativePaths(renderedBody, options.sourcePath, options.outputPath);
  }

  return `${renderedFrontmatter}${GENERATED_VARIANT_NOTICE}\n\n${renderedBody}`.replace(
    /\s*$/,
    "\n",
  );
}

function renderGeneratedAgentVariantPages(): RenderedFile[] {
  return findAgentVariantTargets().map(({ sourcePath, variant }) => {
    const sourceFilePath = path.join(docsRoot, sourcePath);
    const source = readFileSync(sourceFilePath, "utf8");
    const basename = path.basename(sourceFilePath, ".mdx");
    const relativeSourceDirectory = path.relative(docsRoot, path.dirname(sourceFilePath));
    const outputPath = path.join(
      generatedDocsRoot,
      relativeSourceDirectory,
      `${basename}.${variant}.generated.mdx`,
    );
    return {
      path: outputPath,
      contents: renderAgentVariantPage(source, variant, {
        outputPath,
        sourcePath: sourceFilePath,
      }),
    };
  });
}

function findAgentVariantTargets(): RenderTarget[] {
  const sharedSources = findSharedNavigationSourcePaths();
  assertNoUnsharedPlaceholders(sharedSources);
  return findGeneratedNavigationTargets().sort((left, right) => {
    const sourceOrder = left.sourcePath.localeCompare(right.sourcePath);
    return sourceOrder === 0 ? left.variant.localeCompare(right.variant) : sourceOrder;
  });
}

function findGeneratedNavigationTargets(): RenderTarget[] {
  const docsIndex = parse(readFileSync(path.join(docsRoot, "index.yml"), "utf8")) as DocsIndex;
  const userGuide = docsIndex.navigation?.find((item) => Array.isArray(item.variants));
  if (!userGuide?.variants) {
    throw new Error("docs/index.yml must define navigation variants");
  }
  return userGuide.variants.flatMap((variant) => {
    if (variant.slug !== "openclaw" && variant.slug !== "hermes") return [];
    return collectGeneratedTargets(variant.layout ?? [], variant.slug);
  });
}

function collectGeneratedTargets(nodes: NavigationNode[], variant: AgentVariant): RenderTarget[] {
  return nodes.flatMap((node): RenderTarget[] => {
    const sourcePath = normalizeGeneratedNavigationSourcePath(node.path);
    const current = sourcePath ? [{ sourcePath, variant }] : [];
    return node.contents
      ? [...current, ...collectGeneratedTargets(node.contents, variant)]
      : current;
  });
}

function findSharedNavigationSourcePaths(): Set<string> {
  const docsIndex = parse(readFileSync(path.join(docsRoot, "index.yml"), "utf8")) as DocsIndex;
  const userGuide = docsIndex.navigation?.find((item) => Array.isArray(item.variants));
  const openclaw = userGuide?.variants?.find((variant) => variant.slug === "openclaw");
  const hermes = userGuide?.variants?.find((variant) => variant.slug === "hermes");
  if (!openclaw?.layout || !hermes?.layout) {
    throw new Error("docs/index.yml must define openclaw and hermes navigation variants");
  }

  const openclawPaths = collectSourcePaths(openclaw.layout);
  const hermesPaths = collectSourcePaths(hermes.layout);
  return new Set([...openclawPaths].filter((sourcePath) => hermesPaths.has(sourcePath)));
}

function collectSourcePaths(nodes: NavigationNode[]): Set<string> {
  const paths = new Set<string>();
  for (const node of nodes) {
    const sourcePath = normalizeNavigationSourcePath(node.path);
    if (sourcePath) paths.add(sourcePath);
    if (node.contents) {
      for (const childPath of collectSourcePaths(node.contents)) {
        paths.add(childPath);
      }
    }
  }
  return paths;
}

function normalizeNavigationSourcePath(navPath: string | undefined): string | null {
  if (!navPath) return null;
  const sourcePath =
    normalizeGeneratedNavigationSourcePath(navPath) ?? normalizeLegacyVariantSource(navPath);
  if (!sourcePath.endsWith(".mdx") || sourcePath === "index.mdx") return null;
  return sourcePath;
}

function normalizeGeneratedNavigationSourcePath(navPath: string | undefined): string | null {
  if (!navPath) return null;
  const generatedMatch = navPath.match(
    /^_build\/agent-variants\/(.+)\.(?:openclaw|hermes)\.generated\.mdx$/,
  );
  return generatedMatch?.[1] ? `${generatedMatch[1]}.mdx` : null;
}

function normalizeLegacyVariantSource(navPath: string): string {
  if (navPath === "reference/commands-nemohermes.mdx") return "reference/commands.mdx";
  return navPath;
}

function assertNoUnsharedPlaceholders(sharedSources: Set<string>): void {
  const offenderPaths: string[] = [];
  for (const sourcePath of findPlaceholderSourcePaths()) {
    if (!sharedSources.has(sourcePath)) offenderPaths.push(sourcePath);
  }
  if (offenderPaths.length > 0) {
    throw new Error(
      [
        "The following non-shared nav pages contain $$nemoclaw and would render it literally:",
        ...offenderPaths.map((offenderPath) => `  - docs/${offenderPath}`),
        "Use a literal CLI name on single-variant pages, or add the page to both nav variants.",
      ].join("\n"),
    );
  }
}

function findPlaceholderSourcePaths(): string[] {
  const files: string[] = [];
  walkDocs(docsRoot, files);
  return files.sort();
}

function walkDocs(directory: string, files: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith("_")) continue;
      walkDocs(entryPath, files);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".mdx")) continue;
    if (entry.name.endsWith(".generated.mdx") || entry.name === "commands-nemohermes.mdx") {
      continue;
    }
    if (readFileSync(entryPath, "utf8").includes(CLI_SENTINEL)) {
      files.push(path.relative(docsRoot, entryPath).replaceAll(path.sep, "/"));
    }
  }
}

function rewriteRelativePaths(body: string, sourcePath: string, outputPath: string): string {
  const sourceDirectory = path.dirname(sourcePath);
  const outputDirectory = path.dirname(outputPath);
  return rewriteRelativeImports(
    rewriteRelativeImageLinks(body, sourceDirectory, outputDirectory),
    sourceDirectory,
    outputDirectory,
  );
}

function rewriteRelativeImageLinks(
  body: string,
  sourceDirectory: string,
  outputDirectory: string,
): string {
  return body.replace(/(!\[[^\]]*\]\()([^)]+)(\))/g, (_match, prefix, target, suffix) => {
    if (shouldKeepLinkTarget(target)) return `${prefix}${target}${suffix}`;
    return `${prefix}${rewriteRelativeLinkTarget(target, sourceDirectory, outputDirectory)}${suffix}`;
  });
}

function rewriteRelativeImports(
  body: string,
  sourceDirectory: string,
  outputDirectory: string,
): string {
  return body.replace(
    /^(import\s+[^'"]+\s+from\s+["'])([^"']+)(["'];?)$/gm,
    (_match, prefix, target, suffix) => {
      if (shouldKeepLinkTarget(target)) return `${prefix}${target}${suffix}`;
      return `${prefix}${rewriteRelativeLinkTarget(target, sourceDirectory, outputDirectory)}${suffix}`;
    },
  );
}

function shouldKeepLinkTarget(target: string): boolean {
  return target.startsWith("#") || target.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(target);
}

function rewriteRelativeLinkTarget(
  target: string,
  sourceDirectory: string,
  outputDirectory: string,
): string {
  const match = target.match(/^([^?#]*)([?#].*)?$/);
  if (!match || !match[1]) return target;

  const absoluteTarget = path.resolve(sourceDirectory, match[1]);
  const relativeTarget = path.relative(outputDirectory, absoluteTarget).replaceAll(path.sep, "/");
  const normalizedTarget = relativeTarget.startsWith(".") ? relativeTarget : `./${relativeTarget}`;
  return `${normalizedTarget}${match[2] ?? ""}`;
}

function writeGeneratedFiles(files: RenderedFile[]): void {
  pruneStaleGeneratedFiles(new Set(files.map((file) => file.path)));
  for (const file of files) {
    if (readOptionalFile(file.path) === file.contents) {
      console.log(`${path.relative(repoRoot, file.path)} is already up to date`);
      continue;
    }
    mkdirSync(path.dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.contents);
    console.log(`Wrote ${path.relative(repoRoot, file.path)}`);
  }
}

function pruneStaleGeneratedFiles(expectedPaths: Set<string>): void {
  for (const filePath of listGeneratedFiles(generatedDocsRoot)) {
    if (expectedPaths.has(filePath)) continue;
    rmSync(filePath);
    console.log(`Removed ${path.relative(repoRoot, filePath)}`);
  }
}

function listGeneratedFiles(directory: string): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }

  return entries.flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return listGeneratedFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".generated.mdx") ? [entryPath] : [];
  });
}

function transformNemoclawCliInvocations(body: string): string {
  return restoreProtectedLiterals(
    protectNonAliasableLiterals(body)
      // Inline code and headings that start with the host CLI command.
      .replace(/`nemoclaw(?=[\s`])/g, "`nemohermes")
      // Copyable shell examples, including env-prefixed invocations and
      // continuation lines indented under a previous shell command.
      .replace(
        /^(\s*(?:\$ )?(?:(?:[A-Z_][A-Z0-9_]*=[^\s\\]+|export)\s+)*)(nemoclaw)(?=\s|$)/gm,
        "$1nemohermes",
      )
      // Shell command substitutions used in examples.
      .replace(/\$\(nemoclaw(?=\s|\))/g, "$(nemohermes")
      // Same-page anchors generated from command headings.
      .replace(/#nemoclaw(?=[-)])/g, "#nemohermes"),
  );
}

const PROTECTED_LITERALS = [
  ["nemoclaw onboard --agent hermes", "__NEMOCLAW_ONBOARD_AGENT_HERMES__"],
] as const;

function protectNonAliasableLiterals(body: string): string {
  return PROTECTED_LITERALS.reduce(
    (next, [literal, token]) => next.replaceAll(literal, token),
    body,
  );
}

function restoreProtectedLiterals(body: string): string {
  return PROTECTED_LITERALS.reduce(
    (next, [literal, token]) => next.replaceAll(token, literal),
    body,
  );
}

function readOptionalTarget(): string | null {
  return readOptionalFile(targetPath);
}

function readOptionalFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main();
}
