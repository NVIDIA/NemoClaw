// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { identity, measuredCommand, publishFixtureRecord } from "./measurement.mts";

const cacheVariables = new Set([
  "NODE_COMPILE_CACHE",
  "NODE_DISABLE_COMPILE_CACHE",
  "NODE_COMPILE_CACHE_PORTABLE",
  "NODE_COMPILE_CACHE_READONLY",
  "NODE_OPTIONS",
  "NODE_V8_COVERAGE",
]);
export function cacheEnvironment(base: NodeJS.ProcessEnv, directory: string | null) {
  const result = Object.fromEntries(
    Object.entries(base).filter(([key]) => !cacheVariables.has(key.toUpperCase())),
  );
  if (directory === null) result.NODE_DISABLE_COMPILE_CACHE = "1";
  else result.NODE_COMPILE_CACHE = directory;
  return result;
}

export function cacheNamespace(nodeSha256: string, manifestSha256: string, agent: string) {
  if (
    ![nodeSha256, manifestSha256].every((value) => /^[a-f0-9]{64}$/u.test(value)) ||
    !/^[a-z][a-z0-9-]{0,47}$/u.test(agent)
  )
    throw new Error("The compile-cache experiment requires exact runtime identities.");
  return createHash("sha256")
    .update(JSON.stringify({ schemaVersion: 1, nodeSha256, manifestSha256, agent }))
    .digest("hex");
}

function inventory(root: string) {
  const files: { relativePath: string; bytes: number; sha256: string }[] = [];
  let bytes = 0,
    entries = 0;
  const walk = (directory: string) => {
    for (const name of fs.readdirSync(directory)) {
      if (++entries > 50_000) throw new Error("The diagnostic cache exceeded its entry bound.");
      const file = path.join(directory, name),
        stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error("A diagnostic cache entry was redirected.");
      if (stat.isDirectory()) walk(file);
      else {
        if (!stat.isFile() || stat.nlink !== 1 || (bytes += stat.size) > 256 * 1024 * 1024)
          throw new Error("The diagnostic cache exceeded its file/byte contract.");
        const item = identity(file);
        files.push({
          relativePath: path.relative(root, file),
          bytes: item.bytes,
          sha256: item.sha256,
        });
      }
    }
  };
  walk(root);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return {
    fileCount: files.length,
    bytes,
    manifestSha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
  };
}

/** A command-level MXC diagnostic. Its caller owns the private writable fixture
 * and ensures sequential installation/cleanup on its disposable runner.
 * No result from this helper establishes dashboard startup or cache-hit counts. */
export async function runCompileCacheExperiment(options: {
  node: string;
  entry: string;
  home: string;
  environment: NodeJS.ProcessEnv;
  evidenceRoot: string;
  runtimeManifestSha256: string;
}) {
  const node = identity(options.node),
    entry = identity(options.entry);
  const key = cacheNamespace(node.sha256, options.runtimeManifestSha256, "openclaw");
  const root = path.join(options.evidenceRoot, "compile-cache-experiment");
  fs.mkdirSync(root);
  const cacheRoot = path.join(root, key);
  fs.mkdirSync(cacheRoot);
  const preload = path.join(root, "observe-cache.mjs");
  fs.writeFileSync(
    preload,
    'import {getCompileCacheDir} from "node:module";\nprocess.stdout.write("NEMOCLAW_CACHE_STATE="+JSON.stringify({nodeVersion:process.version,cacheDirectory:getCompileCacheDir()??null})+"\\n");\n',
    { flag: "wx" },
  );
  const samples: Record<string, unknown>[] = [];
  const sequence = [
    "disabled-initial",
    "enabled-populate",
    "disabled-warm-1",
    "enabled-warm-1",
    "enabled-warm-2",
    "disabled-warm-2",
  ];
  let primary: unknown = null;
  try {
    for (const label of sequence) {
      const enabled = label.startsWith("enabled");
      const before = inventory(cacheRoot);
      console.log(`[Compile-cache diagnostic] ${label}`);
      const result = await measuredCommand({
        executable: options.node,
        args: [
          "--import",
          pathToFileURL(preload).href,
          options.entry,
          "config",
          "get",
          "gateway.mode",
        ],
        environment: cacheEnvironment(options.environment, enabled ? cacheRoot : null),
        cwd: options.home,
        timeoutMs: 60_000,
      });
      // Cache inventory occurs only after the command has closed and outside its
      // timer. It warms filesystem metadata; every subsequent row is labeled warm.
      const after = result.closed ? inventory(cacheRoot) : null;
      const marker = result.stdout.match(/^NEMOCLAW_CACHE_STATE=(.+)\r?$/mu);
      const state = marker
        ? (JSON.parse(marker[1]!) as { nodeVersion: string; cacheDirectory: string | null })
        : null;
      const output = result.stdout.replace(/^NEMOCLAW_CACHE_STATE=.+\r?\n/mu, "").trim();
      const row = {
        label,
        enabled,
        command: result,
        state,
        cacheBefore: before,
        cacheAfter: after,
        cacheReuseVerified: false,
        osCold: false,
        runtimeBytesCopied: 0,
      };
      samples.push(row);
      if (
        result.exitCode !== 0 ||
        !result.closed ||
        result.timedOut ||
        result.aborted ||
        result.spawnError ||
        result.observerError ||
        result.outputExceeded ||
        output !== "local" ||
        !state
      )
        throw new Error(`The contained compile-cache command failed during ${label}.`);
      if (enabled) {
        if (
          !state.cacheDirectory ||
          !path
            .resolve(state.cacheDirectory)
            .toLowerCase()
            .startsWith(path.resolve(cacheRoot).toLowerCase() + path.sep) ||
          !after?.fileCount
        )
          throw new Error(`Node did not enable and populate the owned cache during ${label}.`);
      } else if (state.cacheDirectory !== null || JSON.stringify(before) !== JSON.stringify(after))
        throw new Error(`The disabled sample accessed a compile-cache directory during ${label}.`);
      if (
        samples.some((sample) => (sample.state as typeof state)?.nodeVersion !== state.nodeVersion)
      )
        throw new Error("The experiment changed Node versions between samples.");
    }
    if (
      identity(options.node).sha256 !== node.sha256 ||
      identity(options.entry).sha256 !== entry.sha256
    )
      throw new Error("A stable installed experiment input changed.");
  } catch (error) {
    primary = error;
  }
  const receipt = {
    schemaVersion: 1,
    classification: "installed-openclaw-command-compile-cache-ab",
    diagnosticOnly: true,
    scope: "unchanged config-read command inside MXC; not dashboard or inference",
    node,
    entry,
    runtimeManifestSha256: options.runtimeManifestSha256,
    cacheNamespace: key,
    samples,
    cacheHitAttributionVerified: false,
    processExitFlushIncluded: true,
    preloadAppliedToEverySample: true,
    osCold: false,
    modelRequests: 0,
    runtimeTreeCopies: 0,
    runtimeBytesCopied: 0,
    passed: primary === null,
    error: primary instanceof Error ? primary.message : null,
  };
  try {
    publishFixtureRecord(path.join(options.evidenceRoot, "compile-cache-result.json"), receipt);
  } catch (error) {
    if (primary === null) primary = error;
  }
  if (primary !== null) throw primary;
  return receipt;
}
