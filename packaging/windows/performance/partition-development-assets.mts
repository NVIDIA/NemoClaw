// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

type FileIdentity = { path: string; bytes: number; sha256: string };
type Asset = FileIdentity & { reason: string };
type Package = {
  directory: string;
  runtimeTargets: string[];
  typeTargets: string[];
  opaque?: string;
};
type Input = FileIdentity & { content?: Buffer };
type Options = { expectedSourceRevision?: string };
export type Partition = {
  sourceRevision: string;
  analysis: {
    policyVersion: number;
    toolSha256: string;
    nodeVersion: string;
    typescriptVersion: string;
  };
  sourceReceiptSha256: string;
  filesBefore: number;
  bytesBefore: number;
  sourceInventorySha256: string;
  sourceInventory: FileIdentity[];
  moved: Asset[];
  retainedCandidates: Asset[];
};
const NODE_ROOTS = ["nemoclaw/node_modules/", "openclaw/node_modules/", "pi/node_modules/"];
const FIRST_PARTY = "nemoclaw/app/dist/";
const METADATA = new Set([
  "partition-receipt.json",
  "partition-failure.json",
  "source-inventory.json",
  "production-inventory.json",
  "diagnostics-inventory.json",
]);
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const inventoryText = (files: readonly FileIdentity[]) => JSON.stringify(files) + "\n";
const audited = (name: string) =>
  NODE_ROOTS.some((root) => name.startsWith(root)) || name.startsWith(FIRST_PARTY);
