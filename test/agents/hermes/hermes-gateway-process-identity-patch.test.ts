// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const PATCHER = path.join(ROOT, "agents", "hermes", "patch-gateway-process-identity.py");

// The pinned Hermes matcher, reduced to the tokenizing/allowlist shape the
// patcher rewrites. Keeping the real grammar here means the assertions below
// exercise the actual decision, not a restatement of the patch.
const UPSTREAM_FIXTURE = `import shlex


def _gateway_command_subcommand(command):
    if not command:
        return None

    try:
        raw_tokens = shlex.split(command, posix=False)
    except ValueError:
        raw_tokens = command.split()
    tokens = [t.strip("\\"'").replace("\\\\", "/").lower() for t in raw_tokens]
    if not tokens:
        return None

    for token in tokens:
        if token == "gateway/run.py" or token.endswith("/gateway/run.py"):
            return "run"
        basename = token.rsplit("/", 1)[-1]
        if basename in ("hermes-gateway", "hermes-gateway.exe"):
            return "run"

    joined = " ".join(tokens)
    has_gateway_entry = (
        "hermes_cli.main" in joined
        or "hermes_cli/main.py" in joined
        or any(t.rsplit("/", 1)[-1] in ("hermes", "hermes.exe") for t in tokens)
    )
    if not has_gateway_entry:
        return None

    filtered = []
    skip_next = False
    for token in tokens:
        if skip_next:
            skip_next = False
            continue
        if token in ("--profile", "-p"):
            skip_next = True
            continue
        if token.startswith("--profile=") or token.startswith("-p="):
            continue
        filtered.append(token)

    for i, token in enumerate(filtered):
        if token != "gateway":
            continue
        if i + 1 >= len(filtered):
            return "run"
        return filtered[i + 1]
    return None


def looks_like_gateway_command_line(command):
    return _gateway_command_subcommand(command) == "run"


def looks_like_gateway_runtime_command_line(command):
    return _gateway_command_subcommand(command) in {"run", "restart"}


if __name__ == "__main__":
    import json
    import sys

    print(
        json.dumps(
            {
                "subcommand": _gateway_command_subcommand(sys.argv[1]),
                "run": looks_like_gateway_command_line(sys.argv[1]),
                "runtime": looks_like_gateway_runtime_command_line(sys.argv[1]),
            }
        )
    )
`;

const RENAMED = "/opt/hermes/.venv/bin/python /usr/local/bin/hermes.real gateway run";
const UPSTREAM_NAME = "/opt/hermes/.venv/bin/python /usr/local/bin/hermes gateway run";

function writeFixture(): { statusPath: string; tmp: string } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-process-identity-"));
  const statusPath = path.join(tmp, "status.py");
  fs.writeFileSync(statusPath, UPSTREAM_FIXTURE);
  return { statusPath, tmp };
}

function runPatcher(statusPath: string) {
  return spawnSync("python3", ["-I", PATCHER, statusPath], {
    encoding: "utf-8",
    timeout: 5000,
  });
}

function classify(statusPath: string, commandLine: string) {
  const result = spawnSync("python3", ["-I", statusPath, commandLine], {
    encoding: "utf-8",
    timeout: 5000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    subcommand: string | null;
    run: boolean;
    runtime: boolean;
  };
}

describe("Hermes gateway process identity", () => {
  it("recognises the renamed entrypoint on both detection paths and stays idempotent", () => {
      const { statusPath, tmp } = writeFixture();
      try {
        // The unpatched matcher is what makes `hermes status` report a running
        // foreground gateway as stopped (#7804): it gates the PID-file liveness
        // re-check and the process-table fallback alike.
        expect(classify(statusPath, RENAMED)).toEqual({
          subcommand: null,
          run: false,
          runtime: false,
        });

        const firstPatch = runPatcher(statusPath);
        const secondPatch = runPatcher(statusPath);
        expect(firstPatch.status, firstPatch.stderr).toBe(0);
        expect(secondPatch.status, secondPatch.stderr).toBe(0);

        expect(classify(statusPath, RENAMED)).toEqual({
          subcommand: "run",
          run: true,
          runtime: true,
        });
        expect(
          classify(
            statusPath,
            "/opt/hermes/.venv/bin/python /usr/local/bin/hermes.real gateway restart",
          ),
        ).toEqual({ subcommand: "restart", run: false, runtime: true });
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });

  it("keeps the upstream name and the subcommand grammar intact", () => {
    const { statusPath, tmp } = writeFixture();
    try {
      expect(runPatcher(statusPath).status).toBe(0);

      // Widening the entry-token allowlist must not widen what counts as a
      // gateway: only a real `gateway run` command line matches, and a
      // look-alike basename is still rejected.
      expect(classify(statusPath, UPSTREAM_NAME).run).toBe(true);
      expect(classify(statusPath, "/usr/local/bin/hermes.real gateway status").run).toBe(false);
      expect(classify(statusPath, "/usr/local/bin/hermes.real dashboard").run).toBe(false);
      expect(classify(statusPath, "python -m tui_gateway run").run).toBe(false);
      expect(classify(statusPath, "/usr/local/bin/hermes.realish gateway run").run).toBe(false);
      expect(
        classify(statusPath, "/usr/local/bin/hermes.real --profile alpha gateway run").run,
      ).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed when the pinned allowlist shape changes", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-identity-drift-"));
    try {
      const drifted = path.join(tmp, "status.py");
      fs.writeFileSync(drifted, 'or any(t.rsplit("/", 1)[-1] in ("hermes",) for t in tokens)\n');
      const result = runPatcher(drifted);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("entry-token allowlist source shape changed");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
