// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { V1ALPHA1_CHECKED_REVISION } from "../../src/lib/domain/config/v1alpha1-checked-revision";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const CONSUMER_SOURCE = path.join(
  REPO_ROOT,
  "test/fixtures/v1-config-consumer/config_export_compatibility.rs",
);
const PASSTHROUGH_ENV = [
  "CARGO_HOME",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "RUSTUP_HOME",
  "RUSTUP_TOOLCHAIN",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
] as const;

function consumerEnvironment(values: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH_ENV) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return { ...environment, ...values };
}

export interface V1ParseEvidence {
  revision: typeof V1ALPHA1_CHECKED_REVISION;
  /** The document as the pinned v1 SDK parsed it, after v1 defaulting. */
  document: Record<string, any>;
}

/** Extract the pinned v1 revision with the consumer example into `consumer`, which must not exist. */
function extractConsumer(consumer: string, archive: string): void {
  execFileSync(
    "git",
    ["-C", REPO_ROOT, "archive", "--format=tar", `--output=${archive}`, V1ALPHA1_CHECKED_REVISION],
    { stdio: "pipe", timeout: 30_000 },
  );
  fs.mkdirSync(consumer);
  execFileSync("tar", ["-xf", archive, "-C", consumer], { stdio: "pipe", timeout: 30_000 });
  const examples = path.join(consumer, "crates/nemoclaw-sdk/examples");
  fs.mkdirSync(examples, { recursive: true });
  fs.copyFileSync(CONSUMER_SOURCE, path.join(examples, "config_export_compatibility.rs"));
}

/**
 * With NEMOCLAW_V1_CONSUMER_CACHE_DIR set (CI), every consumer in the process tree shares one
 * extraction per revision and one Cargo target directory, so the v1 SDK builds once; Cargo's
 * build lock serializes concurrent first builds. The directory is never removed here.
 */
function prepareSharedWorkspace(root: string) {
  fs.mkdirSync(root, { recursive: true });
  const consumer = path.join(root, `consumer-${V1ALPHA1_CHECKED_REVISION}`);
  if (!fs.existsSync(consumer)) {
    const staging = fs.mkdtempSync(path.join(root, "extract-"));
    try {
      extractConsumer(path.join(staging, "consumer"), path.join(staging, "consumer.tar"));
      try {
        fs.renameSync(path.join(staging, "consumer"), consumer);
      } catch (error) {
        // Another worker published the same extraction first.
        if (!fs.existsSync(consumer)) throw error;
      }
    } finally {
      fs.rmSync(staging, { force: true, recursive: true });
    }
  }
  return { root, consumer, shared: true };
}

function prepareWorkspace() {
  const cache = process.env.NEMOCLAW_V1_CONSUMER_CACHE_DIR;
  if (cache) return prepareSharedWorkspace(cache);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-v1-parse-"));
  try {
    const consumer = path.join(root, "consumer");
    extractConsumer(consumer, path.join(root, "consumer.tar"));
    return { root, consumer, shared: false };
  } catch (error) {
    fs.rmSync(root, { force: true, recursive: true });
    throw error;
  }
}

/** Parse exports with the pinned v1 SDK, reusing one checkout and Cargo build until disposed. */
export function createV1ParseConsumer() {
  let workspace: ReturnType<typeof prepareWorkspace> | undefined;
  return {
    parse(raw: string): V1ParseEvidence {
      workspace ??= prepareWorkspace();
      const { root, consumer } = workspace;
      const invocation = fs.mkdtempSync(path.join(root, "parse-"));
      const input = path.join(invocation, "export.yaml");
      const output = path.join(invocation, "document.json");
      try {
        fs.writeFileSync(input, raw, { mode: 0o600 });
        try {
          execFileSync(
            "cargo",
            [
              "run",
              "--locked",
              "-q",
              "-p",
              "nemoclaw-sdk",
              "--example",
              "config_export_compatibility",
            ],
            {
              cwd: consumer,
              env: consumerEnvironment({
                CARGO_TARGET_DIR: path.join(root, "cargo-target"),
                CARGO_INCREMENTAL: "0",
                CARGO_PROFILE_DEV_DEBUG: "0",
                NEMOCLAW_V1_CONFIG_INPUT: input,
                NEMOCLAW_V1_DOCUMENT_OUTPUT: output,
              }),
              maxBuffer: 10 * 1024 * 1024,
              stdio: "pipe",
              timeout: 15 * 60_000,
            },
          );
        } catch (error) {
          const failure = error as Error & { status?: number | null; stderr?: Buffer };
          throw new Error(
            `Pinned v1 parse failed (status=${failure.status ?? "unknown"}).\n` +
              `stderr tail:\n${failure.stderr?.toString().slice(-1_000) ?? ""}`,
          );
        }
        return {
          revision: V1ALPHA1_CHECKED_REVISION,
          document: JSON.parse(fs.readFileSync(output, "utf8")),
        };
      } finally {
        fs.rmSync(invocation, { force: true, recursive: true });
      }
    },
    /**
     * The harness kinds a v1 example at the pinned revision declares, as the pinned SDK parses them.
     * An exported kind is checked against these, because parse alone accepts any nonempty kind.
     */
    exampleHarnessKinds(example: string): string[] {
      workspace ??= prepareWorkspace();
      const raw = fs.readFileSync(path.join(workspace.consumer, example), "utf8");
      return Object.values<{ harness: { kind: string } }>(
        this.parse(raw).document.spec.sandboxes,
      ).map((sandbox) => sandbox.harness.kind);
    },
    dispose(): void {
      if (workspace) {
        if (!workspace.shared) fs.rmSync(workspace.root, { force: true, recursive: true });
        workspace = undefined;
      }
    },
  };
}

export interface V1ParseSummary {
  revision: typeof V1ALPHA1_CHECKED_REVISION;
  sandboxes: Record<string, { harnessKind: string; imageRef: string; integrationRefs: string[] }>;
  integrations: Record<string, { provider: string; credentialReference: string }>;
}

/** Reduce a parsed document to the facts a parse-only check asserts. */
export function summarizeV1Parse(evidence: V1ParseEvidence): V1ParseSummary {
  const { spec } = evidence.document;
  return {
    revision: evidence.revision,
    sandboxes: Object.fromEntries(
      Object.entries<Record<string, any>>(spec.sandboxes ?? {}).map(([name, sandbox]) => [
        name,
        {
          harnessKind: sandbox.harness.kind,
          imageRef: sandbox.image?.ref,
          integrationRefs: sandbox.agent.integration_refs ?? sandbox.agent.integrationRefs ?? [],
        },
      ]),
    ),
    integrations: Object.fromEntries(
      Object.entries<Record<string, any>>(spec.integrations ?? {}).map(([name, integration]) => [
        name,
        { provider: integration.provider, credentialReference: integration.credential?.env },
      ]),
    ),
  };
}
