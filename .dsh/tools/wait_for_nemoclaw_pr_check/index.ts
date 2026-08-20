// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* eslint-env node */
/* global input, tools */
/* oxlint-disable no-undef -- DSH injects input and tools into authored tool bodies. */

if (!Number.isInteger(input.number) || input.number <= 0)
  throw new Error("number must be a positive integer");
const name = input.name.trim();
if (!name) throw new Error("check name is required");
if (name.length > 500) throw new Error("check name is too long");
const repo = input.repo ?? "NVIDIA/NemoClaw";
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("repo must be owner/name");
if (input.expectedHeadSha && !/^[0-9a-f]{40}$/.test(input.expectedHeadSha))
  throw new Error("expectedHeadSha must be a lowercase 40-character commit SHA");
const timeoutMs = Math.max(1000, Math.min(1800000, input.timeoutMs ?? 600000));
const intervalMs = Math.max(1000, Math.min(120000, input.intervalMs ?? 15000));
const script = String.raw`import json, subprocess, sys, time
repo, number, name, expected, timeout_raw, interval_raw = sys.argv[1:]
deadline=time.monotonic()+int(timeout_raw)/1000; interval=int(interval_raw)/1000
def gh(args):
 p=subprocess.run(['gh',*args],capture_output=True,text=True,timeout=60)
 if p.returncode: raise RuntimeError(p.stderr[-1500:] or 'GitHub CLI command failed')
 return json.loads(p.stdout or 'null')
def cut(value,size): return value[:size] if isinstance(value,str) else None
def check_view(check):
 if not check: return None
 return {'id':int(check.get('id',0)),'status':cut(check.get('status'),100),'conclusion':cut(check.get('conclusion'),100),'detailsUrl':cut(check.get('details_url'),2000),'startedAt':cut(check.get('started_at'),100),'completedAt':cut(check.get('completed_at'),100),'app':cut((check.get('app') or {}).get('slug') or (check.get('app') or {}).get('name'),500)}
def head(): return gh(['pr','view',number,'--repo',repo,'--json','headRefOid,url,title'])
initial=head(); sha=str(initial.get('headRefOid') or '')
if len(sha)!=40 or any(c not in '0123456789abcdef' for c in sha): raise RuntimeError(f'PR #{number} returned an invalid commit SHA')
if expected and sha != expected: raise RuntimeError(f'PR #{number} commit changed: expected {expected}, found {sha}')
last=None
while time.monotonic() <= deadline:
 current=head(); current_sha=str(current.get('headRefOid') or '')
 if current_sha != sha:
  print(json.dumps({'done':False,'stale':True,'reason':None,'repo':repo,'number':int(number),'prUrl':cut(initial.get('url'),2000),'headSha':sha,'currentHeadSha':cut(current_sha,40),'name':name,'check':check_view(last)},separators=(',',':'))); raise SystemExit(0)
 payload=gh(['api',f'repos/{repo}/commits/{sha}/check-runs','-X','GET','-f',f'check_name={name}','-f','filter=latest','-f','per_page=100'])
 matches=sorted((c for c in (payload.get('check_runs') or []) if c.get('name')==name),key=lambda c:int(c.get('id',0)),reverse=True); last=matches[0] if matches else None
 if last and last.get('status')=='completed':
  print(json.dumps({'done':True,'stale':False,'reason':None,'repo':repo,'number':int(number),'prUrl':cut(initial.get('url'),2000),'headSha':sha,'currentHeadSha':None,'name':name,'check':check_view(last)},separators=(',',':'))); raise SystemExit(0)
 time.sleep(interval)
print(json.dumps({'done':False,'stale':False,'reason':'timeout','repo':repo,'number':int(number),'prUrl':cut(initial.get('url'),2000),'headSha':sha,'currentHeadSha':None,'name':name,'check':check_view(last)},separators=(',',':')))`;
const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
const args = [
  repo,
  String(input.number),
  name,
  input.expectedHeadSha ?? "",
  String(timeoutMs),
  String(intervalMs),
];
const command = "python3 -c " + quote(script) + " " + args.map(quote).join(" ");
const result = await tools.bash({
  command,
  workdir: input.workdir,
  description: "Wait for named pull request check",
  timeoutMs: Math.min(1865000, timeoutMs + 65000),
});
if (result.kind !== "foreground") throw new Error("Unexpected background result");
if (result.exitCode !== 0)
  throw new Error("GitHub pull request check read failed: " + result.stderr.text.slice(-1500));
return JSON.parse(result.stdout.text);
