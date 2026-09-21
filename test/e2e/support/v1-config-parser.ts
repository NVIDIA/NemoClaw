// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { REPO_ROOT } from "../fixtures/paths.ts";

export const V1_CONFIG_PARSER_REVISION = "88c6600c06b0937907290362eef86912052c4ad0" as const;

interface ParserInput {
  readonly name: string;
  readonly raw: string;
}

interface ParserValidationInput {
  readonly accepted: readonly ParserInput[];
  readonly rejected: readonly ParserInput[];
}

interface ParserValidationRecord {
  readonly name: string;
  readonly sha256: string;
}

export interface ParserValidationResult {
  readonly revision: typeof V1_CONFIG_PARSER_REVISION;
  readonly accepted: readonly ParserValidationRecord[];
  readonly rejected: readonly ParserValidationRecord[];
}

const RUST_ACCEPTANCE_TEST = `// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::config::Document;
use std::{env, fs};

fn validate_directory(variable: &str, should_accept: bool) {
    let directory = env::var(variable).expect("missing parser fixture directory");
    let mut paths = fs::read_dir(directory)
        .expect("cannot read parser fixture directory")
        .map(|entry| entry.expect("cannot read parser fixture entry").path())
        .collect::<Vec<_>>();
    paths.sort();
    assert!(!paths.is_empty(), "parser fixture directory must not be empty");
    for path in paths {
        let bytes = fs::read(&path).expect("cannot read parser fixture");
        let result = Document::parse(bytes.as_slice());
        assert_eq!(
            result.is_ok(),
            should_accept,
            "unexpected parser result for {}: {:?}",
            path.display(),
            result.err()
        );
    }
}

#[test]
fn validates_config_export_contract() {
    validate_directory("NEMOCLAW_V1_ACCEPTED_CONFIGS", true);
    validate_directory("NEMOCLAW_V1_REJECTED_CONFIGS", false);
}
`;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeInputs(directory: string, inputs: readonly ParserInput[]): ParserValidationRecord[] {
  fs.mkdirSync(directory, { recursive: true });
  return inputs.map((input, index) => {
    const safeName = input.name.replace(/[^a-z0-9-]/giu, "-");
    fs.writeFileSync(
      path.join(directory, `${String(index).padStart(2, "0")}-${safeName}.yaml`),
      input.raw,
    );
    return { name: input.name, sha256: sha256(input.raw) };
  });
}

/** Validate raw producer YAML with the exact v1 consumer parser revision. */
export function validateWithRevisionMatchedV1Parser(
  input: ParserValidationInput,
): ParserValidationResult {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-v1-parser-"));
  const worktree = path.join(temporaryRoot, "v1");
  const acceptedDirectory = path.join(temporaryRoot, "accepted");
  const rejectedDirectory = path.join(temporaryRoot, "rejected");
  const accepted = writeInputs(acceptedDirectory, input.accepted);
  const rejected = writeInputs(rejectedDirectory, input.rejected);
  let worktreeAdded = false;
  try {
    execFileSync(
      "git",
      ["-C", REPO_ROOT, "worktree", "add", "--detach", worktree, V1_CONFIG_PARSER_REVISION],
      { encoding: "utf8", stdio: "pipe" },
    );
    worktreeAdded = true;
    fs.writeFileSync(
      path.join(worktree, "crates/nemoclaw-sdk/tests/config_export_acceptance.rs"),
      RUST_ACCEPTANCE_TEST,
    );
    execFileSync(
      "cargo",
      ["test", "--locked", "-p", "nemoclaw-sdk", "--test", "config_export_acceptance"],
      {
        cwd: worktree,
        encoding: "utf8",
        env: {
          ...process.env,
          CARGO_TARGET_DIR: path.join(
            os.tmpdir(),
            `nemoclaw-v1-parser-target-${V1_CONFIG_PARSER_REVISION}`,
          ),
          NEMOCLAW_V1_ACCEPTED_CONFIGS: acceptedDirectory,
          NEMOCLAW_V1_REJECTED_CONFIGS: rejectedDirectory,
        },
        maxBuffer: 10 * 1024 * 1024,
        stdio: "pipe",
      },
    );
    return { revision: V1_CONFIG_PARSER_REVISION, accepted, rejected };
  } finally {
    if (worktreeAdded) {
      execFileSync("git", ["-C", REPO_ROOT, "worktree", "remove", "--force", worktree], {
        encoding: "utf8",
        stdio: "pipe",
      });
    }
    fs.rmSync(temporaryRoot, { force: true, recursive: true });
  }
}
