// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const CONTRACT = path.join(ROOT, "agents", "hermes", "hermes-cli-adapter-v1.json");
const VALIDATOR = path.join(ROOT, "agents", "hermes", "validate-cli-adapter.py");

const PARSER_FIXTURE = `
import argparse

PRE_ARGPARSE_INHERITED_FLAGS = [("-p", True), ("--profile", True)]

def _add_shared(parser, include_provider=True):
    parser.add_argument("-m", "--model")
    if include_provider:
        parser.add_argument("--provider")
    parser.add_argument("-t", "--toolsets")
    parser.add_argument("-s", "--skills", action="append")
    parser.add_argument("-r", "--resume")
    parser.add_argument("-c", "--continue", nargs="?")
    parser.add_argument("-w", "--worktree", action="store_true")
    for name in (
        "--accept-hooks",
        "--yolo",
        "--pass-session-id",
        "--ignore-user-config",
        "--ignore-rules",
        "--no-restore-cwd",
        "--safe-mode",
    ):
        parser.add_argument(name, action="store_true")

def build_top_level_parser():
    top = argparse.ArgumentParser()
    top.add_argument("-z", "--oneshot")
    top.add_argument("--usage-file")
    _add_shared(top)
    chat = argparse.ArgumentParser()
    _add_shared(chat)
    return top, None, chat
`;

const MAIN_FIXTURE = `
def _coalesce_session_name_args(argv):
    _SUBCOMMANDS = {"chat", "gateway", "sessions"}
    return argv
`;

function runValidator(
  contract: object,
  parserFixture = PARSER_FIXTURE,
  mainFixture = MAIN_FIXTURE,
) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-adapter-"));
  try {
    const packageDir = path.join(fixture, "hermes_cli");
    fs.mkdirSync(packageDir);
    fs.writeFileSync(path.join(packageDir, "__init__.py"), '__version__ = "0.19.0"\n');
    fs.writeFileSync(path.join(packageDir, "_parser.py"), parserFixture);
    fs.writeFileSync(path.join(packageDir, "main.py"), mainFixture);
    const contractPath = path.join(fixture, "adapter.json");
    fs.writeFileSync(contractPath, `${JSON.stringify(contract)}\n`);
    const hermes = path.join(fixture, "hermes");
    fs.writeFileSync(hermes, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    return spawnSync("python3", [VALIDATOR, "--contract", contractPath, "--hermes", hermes], {
      encoding: "utf8",
      env: { ...process.env, PYTHONPATH: fixture },
    });
  } finally {
    fs.rmSync(fixture, { force: true, recursive: true });
  }
}

describe("Hermes CLI adapter validator", () => {
  it("accepts the upstream session-name coalescer as its boundary authority (#8011)", () => {
    const contract = JSON.parse(fs.readFileSync(CONTRACT, "utf8"));

    const result = runValidator(contract);

    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects an upstream session-name coalescer without its literal boundary set (#8011)", () => {
    const contract = JSON.parse(fs.readFileSync(CONTRACT, "utf8"));
    const mainFixture = MAIN_FIXTURE.replace("_SUBCOMMANDS", "_OTHER_BOUNDARIES");

    const result = runValidator(contract, PARSER_FIXTURE, mainFixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("session-name coalescer boundary set is incompatible");
  });

  it("rejects a preparse option whose contract arity does not require a value (#8011)", () => {
    const contract = JSON.parse(fs.readFileSync(CONTRACT, "utf8"));
    const profile = contract.options.find((option: { id: string }) => option.id === "profile");
    profile.arity = "boolean";

    const result = runValidator(contract);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "adapter option profile has arity boolean, but preparse parser metadata requires a value",
    );
  });

  it("rejects a translated option missing from the upstream chat parser (#8011)", () => {
    const contract = JSON.parse(fs.readFileSync(CONTRACT, "utf8"));
    const parserFixture = PARSER_FIXTURE.replace(
      "    _add_shared(chat)",
      "    _add_shared(chat, include_provider=False)",
    );

    const result = runValidator(contract, parserFixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "adapter option --provider is absent from the upstream chat parser",
    );
  });
});
