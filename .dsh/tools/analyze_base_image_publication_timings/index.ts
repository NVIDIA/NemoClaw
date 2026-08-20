// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const repo = input.repo ?? "NVIDIA/NemoClaw";
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
const e2eLimit = Math.max(30, Math.min(500, input.e2eLimit ?? 300));
const baseLimit = Math.max(e2eLimit, Math.min(500, input.baseLimit ?? 500));
const maxPerStratum = Math.max(30, Math.min(200, input.maxPerStratum ?? 150));
const payload = JSON.stringify({ repo, e2eLimit, baseLimit, maxPerStratum });
const script = String.raw`import json,subprocess,sys,math,datetime,concurrent.futures
p=json.loads(sys.argv[1])
def gh(args,timeout=60):
 r=subprocess.run(['gh']+args,capture_output=True,text=True,timeout=timeout)
 if r.returncode:raise RuntimeError(('GitHub read failed: '+r.stderr)[-2000:])
 return r.stdout
def listed(workflow,limit,fields,jq):
 try:return json.loads(gh(['run','list','--repo',p['repo'],'--workflow',workflow,'--branch','main','--event','push','--limit',str(limit),'--json',fields,'--jq',jq]))
 except json.JSONDecodeError:raise RuntimeError(f'GitHub {workflow} run data exceeded the bounded response; reduce the run limit')
e2e=listed('e2e.yaml',p['e2eLimit'],'databaseId,headSha,createdAt,status','[.[]|select(.status=="completed")|{id:.databaseId,sha:.headSha,createdAt}]')
base=set(listed('base-image.yaml',p['baseLimit'],'headSha','[.[].headSha]'))
groups={'same-commit-publication':[r for r in e2e if r['sha'] in base],'reuse-prior-publication':[r for r in e2e if r['sha'] not in base]}
def select(values,count):
 if len(values)<=count:return values
 return [values[round(i*(len(values)-1)/(count-1))] for i in range(count)]
selected=[]
for stratum,runs in groups.items():selected += [dict(r,stratum=stratum) for r in select(runs,p['maxPerStratum'])]
def detail(run):
 jq='{jobs:[.jobs[]|select(.name=="base-image-publication" or .name=="generate-matrix")]}'
 data=json.loads(gh(['run','view',str(run['id']),'--repo',p['repo'],'--json','jobs','--jq',jq]))
 return dict(run,publication=next((j for j in data['jobs'] if j['name']=='base-image-publication'),None),matrix=next((j for j in data['jobs'] if j['name']=='generate-matrix'),None))
with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:observations=list(pool.map(detail,selected))
def elapsed(start,end):
 if not start or not end:return None
 try:
  a=datetime.datetime.fromisoformat(start.replace('Z','+00:00'));b=datetime.datetime.fromisoformat(end.replace('Z','+00:00'));v=(b-a).total_seconds();return v if v>=0 else None
 except ValueError:return None
def quant(v,q):
 a=sorted(v);pos=(len(a)-1)*q;lo=int(pos);return a[lo]+(a[min(lo+1,len(a)-1)]-a[lo])*(pos-lo)
def rnd(v):return None if v is None else round(v,1)
def median_ci(values):
 if len(values)<2:return [rnd(values[0] if values else None)]*2
 seed=0x7372; estimates=[]
 for _ in range(3000):
  sample=[]
  for _ in values:
   seed=(1664525*seed+1013904223)&0xffffffff;sample.append(values[int((seed/4294967296)*len(values))])
  estimates.append(quant(sample,.5))
 return [rnd(quant(estimates,.025)),rnd(quant(estimates,.975))]
def stats(raw):
 v=[x for x in raw if x is not None]
 if not v:return None
 mean=sum(v)/len(v);sd=math.sqrt(sum((x-mean)**2 for x in v)/(len(v)-1)) if len(v)>1 else 0
 return {'n':len(v),'minSeconds':rnd(min(v)),'medianSeconds':rnd(quant(v,.5)),'median95CiSeconds':median_ci(v),'meanSeconds':rnd(mean),'mean95CiSeconds':[rnd(mean-1.96*sd/math.sqrt(len(v))),rnd(mean+1.96*sd/math.sqrt(len(v)))],'p90Seconds':rnd(quant(v,.9)),'p95Seconds':rnd(quant(v,.95)),'maxSeconds':rnd(max(v))}
def summarize(items):
 outcomes={}
 for x in items:
  pub=x.get('publication');outcome=(pub.get('conclusion') or pub.get('status')) if pub else 'missing';outcomes[outcome]=outcomes.get(outcome,0)+1
 good=[x for x in items if (x.get('publication') or {}).get('conclusion')=='success']
 def step(x,name):return next((s for s in x['publication'].get('steps',[]) if s.get('name')==name),{})
 return {'selectedRuns':len(items),'successfulJobs':len(good),'atLeast30SuccessfulJobs':len(good)>=30,'outcomes':[{'name':k,'count':v} for k,v in sorted(outcomes.items())],'jobExecution':stats([elapsed(x['publication'].get('startedAt'),x['publication'].get('completedAt')) for x in good]),'verifier':stats([elapsed(step(x,'Verify applicable base-image publication').get('startedAt'),step(x,'Verify applicable base-image publication').get('completedAt')) for x in good]),'workflowCreationToCompletion':stats([elapsed(x.get('createdAt'),x['publication'].get('completedAt')) for x in good]),'runnerQueue':stats([elapsed(x.get('createdAt'),x['publication'].get('startedAt')) for x in good]),'boundaryToMatrixStart':stats([elapsed(x['publication'].get('completedAt'),(x.get('matrix') or {}).get('startedAt')) for x in good])}
same=[x for x in observations if x['stratum']=='same-commit-publication']; reused=[x for x in observations if x['stratum']=='reuse-prior-publication']
print(json.dumps({'measuredAt':datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z'),'population':{'completedE2eRuns':len(e2e),'range':[e2e[-1].get('createdAt') if e2e else None,e2e[0].get('createdAt') if e2e else None],'classified':{'same-commit-publication':len(groups['same-commit-publication']),'reuse-prior-publication':len(groups['reuse-prior-publication'])},'method':f"systematic sample of up to {p['maxPerStratum']} completed push runs per stratum; successful job durations are uncensored observations"},'sameCommitPublication':summarize(same),'reusePriorPublication':summarize(reused),'combined':summarize(observations)}))`;
const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
const result = await tools.bash({
  command: "python3 -c " + quote(script) + " " + quote(payload),
  workdir: input.workdir,
  description: "Analyze base image publication timings",
  timeoutMs: 900000,
});
if (result.kind !== "foreground") throw new Error("Unexpected background result");
if (result.exitCode !== 0) throw new Error((result.stderr.text || result.stdout.text).slice(-2000));
return JSON.parse(result.stdout.text);
