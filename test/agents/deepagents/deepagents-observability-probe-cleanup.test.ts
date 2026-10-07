// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const check = readFileSync(
  new URL(
    "../../e2e/e2e-cloud-experimental/checks/11-deepagents-code-observability.sh",
    import.meta.url,
  ),
  "utf8",
);
const source = check.match(/cleanup_redaction_probe\(\)[\s\S]*?<<'PY'\n([\s\S]*?)\nPY/)?.[1];

it.each([
  ["owned", "required", ["owned"], ["other"], false],
  ["missing", "optional", [], ["other"], false],
  ["missing", "required", [], ["other"], true],
  ["duplicate", "required", [], ["other", "owned", "duplicate"], true],
  ["delete-failure", "required", [], ["other", "owned"], true],
  ["still-present", "required", ["owned"], ["other", "owned"], true],
] as const)(
  "preserves unrelated history during %s probe cleanup (%s)",
  (scenario, mode, deleted, remaining, fails) => {
    expect(source).toBeDefined();
    const result = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        `
import json, sys, types
scenario, mode = sys.argv[1:]
threads = [{"thread_id": "other", "initial_prompt": "unrelated user history"}]
if scenario != "missing":
    threads.append({"thread_id": "owned", "initial_prompt": "unique test input"})
if scenario == "duplicate":
    threads.append({"thread_id": "duplicate", "initial_prompt": "unique test input"})
deleted = []
async def list_threads(**kwargs): return list(threads)
async def populate_thread_checkpoint_details(*args, **kwargs): pass
async def delete_thread(thread_id):
    if scenario == "delete-failure": return False
    deleted.append(thread_id)
    if scenario != "still-present":
        threads[:] = [t for t in threads if t["thread_id"] != thread_id]
    return True
async def thread_exists(thread_id):
    return any(t["thread_id"] == thread_id for t in threads)
module = types.ModuleType("deepagents_code")
module.sessions = types.SimpleNamespace(
    list_threads=list_threads, populate_thread_checkpoint_details=populate_thread_checkpoint_details,
    delete_thread=delete_thread, thread_exists=thread_exists,
)
sys.modules["deepagents_code"] = module
sys.argv = ["cleanup", "unique test input", mode]
error = None
try:
    exec(compile(sys.stdin.read(), "probe-cleanup", "exec"))
except RuntimeError as exc:
    error = str(exc)
print(json.dumps({"deleted": deleted, "remaining": [t["thread_id"] for t in threads], "failed": error is not None}))
`,
        scenario,
        mode,
      ],
      { input: source, encoding: "utf8", timeout: 5000 },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ deleted, remaining, failed: fails });
  },
);
