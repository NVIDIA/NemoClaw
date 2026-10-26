// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

type Step = { name?: string; run?: string };
type Workflow = { jobs: Record<string, { steps?: Step[] }> };

const root = path.resolve(import.meta.dirname, "../../..");
const image = "ghcr.io/nvidia/nemoclaw/llama-cpp-server";
const digest = `sha256:${"a".repeat(64)}`;
const reference = `${image}@${digest}`;
const identity =
  "https://github.com/NVIDIA/NemoClaw/.github/workflows/llama-cpp-image-attest.yaml@refs/heads/main";
const issuer = "https://token.actions.githubusercontent.com";
const cosign2 =
  "ghcr.io/sigstore/cosign/cosign@sha256:68839b7f13dac5a6744a5d8818e984dd39183374e37855c19e14d623d9bc9037";

function workflowStep(file: string, job: string, name: string): Step {
  const workflow = YAML.parse(
    fs.readFileSync(path.join(root, ".github/workflows", file), "utf8"),
  ) as Workflow;
  const step = workflow.jobs[job]?.steps?.find((candidate) => candidate.name === name);
  expect(step?.run, `Missing workflow command: ${name}`).toBeTypeOf("string");
  return step as Step;
}

function runStep(step: Step, executable: string, failFormat = "", commandStatus = 0) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "llama-signatures-"));
  const bin = path.join(temporary, "bin");
  const record = path.join(temporary, "commands.jsonl");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, executable),
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.COMMAND_RECORD, JSON.stringify(args) + "\\n");
const format = args.includes("--new-bundle-format=false") ? "legacy" : "bundle";
process.stdout.write("[]\\n");
process.exit(format === process.env.FAIL_FORMAT ? 23 : Number(process.env.COMMAND_STATUS));
`,
    { mode: 0o755 },
  );
  try {
    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", step.run ?? ""], {
      cwd: temporary,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        COMMAND_RECORD: record,
        COMMAND_STATUS: String(commandStatus),
        FAIL_FORMAT: failFormat,
        IMAGE: image,
        DIGEST: digest,
        REFERENCE: reference,
        CERTIFICATE_IDENTITY: identity,
        CERTIFICATE_OIDC_ISSUER: issuer,
      },
    });
    const invocations = fs
      .readFileSync(record, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    return { ...result, invocations };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

describe("llama.cpp signature compatibility", () => {
  it("signs the same index in bundle and legacy formats (#12206)", () => {
    const step = workflowStep(
      "llama-cpp-image-attest.yaml",
      "attest",
      "Sign exact candidate index",
    );
    const result = runStep(step, "cosign");
    expect(result.status, result.stderr).toBe(0);
    expect(result.invocations).toEqual([
      ["sign", "--yes", reference],
      [
        "sign",
        "--yes",
        "--new-bundle-format=false",
        "--use-signing-config=false",
        "--tlog-upload=true",
        reference,
      ],
    ]);
  });

  it.each([
    ["bundle", 1],
    ["legacy", 2],
  ])("fails publication when %s signing fails (#12206)", (format, count) => {
    const step = workflowStep(
      "llama-cpp-image-attest.yaml",
      "attest",
      "Sign exact candidate index",
    );
    const result = runStep(step, "cosign", String(format));
    expect(result.status, result.stderr).toBe(23);
    expect(result.invocations).toHaveLength(Number(count));
  });

  it.each([0, 31])("preserves the Cosign 2 verification result %s (#12206)", (status) => {
    const step = workflowStep(
      "llama-cpp-image.yaml",
      "verify-legacy-candidate",
      "Verify legacy signature anonymously",
    );
    const result = runStep(step, "docker", "", status);
    expect(result.status, result.stderr).toBe(status);
    expect(result.invocations).toEqual([
      [
        "run",
        "--rm",
        cosign2,
        "verify",
        "--certificate-identity",
        identity,
        "--certificate-oidc-issuer",
        issuer,
        reference,
      ],
    ]);
  });
});
