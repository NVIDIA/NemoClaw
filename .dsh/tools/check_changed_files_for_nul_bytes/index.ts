// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const changed = await tools.list_nemoclaw_changed_files({
  workdir: input.workdir,
  baseRef: input.baseRef,
});
if (changed.files.length === 0) return { ok: true, checked: 0, files: [], findings: [], changed };
const quote = (v) => "'" + String(v).replaceAll("'", "'\"'\"'") + "'";
const script =
  "from pathlib import Path\nimport json,sys\nchecked=[];findings=[]\nfor raw in sys.argv[1:]:\n p=Path(raw)\n if not p.is_file(): continue\n checked.append(raw); count=p.read_bytes().count(b'\\x00')\n if count: findings.append({'file':raw,'count':count})\nprint(json.dumps({'checked':checked,'findings':findings}))";
const command = "python3 -c " + quote(script) + " " + changed.files.map(quote).join(" ");
const result = await tools.bash({
  command,
  workdir: input.workdir,
  description: "Check changed files for NUL bytes",
  timeoutMs: 30000,
});
if (result.kind !== "foreground" || result.exitCode !== 0)
  throw new Error("Could not scan changed files");
const parsed = JSON.parse(result.stdout.text);
return {
  ok: parsed.findings.length === 0,
  checked: parsed.checked.length,
  files: parsed.checked,
  findings: parsed.findings,
  changed,
};