const declaration = (name: string) => /\.d\.[cm]?ts$/u.test(name);
const mapFile = (name: string) => /\.[cm]?[jt]s\.map$/u.test(name);
const codeFile = (name: string) => /\.(?:[cm]?[jt]s|[jt]sx)$/u.test(name) && !declaration(name);

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  return value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
}
function conditionalTargets(value: unknown, typeOnly: boolean, inTypes = false): string[] {
  if (typeof value === "string") return typeOnly === inTypes ? [value] : [];
  if (Array.isArray(value))
    return value.flatMap((child) => conditionalTargets(child, typeOnly, inTypes));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    conditionalTargets(child, typeOnly, inTypes || key === "types" || key.startsWith("types@")),
  );
}
function targetPattern(directory: string, target: string): RegExp | null {
  const cleaned = target.replaceAll("\\", "/");
  if (path.posix.isAbsolute(cleaned) || path.win32.isAbsolute(cleaned)) return null;
  const normalized = path.posix.normalize(
    path.posix.join(directory, cleaned.replace(/^\.\//u, "")),
  );
  if (normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized))
    return null;
  const pattern = normalized
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}$`, "iu");
}
function references(relative: string, owner: Package, targets: string[]): boolean {
  return targets.some((target) => targetPattern(owner.directory, target)?.test(relative));
}
function ancestors(relative: string, packages: Map<string, Package>): Package[] {
  const result: Package[] = [];
  let directory = path.posix.dirname(relative);
  while (directory !== ".") {
    const owner = packages.get(directory);
    if (owner) result.push(owner);
    directory = path.posix.dirname(directory);
  }
  const root = packages.get("");
  if (root) result.push(root);
  return result;
}
async function names(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(path.join(root, directory), { withFileTypes: true })) {
      const relative = path.posix.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("Payload partition refuses reparse points and symbolic links.");
      if (entry.isDirectory()) await visit(relative);
      else if (entry.isFile()) files.push(relative);
      else throw new Error("Native payload contains an unsupported filesystem entry.");
    }
  }
  await visit("");
  files.sort();
  if (new Set(files.map((file) => file.toLowerCase())).size !== files.length)
    throw new Error("Native payload contains paths that alias on Windows.");
  return files;
}
async function readInput(root: string, relative: string, capture = 0): Promise<Input> {
  const file = path.join(root, relative);
  const before = await fs.lstat(file, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Native payload entries must be independent bounded regular files.");
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    )
      throw new Error("Native payload file identity changed while opening.");
    const expected = Number(opened.size);
    const collect = capture > 0 && expected <= capture;
    const chunks: Buffer[] = [];
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > expected) throw new Error("Native payload grew during inventory.");
      digest.update(buffer.subarray(0, bytesRead));
      if (collect) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    const after = await handle.stat({ bigint: true });
    if (
      total !== expected ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs
    )
      throw new Error("Native payload changed during inventory.");
    return {
      path: relative,
      bytes: total,
      sha256: digest.digest("hex"),
      ...(collect ? { content: Buffer.concat(chunks) } : {}),
    };
  } finally {
    await handle.close();
  }
}
function packageMetadata(file: Input): Package {
  const directory = path.posix.dirname(file.path) === "." ? "" : path.posix.dirname(file.path);
  const result: Package = { directory, runtimeTargets: [], typeTargets: [] };
  try {
    const object: unknown = file.content && JSON.parse(file.content.toString("utf8"));
    if (!object || typeof object !== "object" || Array.isArray(object)) throw new Error();
    const value = object as Record<string, unknown>;
    result.runtimeTargets = ["main", "module", "bin"].flatMap((key) => strings(value[key]));
    result.runtimeTargets.push(...strings(value.browser));
    if (value.browser && typeof value.browser === "object" && !Array.isArray(value.browser))
      result.runtimeTargets.push(...Object.keys(value.browser));
    result.runtimeTargets.push(
      ...conditionalTargets(value.exports, false),
      ...conditionalTargets(value.imports, false),
    );
    result.typeTargets = [
      ...strings(value.types),
      ...strings(value.typings),
      ...strings(value.typesVersions),
      ...conditionalTargets(value.exports, true),
      ...conditionalTargets(value.imports, true),
    ];
  } catch {
    result.opaque = "unparsed package metadata retained pending qualification";
  }
  return result;
}
function sourceMap(bytes: Buffer | undefined): boolean {
  try {
    const value: unknown = bytes && JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || !("version" in value) || value.version !== 3)
      return false;
    if ("sections" in value)
      return (
        Array.isArray(value.sections) &&
        value.sections.every(
          (section) =>
            section &&
            typeof section === "object" &&
            "offset" in section &&
            ("map" in section || "url" in section),
        )
      );
    return (
      "sources" in value &&
      Array.isArray(value.sources) &&
      value.sources.every((source) => typeof source === "string") &&
      "mappings" in value &&
      typeof value.mappings === "string" &&
      /^[A-Za-z0-9+/;,]*$/u.test(value.mappings)
    );
  } catch {
    return false;
  }
}
function resourceReferences(
  inputs: Input[],
  packages: Map<string, Package>,
): { paths: Set<string>; uncertain: Set<string>; annotations: Set<string> } {
  const paths = new Set<string>();
  const uncertain = new Set<string>();
  const annotations = new Set<string>();
  for (const file of inputs) {
    if (!audited(file.path) || !codeFile(file.path)) continue;
    const owners = ancestors(file.path, packages);
    if (!file.content) {
      for (const owner of owners) uncertain.add(owner.directory);
      continue;
    }
    const code = file.content.toString("utf8");
    const parsed = ts.createSourceFile(file.path, code, ts.ScriptTarget.Latest, false);
    const parseDiagnostics = (
      parsed as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
    ).parseDiagnostics;
    if (parseDiagnostics?.length) for (const owner of owners) uncertain.add(owner.directory);
    const literals: string[] = [];
    const comments = new Set<number>();
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
        literals.push(node.text);
      for (const range of [
        ...(ts.getLeadingCommentRanges(code, node.pos) ?? []),
        ...(ts.getTrailingCommentRanges(code, node.end) ?? []),
      ]) {
        if (comments.has(range.pos)) continue;
        comments.add(range.pos);
        for (const match of code
          .slice(range.pos, range.end)
          .matchAll(/[#@]\s*sourceMappingURL\s*=\s*([^\s*]+)/gu))
          annotations.add(
            path.posix
              .normalize(path.posix.join(path.posix.dirname(file.path), match[1]))
              .toLowerCase(),
          );
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    const readsFiles = /\b(?:readFile(?:Sync)?|createReadStream|readFileAsText)\b/u.test(code);
    if (
      readsFiles &&
      (literals.some((text) => /^\.d\.[cm]?ts$/u.test(text) || text === ".map") ||
        /\.d\.[cm]?ts|\.[cm]?[jt]s\.map/u.test(code) ||
        /\.types\b|\[\s*["'](?:types|typings)["']\s*\]/u.test(code))
    )
      for (const owner of owners) uncertain.add(owner.directory);
    for (const value of literals) {
      if (!declaration(value) && !mapFile(value)) continue;
      for (const directory of [
        path.posix.dirname(file.path),
        ...owners.map((owner) => owner.directory),
      ]) {
        const resource = path.posix.normalize(
          path.posix.join(directory, value.replaceAll("\\", "/")),
        );
        if (!resource.startsWith("../") && !path.posix.isAbsolute(resource))
          paths.add(resource.toLowerCase());
      }
      let directory = path.posix.dirname(file.path);
      while (directory !== ".") {
        paths.add(path.posix.join(directory, "node_modules", value).toLowerCase());
        directory = path.posix.dirname(directory);
      }
    }
  }
  return { paths, uncertain, annotations };
}
export async function planDevelopmentPartition(
  payloadDirectory: string,
  options: Options = {},
): Promise<Partition> {
  const root = await fs.realpath(payloadDirectory);
  const receiptFile = await readInput(root, "runtime-payload-receipt.json", 1024 * 1024);
  const receipt: unknown = receiptFile.content && JSON.parse(receiptFile.content.toString("utf8"));
  if (
    !receipt ||
    typeof receipt !== "object" ||
    !("classification" in receipt) ||
    receipt.classification !== "nemoclaw-native-windows-arm64-runtime-payload" ||
    !("nemoclaw" in receipt)
  )
    throw new Error("Development partition requires an assembled native Windows payload receipt.");
  const source = receipt.nemoclaw as { revision?: unknown };
  if (
    typeof source?.revision !== "string" ||
    !/^[a-f0-9]{40}$/u.test(source.revision) ||
    (options.expectedSourceRevision !== undefined &&
      source.revision !== options.expectedSourceRevision)
  )
    throw new Error(
      "Native payload source identity is missing or differs from the expected revision.",
    );
  const files = await names(root);
  const inputs: Input[] = [];
  for (const relative of files) {
    const capture = relative.endsWith("package.json")
      ? 1024 * 1024
      : audited(relative) && (codeFile(relative) || mapFile(relative))
        ? 32 * 1024 * 1024
        : 0;
    inputs.push(
      relative === receiptFile.path ? receiptFile : await readInput(root, relative, capture),
    );
  }
  const packages = new Map<string, Package>();
  for (const file of inputs) {
    if (
      path.posix.basename(file.path) === "package.json" &&
      (audited(file.path) || file.path === "nemoclaw/app/package.json")
    ) {
      const owner = packageMetadata(file);
      packages.set(owner.directory, owner);
    }
  }
  const resources = resourceReferences(inputs, packages);
  const explicitRuntime = new Set<string>();
  for (const owner of packages.values())
    for (const target of owner.runtimeTargets) {
      if (!target.includes("*"))
        explicitRuntime.add(
          path.posix
            .normalize(path.posix.join(owner.directory, target.replaceAll("\\", "/")))
            .toLowerCase(),
        );
    }
  const sourceInventory = inputs.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
  const result: Partition = {
    sourceRevision: source.revision,
    analysis: {
      policyVersion: 2,
      toolSha256: hash(await fs.readFile(fileURLToPath(import.meta.url))),
      nodeVersion: process.version,
      typescriptVersion: ts.version,
    },
    sourceReceiptSha256: receiptFile!.sha256,
    filesBefore: files.length,
    bytesBefore: sourceInventory.reduce((total, file) => total + file.bytes, 0),
    sourceInventorySha256: hash(inventoryText(sourceInventory)),
    sourceInventory,
    moved: [],
    retainedCandidates: [],
  };
  for (const file of inputs) {
    const isDeclaration = declaration(file.path),
      isMap = mapFile(file.path);
    if (!isDeclaration && !isMap) continue;
    const owners = ancestors(file.path, packages);
    const typed = owners.some((owner) => references(file.path, owner, owner.typeTargets));
    const linkedMap = resources.annotations.has(file.path.toLowerCase());
    const retained = /(?:^|\/)(?:license|licenses|copying|notice|authors)(?:[./_-]|$)/iu.test(
      file.path,
    )
      ? "license resource"
      : !audited(file.path)
        ? "outside audited Node distribution roots"
        : /(?:^|\/)node_modules\/(?:typescript\/lib|@types)\//u.test(file.path)
          ? "compiler resources retained pending tool qualification"
          : owners.length === 0
            ? "missing package metadata retained pending qualification"
            : (owners.find((owner) => owner.opaque)?.opaque ??
              (resources.paths.has(file.path.toLowerCase())
                ? "literal runtime resource reference"
                : owners.some((owner) => resources.uncertain.has(owner.directory))
                  ? "unbounded runtime resource access retained pending qualification"
                  : explicitRuntime.has(file.path.toLowerCase()) ||
                      owners.some((owner) => references(file.path, owner, owner.runtimeTargets))
                    ? "declared runtime export or entrypoint"
                    : isDeclaration && !typed
                      ? "declaration is not explicitly type-only metadata"
                      : isMap && !sourceMap(file.content)
                        ? "not a recognized bounded JavaScript source map"
                        : isMap && !linkedMap
                          ? "map is not linked solely by a source-mapping annotation"
                          : null));
    const asset = {
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
      reason:
        retained ??
        (isDeclaration ? "explicit type-only declaration" : "linked JavaScript source map"),
    };
    (retained ? result.retainedCandidates : result.moved).push(asset);
  }
  return result;
}
async function inventory(root: string, excludeMetadata = false): Promise<FileIdentity[]> {
  const result: FileIdentity[] = [];
  for (const relative of await names(root)) {
    if (excludeMetadata && METADATA.has(relative)) continue;
    const { path, bytes, sha256 } = await readInput(root, relative);
    result.push({ path, bytes, sha256 });
  }
  return result;
}
export async function verifyPartitionUnion(
  payloadDirectory: string,
  diagnosticsDirectory: string,
  plan: Partition,
) {
  const production = await inventory(await fs.realpath(payloadDirectory));
  const diagnostics = await inventory(await fs.realpath(diagnosticsDirectory), true);
  const union = [...production, ...diagnostics].sort((left, right) =>
    left.path.localeCompare(right.path, "en"),
  );
  const expected = [...plan.sourceInventory].sort((left, right) =>
    left.path.localeCompare(right.path, "en"),
  );
  const moved = new Set(plan.moved.map((file) => file.path));
  if (
    new Set(union.map((file) => file.path.toLowerCase())).size !== union.length ||
    inventoryText(union) !== inventoryText(expected) ||
    diagnostics.some((file) => !moved.has(file.path)) ||
    diagnostics.length !== moved.size ||
    hash(inventoryText(plan.sourceInventory)) !== plan.sourceInventorySha256
  )
    throw new Error(
      "Production and diagnostics do not form the complete unchanged source inventory.",
    );
  const productionInventorySha256 = hash(inventoryText(production));
  const diagnosticsInventorySha256 = hash(inventoryText(diagnostics));
  for (const [file, digest] of [
    ["source-inventory.json", plan.sourceInventorySha256],
    ["production-inventory.json", productionInventorySha256],
    ["diagnostics-inventory.json", diagnosticsInventorySha256],
  ]) {
    const info = await fs
      .lstat(path.join(diagnosticsDirectory, file))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    if (info && (await readInput(diagnosticsDirectory, file)).sha256 !== digest)
      throw new Error("Recorded partition inventory differs from the actual source union.");
  }
  return { production, diagnostics, productionInventorySha256, diagnosticsInventorySha256 };
}
export async function partitionDevelopmentAssets(
  payloadDirectory: string,
  diagnosticsDirectory: string,
  options: Options = {},
): Promise<Partition> {
  const root = await fs.realpath(payloadDirectory);
  const diagnostics = path.resolve(diagnosticsDirectory);
  const parent = await fs.realpath(path.dirname(diagnostics));
  if (parent !== path.dirname(diagnostics))
    throw new Error("Diagnostics parent must use its canonical filesystem path.");
  const relative = path.relative(root, diagnostics),
    reverse = path.relative(diagnostics, root);
  if (
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) ||
    (!reverse.startsWith(`..${path.sep}`) && reverse !== ".." && !path.isAbsolute(reverse))
  )
    throw new Error("Production and diagnostics trees must be separate.");
  if ((await fs.stat(root)).dev !== (await fs.stat(parent)).dev)
    throw new Error("The atomic partition requires one filesystem volume.");
  const plan = await planDevelopmentPartition(root, options);
  await fs.mkdir(diagnostics);
  const completed: string[] = [];
  let stage = "moving";
  try {
    for (const asset of plan.moved) {
      const actual = await readInput(root, asset.path);
      if (actual.bytes !== asset.bytes || actual.sha256 !== asset.sha256)
        throw new Error("Payload changed after its development partition was planned.");
      const target = path.join(diagnostics, asset.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.rename(path.join(root, asset.path), target);
      completed.push(asset.path);
    }
    stage = "verifying union";
    const verified = await verifyPartitionUnion(root, diagnostics, plan);
    stage = "recording provenance";
    const { sourceInventory, ...summary } = plan;
    await fs.writeFile(
      path.join(diagnostics, "source-inventory.json"),
      inventoryText(sourceInventory),
      { flag: "wx" },
    );
    await fs.writeFile(
      path.join(diagnostics, "production-inventory.json"),
      inventoryText(verified.production),
      { flag: "wx" },
    );
    await fs.writeFile(
      path.join(diagnostics, "diagnostics-inventory.json"),
      inventoryText(verified.diagnostics),
      { flag: "wx" },
    );
    await fs.writeFile(
      path.join(diagnostics, "partition-receipt.json"),
      JSON.stringify(
        {
          schemaVersion: 2,
          classification: "native-windows-development-assets",
          ...summary,
          filesMoved: plan.moved.length,
          bytesMoved: plan.moved.reduce((total, file) => total + file.bytes, 0),
          filesProduction: verified.production.length,
          bytesProduction: verified.production.reduce((total, file) => total + file.bytes, 0),
          productionInventorySha256: verified.productionInventorySha256,
          diagnosticsInventorySha256: verified.diagnosticsInventorySha256,
          completeSourceUnionVerified: true,
          complete: true,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    return plan;
  } catch (error) {
    await fs
      .writeFile(
        path.join(diagnostics, "partition-failure.json"),
        JSON.stringify({
          schemaVersion: 1,
          classification: "native-windows-development-assets-failure",
          sourceRevision: plan.sourceRevision,
          sourceInventorySha256: plan.sourceInventorySha256,
          stage,
          movedPaths: completed,
          complete: false,
        }) + "\n",
        { flag: "wx" },
      )
      .catch(() => {});
    throw error;
  }
}
