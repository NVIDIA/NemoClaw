// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

const repo = input.repo ?? "NVIDIA/NemoClaw";
const artifactName = input.artifactName ?? "cli-vitest-results";
const limit = input.limit ?? 10;
const top = input.top ?? 15;
const ratio = input.minSampleRatio ?? 0.7;
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
if (!/^[A-Za-z0-9_.-]{1,100}$/.test(artifactName))
  throw new Error("artifactName contains unsupported characters");
if (!Number.isInteger(limit) || limit < 2 || limit > 20)
  throw new Error("limit must be an integer from 2 through 20");
if (!Number.isInteger(top) || top < 1 || top > 50)
  throw new Error("top must be an integer from 1 through 50");
if (!Number.isFinite(ratio) || ratio < 0.5 || ratio > 1)
  throw new Error("minSampleRatio must be from 0.5 through 1");
const payload = JSON.stringify({ repo, artifactName, limit, top, ratio });
const script = String.raw`import json,subprocess,sys,tempfile,shutil,os,glob,statistics,math
p=json.loads(sys.argv[1]); access=('authentication','authorization','forbidden','not authorized','http 401','http 403','resource not accessible','sso')
def run(args,timeout=120):
 r=subprocess.run(args,capture_output=True,text=True,timeout=timeout)
 detail=(r.stderr+'\n'+r.stdout).lower()
 if r.returncode and any(x in detail for x in access):raise RuntimeError('GitHub access failed; correct authentication or authorization before retrying.\n'+r.stderr[-1500:])
 return r
per=min(100,max(30,p['limit']*3)); endpoint=f"repos/{p['repo']}/actions/artifacts?name={p['artifactName']}&per_page={per}"
r=run(['gh','api',endpoint,'--jq','{artifacts:[.artifacts[]|{id,createdAt:.created_at,expired,size:.size_in_bytes,runId:.workflow_run.id,headSha:.workflow_run.head_sha}]}',],60)
if r.returncode:raise RuntimeError('Could not list artifacts.\n'+r.stderr[-1500:])
seen=set(); artifacts=[]
for a in json.loads(r.stdout)['artifacts']:
 rid=int(a.get('runId') or 0)
 if not rid or a.get('expired') or rid in seen:continue
 seen.add(rid); artifacts.append({'artifactId':int(a['id']),'runId':rid,'createdAt':str(a['createdAt']),'headSha':str(a['headSha']),'size':int(a['size'])})
 if len(artifacts)>=p['limit']:break
if len(artifacts)<2:raise RuntimeError(f"Found {len(artifacts)} retained reports; at least 2 are required")
root=tempfile.mkdtemp(prefix='nemoclaw-cli-timings-'); reports=[]; failures=[]
try:
 for a in artifacts:
  d=os.path.join(root,str(a['runId'])); os.makedirs(d)
  r=run(['gh','run','download',str(a['runId']),'--repo',p['repo'],'--name',p['artifactName'],'--dir',d])
  if r.returncode:failures.append({'runId':a['runId'],'detail':(r.stderr or r.stdout)[-1000:]});continue
  paths=glob.glob(d+'/**/vitest-results.json',recursive=True)
  if len(paths)!=1:failures.append({'runId':a['runId'],'detail':f'Expected one vitest-results.json file, found {len(paths)}'});continue
  reports.append((a,paths[0]))
 if len(reports)<2:raise RuntimeError(f"Downloaded {len(reports)} usable reports; at least 2 are required")
 reports.sort(key=lambda x:x[0]['createdAt'],reverse=True); tests={}; files={}; runs=[]; repo_name=p['repo'].split('/')[1]; marker='/'+repo_name+'/'+repo_name+'/'
 def clean(v):
  i=v.rfind(marker);return v[i+len(marker):] if i>=0 else v
 for meta,path in reports:
  data=json.load(open(path)); runs.append({'runId':meta['runId'],'createdAt':meta['createdAt'],'headSha':meta['headSha'],'totalTests':int(data.get('numTotalTests') or 0),'testFiles':len(data.get('testResults') or [])})
  for suite in data.get('testResults') or []:
   file=clean(str(suite.get('name') or '')); wall=max(0,float(suite.get('endTime') or 0)-float(suite.get('startTime') or 0));files.setdefault(file,[]).append(wall)
   for test in suite.get('assertionResults') or []:
    duration=test.get('duration')
    if not isinstance(duration,(int,float)) or not math.isfinite(duration):continue
    name=str(test.get('fullName') or ' '.join((test.get('ancestorTitles') or [])+[test.get('title','')]));tests.setdefault((file,name),[]).append(float(duration))
 def quant(v,q):
  a=sorted(v);pos=(len(a)-1)*q;lo=int(pos);hi=math.ceil(pos);return a[lo] if lo==hi else a[lo]+(a[hi]-a[lo])*(pos-lo)
 rnd=lambda v:round(v,1); minimum=max(2,math.ceil(len(reports)*p['ratio']))
 slow_tests=[{'file':k[0],'name':k[1],'samples':len(v),'medianMs':rnd(quant(v,.5)),'p90Ms':rnd(quant(v,.9)),'minMs':rnd(min(v)),'maxMs':rnd(max(v))} for k,v in tests.items() if len(v)>=minimum]
 slow_files=[{'file':k,'samples':len(v),'medianWallMs':rnd(quant(v,.5)),'p90WallMs':rnd(quant(v,.9)),'maxWallMs':rnd(max(v))} for k,v in files.items() if len(v)>=minimum]
 slow_tests.sort(key=lambda x:x['medianMs'],reverse=True);slow_files.sort(key=lambda x:x['medianWallMs'],reverse=True)
 print(json.dumps({'repo':p['repo'],'artifactName':p['artifactName'],'reportsRequested':p['limit'],'reportsFound':len(artifacts),'reportsAnalyzed':len(reports),'downloadFailures':failures[:10],'minSamples':minimum,'runs':runs,'slowTests':slow_tests[:p['top']],'slowFiles':slow_files[:p['top']]}))
finally:shutil.rmtree(root,ignore_errors=True)`;
const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
const result = await tools.bash({
  command: "python3 -c " + quote(script) + " " + quote(payload),
  workdir: input.workdir,
  description: "Analyze recent CLI test timings",
  timeoutMs: 900000,
});
if (result.kind !== "foreground") throw new Error("Unexpected background result");
if (result.exitCode !== 0) throw new Error((result.stderr.text || result.stdout.text).slice(-2000));
return JSON.parse(result.stdout.text);
