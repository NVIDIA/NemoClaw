// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const repo = input.repo ?? "NVIDIA/NemoClaw";
const jobId = String(input.jobId);
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
if (!/^\d+$/.test(jobId) || jobId === "0") throw new Error("jobId must be positive");
const tailLines = Math.max(20, Math.min(500, input.tailLines ?? 180));
const contextLines = Math.max(0, Math.min(80, input.contextLines ?? 40));
const pattern = input.pattern ?? "";
if (pattern.length > 1000) throw new Error("pattern is too long");
try {
  new RegExp(pattern, "iu");
} catch (error) {
  throw new Error(`Invalid pattern: ${String(error)}`);
}
const script =
  "import json, re, subprocess, sys\nrepo, job_id, pattern, context_raw, tail_raw = sys.argv[1:]\nproc = subprocess.run(['gh','api',f'repos/{repo}/actions/jobs/{job_id}/logs'],capture_output=True)\nif proc.returncode != 0:\n print(json.dumps({'code':proc.returncode,'stdout':'','stderr':proc.stderr.decode('utf-8','replace')[-12000:],'matchedLines':0,'truncated':False})); raise SystemExit(0)\nlines=proc.stdout.decode('utf-8','replace').splitlines(); context=int(context_raw); tail=int(tail_raw); matched=0\nif pattern:\n matcher=re.compile(pattern,re.IGNORECASE); indexes=set()\n for index,line in enumerate(lines):\n  if matcher.search(line): matched += 1; indexes.update(range(max(0,index-context),min(len(lines),index+context+1)))\n selected=[lines[index] for index in sorted(indexes)]\nelse: selected=lines\ncandidates=selected[-tail:]; bounded=[]; size=0\nfor line in reversed(candidates):\n line=line[:4000]\n if size+len(line)+1>40000: break\n bounded.append(line); size += len(line)+1\nbounded.reverse()\nprint(json.dumps({'code':0,'stdout':'\\n'.join(bounded),'stderr':proc.stderr.decode('utf-8','replace')[-4000:],'matchedLines':matched,'truncated':len(selected)>len(bounded)}))";
const q = (v) => "'" + String(v).replaceAll("'", "'\"'\"'") + "'";
const command =
  "python3 -c " +
  q(script) +
  " " +
  [repo, jobId, pattern, String(contextLines), String(tailLines)].map(q).join(" ");
const result = await tools.bash({
  command,
  workdir: input.workdir,
  description: "Inspect bounded GitHub job log",
  timeoutMs: 60000,
});
if (result.kind !== "foreground" || result.exitCode !== 0)
  throw new Error("Could not inspect job log");
const parsed = JSON.parse(result.stdout.text);
return {
  jobId,
  repo,
  pattern: input.pattern ?? null,
  code: parsed.code,
  truncated: parsed.truncated,
  matchedLines: parsed.matchedLines,
  stdout: parsed.stdout,
  stderr: parsed.stderr,
};
