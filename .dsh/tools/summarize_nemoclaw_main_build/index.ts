// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const repo = input.repo ?? "NVIDIA/NemoClaw";
const workflow = input.workflow ?? "main.yaml";
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
if (!/^[A-Za-z0-9_.\/-]+\.ya?ml$/.test(workflow))
  throw new Error("workflow must be a YAML workflow path or filename");
if (input.sha && !/^[0-9a-f]{40}$/.test(input.sha))
  throw new Error("sha must be a full commit SHA");
const limit = Math.min(Math.max(input.maxRuns ?? 25, 1), 100);
const payload = JSON.stringify({
  repo,
  workflow,
  sha: input.sha ?? null,
  includeCurrentMain: input.includeCurrentMain !== false,
  limit,
});
const script = String.raw`import json, subprocess, sys, time, datetime
p=json.loads(sys.argv[1]); transient=('tls handshake timeout','connection reset','temporary','temporarily','http 502','http 503','http 504','unexpected eof','i/o timeout')
def gh(args):
 last=None
 for attempt in range(3):
  last=subprocess.run(['gh']+args,capture_output=True,text=True,timeout=30)
  if last.returncode==0:return last.stdout
  detail=(last.stderr+'\n'+last.stdout).lower()
  if not any(x in detail for x in transient) or attempt==2:break
  time.sleep((attempt+1)*.75)
 raise RuntimeError('GitHub read failed: gh '+' '.join(args[:3])+'\n'+(last.stderr or '')[-1500:])
current=gh(['api',f"repos/{p['repo']}/commits/main",'--jq','.sha']).strip(); target=p['sha'] or current
fields='databaseId,headSha,status,conclusion,displayTitle,createdAt,updatedAt,url'
listed=json.loads(gh(['run','list','--repo',p['repo'],'--workflow',p['workflow'],'--branch','main','--limit',str(p['limit']),'--json',fields]))
def find(sha):
 for run in listed:
  if run.get('headSha')==sha:return run
 exact=json.loads(gh(['run','list','--repo',p['repo'],'--workflow',p['workflow'],'--commit',sha,'--limit','10','--json',fields]))
 return exact[0] if exact else None
def summarize(run):
 if not run:return None
 jobs=[]
 for page in (1,2):
  data=json.loads(gh(['api',f"repos/{p['repo']}/actions/runs/{run['databaseId']}/jobs?filter=latest&per_page=100&page={page}",'--jq','{count:(.jobs|length),jobs:[.jobs[]|{id,name,status,conclusion,started_at,completed_at,html_url}]}']))
  jobs.extend(data['jobs'])
  if data['count']<100:break
 bad=[j for j in jobs if j.get('status')!='completed' or j.get('conclusion') not in ('success','skipped')][:30]
 counts={}
 for j in jobs:
  key=j.get('status') if j.get('status')!='completed' else (j.get('conclusion') or 'none'); counts[key]=counts.get(key,0)+1
 return {'id':run['databaseId'],'sha':run['headSha'],'title':run['displayTitle'],'status':run['status'],'conclusion':run.get('conclusion') or None,'createdAt':run['createdAt'],'updatedAt':run['updatedAt'],'url':run['url'],'jobs':{'total':len(jobs),'counts':[{'name':k,'count':v} for k,v in sorted(counts.items())],'nonPassing':bad,'truncated':len(bad)>=30 or len(jobs)>=200}}
target_run=summarize(find(target)); current_run=None if not p['includeCurrentMain'] or current==target else summarize(find(current))
result='main-build-not-found'
if target_run and target_run['status']!='completed':result='main-build-in-progress'
elif target_run and target_run['conclusion']=='success':result='main-build-passed'
elif target_run and target_run['conclusion']=='cancelled' and target!=current:result='main-build-superseded'
elif target_run:result='main-build-did-not-pass'
print(json.dumps({'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z'),'repo':p['repo'],'workflow':p['workflow'],'targetSha':target,'currentMain':current,'targetIsCurrent':target==current,'result':result,'targetRun':target_run,'currentRun':current_run}))`;
const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
const result = await tools.bash({
  command: "python3 -c " + quote(script) + " " + quote(payload),
  workdir: input.workdir,
  description: "Summarize NemoClaw main build status",
  timeoutMs: 120000,
});
if (result.kind !== "foreground") throw new Error("Unexpected background result");
if (result.exitCode !== 0) throw new Error((result.stderr.text || result.stdout.text).slice(-2000));
return JSON.parse(result.stdout.text);
