// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createDockerGpuDiagnosticRedactor } from "../../src/lib/onboard/docker-gpu-diagnostic-redaction.ts";
import { isCredentialField } from "../../src/lib/security/credential-filter.ts";

const EXPORTED_DIAGNOSTIC_FILES = new Set([
  "openshell-gateway-relevant.log",
  "openshell-gateway-tail.log",
  "rootfs-console.log",
  "summary.txt",
]);

export const MANAGED_IMAGE_DIAGNOSTIC_EXPORT_LIMITS = {
  maxBundles: 4,
  maxFiles: 16,
  maxOutputFileBytes: 32 * 1024,
  maxSourceFileBytes: 64 * 1024,
  maxTotalOutputBytes: 128 * 1024,
} as const;

export type ManagedImageDiagnosticExportOptions = {
  readonly env?: NodeJS.ProcessEnv;
  readonly outputRoot: string;
  readonly sourceRoot: string;
};

export type ManagedImageDiagnosticExportResult = {
  readonly bundles: number;
  readonly bytes: number;
  readonly files: number;
};

type PreparedFile = {
  readonly bundle: number;
  readonly contents: string;
  readonly name: string;
};

function requiredArgument(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

function parseArguments(
  argv: readonly string[],
): Pick<ManagedImageDiagnosticExportOptions, "outputRoot" | "sourceRoot"> {
  if (argv.length !== 4) {
    throw new Error("usage: --source <onboard-failures> --output <empty-directory>");
  }
  return {
    sourceRoot: requiredArgument(argv, "--source"),
    outputRoot: requiredArgument(argv, "--output"),
  };
}

function assertPlainDirectory(directory: string, label: string): void {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory`);
  }
}

function assertOutputIsSeparate(sourceRoot: string, outputRoot: string): void {
  const source = path.resolve(sourceRoot);
  const output = path.resolve(outputRoot);
  if (
    source === output ||
    output.startsWith(`${source}${path.sep}`) ||
    source.startsWith(`${output}${path.sep}`)
  ) {
    throw new Error("diagnostic source and sanitized output must be separate");
  }
}

function knownSecretValues(env: NodeJS.ProcessEnv): string[] {
  return [
    ...new Set(
      Object.entries(env)
        .filter(([name, value]) => Boolean(value) && isCredentialField(name))
        .map(([, value]) => value as string)
        // Avoid treating a short runner setting as a global text replacement.
        // Production credentials and the canaries used by this exporter are
        // substantially longer than this lower bound.
        .filter((value) => Buffer.byteLength(value, "utf8") >= 8),
    ),
  ].sort((left, right) => right.length - left.length);
}

function truncateRedactedText(text: string, maxBytes: number): string {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= maxBytes) return text;

  const marker = Buffer.from("\n[truncated after redaction]\n", "utf8");
  const utf8Prefix = (value: Buffer, byteLimit: number): Buffer => {
    let end = Math.min(value.byteLength, byteLimit);
    while (end > 0 && end < value.byteLength && (value[end] & 0xc0) === 0x80) end--;
    return value.subarray(0, end);
  };
  if (maxBytes <= marker.byteLength) return utf8Prefix(marker, maxBytes).toString("utf8");
  return Buffer.concat([utf8Prefix(encoded, maxBytes - marker.byteLength), marker]).toString(
    "utf8",
  );
}

function readRegularFileNoFollow(filePath: string): string | null {
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`diagnostic entry is not a regular file: ${filePath}`);
    }
    throw error;
  }
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) {
      throw new Error(`diagnostic entry is not a regular file: ${filePath}`);
    }
    if (opened.size > MANAGED_IMAGE_DIAGNOSTIC_EXPORT_LIMITS.maxSourceFileBytes) return null;
    return fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
}

function prepareFiles(
  sourceRoot: string,
  env: NodeJS.ProcessEnv,
): { bundles: number; files: PreparedFile[] } {
  if (!fs.existsSync(sourceRoot)) return { bundles: 0, files: [] };
  assertPlainDirectory(sourceRoot, "diagnostic source");

  const rootEntries = fs.readdirSync(sourceRoot, { withFileTypes: true });
  for (const entry of rootEntries) {
    const entryPath = path.join(sourceRoot, entry.name);
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`diagnostic bundle entry is not a real directory: ${entryPath}`);
    }
  }

  const selectedBundles = rootEntries
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left))
    .slice(0, MANAGED_IMAGE_DIAGNOSTIC_EXPORT_LIMITS.maxBundles);
  const redactText = createDockerGpuDiagnosticRedactor(knownSecretValues(env)).redactText;
  const prepared: PreparedFile[] = [];
  let totalBytes = 0;

  for (const [bundleIndex, bundleName] of selectedBundles.entries()) {
    const bundlePath = path.join(sourceRoot, bundleName);
    const entries = fs.readdirSync(bundlePath, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = path.join(bundlePath, entry.name);
      const stat = fs.lstatSync(sourcePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`diagnostic entry is not a regular file: ${sourcePath}`);
      }
    }

    for (const name of [...EXPORTED_DIAGNOSTIC_FILES].sort()) {
      if (prepared.length >= MANAGED_IMAGE_DIAGNOSTIC_EXPORT_LIMITS.maxFiles) break;
      const sourcePath = path.join(bundlePath, name);
      if (!fs.existsSync(sourcePath)) continue;

      const raw = readRegularFileNoFollow(sourcePath);
      const redacted =
        raw === null
          ? `[omitted: source exceeded ${MANAGED_IMAGE_DIAGNOSTIC_EXPORT_LIMITS.maxSourceFileBytes} bytes]\n`
          : redactText(raw);
      let contents = truncateRedactedText(
        redacted,
        MANAGED_IMAGE_DIAGNOSTIC_EXPORT_LIMITS.maxOutputFileBytes,
      );
      const remaining = MANAGED_IMAGE_DIAGNOSTIC_EXPORT_LIMITS.maxTotalOutputBytes - totalBytes;
      if (remaining <= 0) break;
      contents = truncateRedactedText(contents, remaining);
      const byteLength = Buffer.byteLength(contents, "utf8");
      if (byteLength === 0) continue;
      prepared.push({ bundle: bundleIndex + 1, contents, name });
      totalBytes += byteLength;
    }
    if (
      prepared.length >= MANAGED_IMAGE_DIAGNOSTIC_EXPORT_LIMITS.maxFiles ||
      totalBytes >= MANAGED_IMAGE_DIAGNOSTIC_EXPORT_LIMITS.maxTotalOutputBytes
    ) {
      break;
    }
  }

  return { bundles: new Set(prepared.map((file) => file.bundle)).size, files: prepared };
}

export function exportManagedImageFailureDiagnostics(
  options: ManagedImageDiagnosticExportOptions,
): ManagedImageDiagnosticExportResult {
  assertOutputIsSeparate(options.sourceRoot, options.outputRoot);
  assertPlainDirectory(options.outputRoot, "sanitized diagnostic output");
  if (fs.readdirSync(options.outputRoot).length !== 0) {
    throw new Error("sanitized diagnostic output must be empty");
  }

  const prepared = prepareFiles(options.sourceRoot, options.env ?? process.env);
  let bytes = 0;
  for (const file of prepared.files) {
    const bundlePath = path.join(
      options.outputRoot,
      `bundle-${String(file.bundle).padStart(2, "0")}`,
    );
    fs.mkdirSync(bundlePath, { recursive: true, mode: 0o700 });
    const destination = path.join(bundlePath, file.name);
    fs.writeFileSync(destination, file.contents, { encoding: "utf8", mode: 0o600 });
    bytes += Buffer.byteLength(file.contents, "utf8");
  }
  return { bundles: prepared.bundles, bytes, files: prepared.files.length };
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint) && pathToFileURL(path.resolve(entrypoint)).href === import.meta.url;
}

if (isMainModule()) {
  try {
    const result = exportManagedImageFailureDiagnostics(parseArguments(process.argv.slice(2)));
    process.stdout.write(
      `sanitized_bundles=${result.bundles} sanitized_files=${result.files} sanitized_bytes=${result.bytes}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `managed-image diagnostic export failed closed: ${(error as Error).message}\n`,
    );
    process.exitCode = 1;
  }
}
