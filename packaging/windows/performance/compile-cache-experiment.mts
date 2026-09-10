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
    'import {getCompileCacheDir} from "node:module";\nprocess.stdout.write("NEMOCLAW_CACHE_STATE="+JSON.stringify({nodeVersion:process.version,processId:process.pid,parentProcessId:process.ppid,executable:process.execPath,cacheDirectory:getCompileCacheDir()??null})+"\\n");\n',
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
      const observations = [...result.stdout.matchAll(/^NEMOCLAW_CACHE_STATE=(.+)\r?$/gmu)];
      const states: {
        nodeVersion: string;
        processId: number;
        parentProcessId: number;
        executable: string;
        cacheDirectory: string | null;
      }[] = [];
      // Keep the literal command outcome before parsing observations, including a
      // malformed record. Upstream's cache-specific respawn is not bypassed.
      const output = result.stdout.replace(/^NEMOCLAW_CACHE_STATE=.+\r?\n/gmu, "").trim();
      const row = {
        label,
        enabled,
        command: result,
        states,
        preloadObservationCount: observations.length,
        cacheBefore: before,
        cacheAfter: after,
        cacheReuseVerified: false,
        osCold: false,
        runtimeBytesCopied: 0,
      };
      samples.push(row);
      if (observations.length < 1 || observations.length > 4)
        throw new Error(`The cache process observations exceeded their bound during ${label}.`);
      for (const observation of observations) {
        const state = JSON.parse(observation[1]!) as (typeof states)[number];
        if (
          !state ||
          !Number.isSafeInteger(state.processId) ||
          state.processId < 1 ||
          !Number.isSafeInteger(state.parentProcessId) ||
          state.parentProcessId < 1 ||
          typeof state.nodeVersion !== "string" ||
          typeof state.executable !== "string" ||
          path.resolve(state.executable).toLowerCase() !==
            path.resolve(options.node).toLowerCase() ||
          (state.cacheDirectory !== null && typeof state.cacheDirectory !== "string")
        )
          throw new Error(`The cache process observation is invalid during ${label}.`);
        states.push(state);
      }
      if (new Set(states.map((state) => state.processId)).size !== states.length)
        throw new Error(`A cache process observation was duplicated during ${label}.`);
      if (
        result.exitCode !== 0 ||
        !result.closed ||
        result.timedOut ||
        result.aborted ||
        result.spawnError ||
        result.observerError ||
        result.outputExceeded ||
        output !== "local"
      )
        throw new Error(`The contained compile-cache command failed during ${label}.`);
      if (enabled) {
        if (
          states.some(
            (state) =>
              !state.cacheDirectory ||
              !path
                .resolve(state.cacheDirectory)
                .toLowerCase()
                .startsWith(path.resolve(cacheRoot).toLowerCase() + path.sep),
          ) ||
          !after?.fileCount
        )
          throw new Error(`Node did not enable and populate the owned cache during ${label}.`);
      } else if (
        states.some((state) => state.cacheDirectory !== null) ||
        JSON.stringify(before) !== JSON.stringify(after)
      )
        throw new Error(`The disabled sample accessed a compile-cache directory during ${label}.`);
      const versions = samples.flatMap((sample) =>
        (sample.states as typeof states).map((state) => state.nodeVersion),
      );
      if (new Set(versions).size !== 1)
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
    upstreamRespawnOverheadIncluded: true,
    processObservations:
      "self-reported by the same fixed preload; not an OS process-tree attestation",
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
