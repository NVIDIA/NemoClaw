#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// OpenClaw 10.5 stores marker-only webhook decisions in config_machine_state,
// but its startup gate reads only config metadata. Reuse the native completion
// reader before loading migration contracts again. Missing or partial decisions
// still take the original migration path; read failures still stop startup.
// Remove when upstream startup reads its own canonical completion record.
export const TARGET = "startup-config-preflight-C4G3Hbkd.mjs";
export const UPSTREAM_SHA256 = "695fcca52b6d6eb4cea3c874704bab8194af329be7ae33824672191419e095a5";
export const MARKER = "/* nemoclaw: native webhook completion read */";
const ORIGINAL_IMPORT = 'import "./paths-BP0DYpE8.mjs";';
const PATCHED_IMPORT = [
  'import { m as nemoclawResolveConfigPath } from "./paths-BP0DYpE8.mjs";',
  'import { n as nemoclawReadConfigMachineState } from "./config-machine-state-CyNp8IyG.mjs";',
].join("\n");
const ORIGINAL_GATE =
  "const webhookCompletion = read.snapshot.sourceConfig.meta?.migrations?.webhookListeners;";
export const WEBHOOK_COMPLETION_READ = [
  MARKER,
  "\t\tconst webhookCompletion = read.snapshot.sourceConfig.meta?.migrations?.webhookListeners",
  "\t\t\t?? nemoclawReadConfigMachineState(`webhookListeners:${nemoclawResolveConfigPath(env)}`, { env }, { artifactPreservingReadOnly: true });",
].join("\n");

export function patchWebhookCompletionText(source: string): string {
  const original = source.includes(MARKER)
    ? source
        .replace(PATCHED_IMPORT, ORIGINAL_IMPORT)
        .replace(WEBHOOK_COMPLETION_READ, ORIGINAL_GATE)
    : source;
  if (createHash("sha256").update(original).digest("hex") !== UPSTREAM_SHA256) {
    throw new Error("OpenClaw webhook startup source differs from the reviewed 2026.10.5 bundle");
  }
  const patched = original
    .replace(ORIGINAL_IMPORT, PATCHED_IMPORT)
    .replace(ORIGINAL_GATE, WEBHOOK_COMPLETION_READ);
  if (source !== original && source !== patched) {
    throw new Error("OpenClaw webhook completion patch is incomplete");
  }
  return patched;
}

export function patchWebhookCompletion(dist: string, audit = false): string {
  const metadata = JSON.parse(fs.readFileSync(path.join(dist, "..", "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (metadata.version !== "2026.10.5") {
    throw new Error("OpenClaw webhook completion patch requires reviewed version 2026.10.5");
  }
  const reader = fs.readFileSync(path.join(dist, "config-machine-state-CyNp8IyG.mjs"));
  if (
    createHash("sha256").update(reader).digest("hex") !==
    "3322ae4d8ec6dac81e4d0fd730da08f55f619d50ae4f4237a86e7bb4f1d30bf0"
  ) {
    throw new Error("OpenClaw native completion reader differs from the reviewed bundle");
  }
  const target = path.join(dist, TARGET);
  const source = fs.readFileSync(target, "utf8");
  const patched = patchWebhookCompletionText(source);
  if (audit && source !== patched) throw new Error("OpenClaw webhook completion patch is missing");
  if (!audit && source !== patched) fs.writeFileSync(target, patched);
  return source === patched ? "already-patched" : "patched";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const audit = args[0] === "--audit";
  if (audit) args.shift();
  if (args.length !== 1)
    throw new Error("Usage: patch-openclaw-webhook-completion.mts [--audit] <dist>");
  console.log(
    `OpenClaw webhook completion ${patchWebhookCompletion(path.resolve(args[0]!), audit)}`,
  );
}
