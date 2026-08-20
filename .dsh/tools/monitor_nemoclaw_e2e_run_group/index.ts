// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const repo = input.repo ?? "NVIDIA/NemoClaw";
const workflow = input.workflow ?? "e2e.yaml";
const branch = input.branch ?? "main";
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
if (!/^[A-Za-z0-9_.\/-]+\.ya?ml$/.test(workflow))
  throw new Error("workflow must be a YAML workflow path or filename");
if (!/^[A-Za-z0-9_.\/-]+$/.test(branch)) throw new Error("branch is invalid");
if (!/^[0-9a-f]{40}$/.test(input.candidateSha))
  throw new Error("candidateSha must be a full lowercase commit SHA");
const runIds = [...new Set(input.runIds)];
if (
  runIds.length === 0 ||
  runIds.length > 20 ||
  runIds.some((id) => !Number.isInteger(id) || id <= 0)
)
  throw new Error("runIds must contain 1 to 20 positive run IDs");
const timeoutMs = Math.max(0, Math.min(1800000, input.timeoutMs ?? 600000));
const intervalMs = Math.max(5000, Math.min(120000, input.intervalMs ?? 30000));
const runLimit = Math.max(runIds.length, Math.min(100, input.runLimit ?? 100));
const script = String.raw`import datetime, json, subprocess, sys, time
repo, workflow, branch, sha, ids_json, timeout_raw, interval_raw, limit_raw, include_raw = sys.argv[1:]
run_ids=json.loads(ids_json); deadline=time.monotonic()+int(timeout_raw)/1000; interval=int(interval_raw)/1000; polls=0; selected=[]; reason=None
def gh(args):
 p=subprocess.run(['gh',*args],capture_output=True,text=True,timeout=60)
 if p.returncode: raise RuntimeError(p.stderr[-1500:] or 'GitHub CLI command failed')
 return json.loads(p.stdout or 'null')
def cut(value, size):
 return value[:size] if isinstance(value,str) else None
while True:
 polls += 1
 runs=gh(['run','list','--repo',repo,'--workflow',workflow,'--branch',branch,'--limit',limit_raw,'--json','databaseId,displayTitle,headSha,status,conclusion,url'])
 selected=[next((r for r in runs if r.get('databaseId')==run_id),{'databaseId':run_id,'missing':True}) for run_id in run_ids]
 if any(not r.get('missing') and r.get('headSha') != sha for r in selected): reason='candidate-commit-mismatch'; break
 if all(not r.get('missing') and r.get('status')=='completed' for r in selected): break
 if time.monotonic() >= deadline: reason='run-not-in-bounded-list' if any(r.get('missing') for r in selected) else 'timeout'; break
 time.sleep(interval)
summaries=[]
if include_raw == 'true':
 for run in (r for r in selected if not r.get('missing')):
  view=gh(['run','view',str(run['databaseId']),'--repo',repo,'--json','status,conclusion,attempt,jobs'])
  jobs=view.get('jobs') or []; counts={}
  for job in jobs:
   state=job.get('conclusion') or job.get('status') or 'unknown'; counts[state]=counts.get(state,0)+1
  failures=[]
  for job in (j for j in jobs if j.get('conclusion')=='failure'):
   failures.append({'name':cut(job.get('name'),500) or '', 'url':cut(job.get('url'),2000), 'failedSteps':[cut(s.get('name'),500) or '' for s in (job.get('steps') or []) if s.get('conclusion')=='failure'][:100]})
  remaining=[{'name':cut(j.get('name'),500) or '', 'status':cut(j.get('status'),100), 'url':cut(j.get('url'),2000)} for j in jobs if j.get('status')!='completed'][:50]
  summaries.append({'runId':run['databaseId'],'attempt':view.get('attempt'),'status':cut(view.get('status'),100),'conclusion':cut(view.get('conclusion'),100),'counts':[{'state':cut(k,100) or '', 'count':v} for k,v in sorted(counts.items())][:30],'failures':failures[:50],'remaining':remaining})
result={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z'),'repo':repo,'workflow':workflow,'branch':branch,'candidateSha':sha,'terminal':all(not r.get('missing') and r.get('status')=='completed' for r in selected),'reason':reason,'polls':polls,'runs':[{'runId':r['databaseId'],'title':cut(r.get('displayTitle'),500),'headSha':cut(r.get('headSha'),40),'status':cut(r.get('status'),100),'conclusion':cut(r.get('conclusion'),100),'url':cut(r.get('url'),2000),'missing':bool(r.get('missing'))} for r in selected],'jobSummaries':summaries}
print(json.dumps(result,separators=(',',':')))`;
const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
const args = [
  repo,
  workflow,
  branch,
  input.candidateSha,
  JSON.stringify(runIds),
  String(timeoutMs),
  String(intervalMs),
  String(runLimit),
  String(input.includeJobs !== false),
];
const command = "python3 -c " + quote(script) + " " + args.map(quote).join(" ");
const result = await tools.bash({
  command,
  workdir: input.workdir,
  description: "Monitor bounded NemoClaw E2E run group",
  timeoutMs: Math.min(1865000, timeoutMs + 65000),
});
if (result.kind !== "foreground") throw new Error("Unexpected background result");
if (result.exitCode !== 0)
  throw new Error("GitHub E2E run monitoring failed: " + result.stderr.text.slice(-1500));
return JSON.parse(result.stdout.text);
