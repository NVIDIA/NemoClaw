#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { remediateReviewedOpenClawPluginArchive } from "./lib/openclaw-npm-remediation.mts";
import { packReviewedNpmArchive, verifyReviewedNpmMetadata } from "./lib/reviewed-npm-archive.mts";
import {
  assertExceptionGraphs,
  readAuditExceptionRegistry,
  runReviewedNpmAudit,
  type Severity,
} from "./lib/reviewed-npm-audit.mts";

type ReviewedPackage = Readonly<{
  integrity: string;
  label: string;
  packageSpec: string;
  tarballUrl: string;
}>;
type LockedGraph = ReviewedPackage & Readonly<{ directory: string; id: string }>;
type AuditConfig = Readonly<{
  archivePackages: readonly ReviewedPackage[];
  archiveGraphId: string;
  artifactDirectory: string;
  exceptionFile: string;
  lockedGraphs: readonly LockedGraph[];
  nodeVersion: string;
  schemaVersion: 2;
  severityThreshold: Severity;
}>;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = path.join(REPO_ROOT, "ci", "reviewed-npm-audit.json");
const SEVERITIES: readonly Severity[] = ["info", "low", "moderate", "high", "critical"];

function repositoryPath(relativePath: string, label: string): string {
  const resolved = path.resolve(REPO_ROOT, relativePath);
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    !resolved.startsWith(`${REPO_ROOT}${path.sep}`)
  ) {
    throw new Error(`${label} must stay inside the repository`);
  }
  return resolved;
}

function run(command: string, args: readonly string[], cwd: string) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, NPM_CONFIG_UPDATE_NOTIFIER: "false" },
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function readConfig(): AuditConfig {
  const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as AuditConfig;
  if (
    parsed.schemaVersion !== 2 ||
    !SEVERITIES.includes(parsed.severityThreshold) ||
    typeof parsed.archiveGraphId !== "string" ||
    !parsed.archiveGraphId ||
    typeof parsed.exceptionFile !== "string" ||
    !parsed.exceptionFile ||
    !Array.isArray(parsed.archivePackages) ||
    !Array.isArray(parsed.lockedGraphs) ||
    parsed.lockedGraphs.some(
      (graph) => typeof graph.id !== "string" || !graph.id || typeof graph.directory !== "string",
    )
  ) {
    throw new Error("ci/reviewed-npm-audit.json is invalid");
  }
  return parsed;
}

function materializeArchiveGraph(packages: readonly ReviewedPackage[], tempRoot: string): string {
  const graphDirectory = path.join(tempRoot, "reviewed-archive-graph");
  fs.mkdirSync(graphDirectory);
  fs.writeFileSync(
    path.join(graphDirectory, "package.json"),
    `${JSON.stringify({ name: "nemoclaw-reviewed-production-graph", private: true, version: "1.0.0" }, null, 2)}\n`,
  );
  const archives = packages.map((reviewed) => {
    const archive = packReviewedNpmArchive({
      expectedIntegrity: reviewed.integrity,
      label: reviewed.label,
      packageSpec: reviewed.packageSpec,
      tarballUrl: reviewed.tarballUrl,
      tempDirectory: tempRoot,
    });
    return remediateReviewedOpenClawPluginArchive({
      archivePath: archive.archivePath,
      packageSpec: reviewed.packageSpec,
      workingDirectory: archive.rootDirectory,
    });
  });
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      ...archives.map((archive) => archive.archivePath),
    ],
    graphDirectory,
  );
  return graphDirectory;
}

function materializeLockedGraph(graph: LockedGraph, tempRoot: string): string {
  verifyReviewedNpmMetadata({
    expectedIntegrity: graph.integrity,
    label: graph.label,
    packageSpec: graph.packageSpec,
    tarballUrl: graph.tarballUrl,
  });
  const source = repositoryPath(graph.directory, `${graph.label} directory`);
  const destination = path.join(tempRoot, `locked-${path.basename(graph.directory)}`);
  fs.mkdirSync(destination);
  for (const filename of ["package.json", "package-lock.json"]) {
    fs.copyFileSync(path.join(source, filename), path.join(destination, filename));
  }
  run("npm", ["ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"], destination);
  return destination;
}

function main(): void {
  const config = readConfig();
  const expectedNode = `v${config.nodeVersion}`;
  if (process.version !== expectedNode) {
    throw new Error(`reviewed npm audit requires Node ${expectedNode}; running ${process.version}`);
  }
  const artifactDirectory = repositoryPath(config.artifactDirectory, "audit artifact directory");
  const exceptionFile = repositoryPath(config.exceptionFile, "npm audit exception file");
  const exceptionRegistry = readAuditExceptionRegistry(exceptionFile);
  assertExceptionGraphs(
    exceptionRegistry.policy,
    new Set([config.archiveGraphId, ...config.lockedGraphs.map((graph) => graph.id)]),
  );
  fs.rmSync(artifactDirectory, { recursive: true, force: true });
  fs.mkdirSync(artifactDirectory, { recursive: true });
  const npmVersion = run("npm", ["--version"], REPO_ROOT).stdout.trim();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reviewed-npm-audit-"));
  try {
    const reports = [
      {
        label: "reviewed archive graph",
        result: runReviewedNpmAudit({
          directory: materializeArchiveGraph(config.archivePackages, tempRoot),
          exceptionFile,
          graph: config.archiveGraphId,
          provenance: {
            label: "reviewed archive graph",
            nodeVersion: process.version,
            npmVersion,
            packageSpecs: config.archivePackages.map((reviewed) => reviewed.packageSpec),
          },
          reportFile: path.join(artifactDirectory, "reviewed-archive-graph.json"),
          resultFile: path.join(artifactDirectory, "reviewed-archive-graph-policy.json"),
          threshold: config.severityThreshold,
          throwOnBlock: false,
        }),
      },
      ...config.lockedGraphs.map((graph, index) => ({
        label: graph.label,
        result: runReviewedNpmAudit({
          directory: materializeLockedGraph(graph, tempRoot),
          exceptionFile,
          graph: graph.id,
          provenance: {
            label: graph.label,
            nodeVersion: process.version,
            npmVersion,
            packageSpecs: [graph.packageSpec],
          },
          reportFile: path.join(artifactDirectory, `locked-graph-${index + 1}.json`),
          resultFile: path.join(artifactDirectory, `locked-graph-${index + 1}-policy.json`),
          threshold: config.severityThreshold,
          throwOnBlock: false,
        }),
      })),
    ];
    const failures: string[] = [];
    for (const { label, result } of reports) {
      if (result.unacceptedBlockingAdvisories.length > 0) {
        failures.push(
          `${label}: ${result.unacceptedBlockingAdvisories.length} unaccepted at or above ${config.severityThreshold}`,
        );
      }
    }
    if (failures.length > 0)
      throw new Error(`reviewed npm audit threshold failed\n${failures.join("\n")}`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function isMainModule(): boolean {
  return process.argv[1]
    ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
    : false;
}

if (isMainModule()) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
