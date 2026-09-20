# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Opt-in real Docker/OpenTofu resource qualification; no SDK coordinator or GPU."""
import os, pathlib, subprocess, tempfile, json, uuid, hashlib, time
bundle = pathlib.Path(os.environ['NEMOCLAW_TEST_BUNDLE']).resolve()
root = pathlib.Path(tempfile.mkdtemp(prefix='nemoclaw-cache-provider-'))
uid = str(uuid.uuid4()); name = 'nc-' + hashlib.sha256(uid.encode()).hexdigest()[:16] + '-inference-fixture'
engine = os.environ['NEMOCLAW_TEST_CACHE_ENGINE']
assert engine.startswith('unix:///')
version = json.loads((bundle/'manifest.json').read_text())['Version']
(root/'providers.tfrc').write_text('provider_installation { filesystem_mirror { path = '+json.dumps(str(bundle/'providers'))+' } }\n')
hcl = pathlib.Path(__file__).with_suffix('.tf').read_text().replace('@PROVIDER_VERSION@',version).replace('@FIXTURE_IMAGE@',os.environ['NEMOCLAW_TEST_CACHE_IMAGE']).replace('@ENGINE@', engine)
(root/'main.tf').write_text(hcl)
(root/'terraform.tfvars.json').write_text(json.dumps(dict(name=name,owner=uid)))
env = dict(os.environ,TF_CLI_CONFIG_FILE=str(root/'providers.tfrc'),TF_IN_AUTOMATION='1',CHECKPOINT_DISABLE='1')
def tofu(*args, success=True):
 p=subprocess.run([str(bundle/'libexec/tofu'),*args,'-no-color'],cwd=root,env=env,capture_output=True)
 with (root/'run.log').open('ab') as f: f.write(p.stdout+p.stderr)
 assert (p.returncode==0)==success, (args,p.stdout.decode(),p.stderr.decode())
 return p.stdout
def docker(*args):
 p=subprocess.run(['docker','--host',engine,*args],capture_output=True); assert p.returncode==0,p.stderr.decode(); return p.stdout
def key():
 for _ in range(100):
  p = subprocess.run(['docker','--host',engine,'exec',name,'python3','-c',"import hashlib;print(hashlib.sha256(open('/credentials/key','rb').read()).hexdigest())"],capture_output=True)
  if p.returncode == 0: return p.stdout
  time.sleep(0.1)
 raise AssertionError('fixture credential did not become ready')
def state(): return (root/'terraform.tfstate').read_bytes()
def apply(*args): tofu('apply','-auto-approve','-input=false',*args)
def noop():
 tofu('plan','-out=noop.plan','-input=false')
 p=json.loads(tofu('show','-json','noop.plan'))
 assert all(r['change']['actions']==['no-op'] for r in p['resource_changes'])
print(root, flush=True)
try:
 tofu('init','-input=false'); apply(); noop(); original=key()
 apply('-var=revision=replaced'); assert key()==original
 tofu('apply','-auto-approve','-input=false','-var=fail_start=true', success=False)
 apply(); assert key()==original; noop()
 apply('-var=enabled=false')
 assert subprocess.run(['docker','--host',engine,'inspect',name],capture_output=True).returncode != 0
 assert json.loads(docker('volume','inspect',name+'-auth'))[0]['Name'] == name+'-auth'
 apply(); assert key()==original; noop()
 docker('rm','-f',name); docker('volume','rm',name+'-data'); apply('-var=revision=replaced'); assert key()==original
 assert docker('exec',name,'cat','/data/model')==b'reconstructed'
 noop_state=state()
 # Missing bound credentials must block a pending compute replacement.
 docker('rm','-f',name); docker('volume','rm',name+'-auth')
 tofu('apply','-auto-approve','-input=false','-var=revision=must-not-create',success=False)
 assert state()==noop_state
 assert subprocess.run(['docker','--host',engine,'inspect',name],capture_output=True).returncode!=0
 # A same-named, same-labelled replacement is still not the bound credential volume.
 time.sleep(1.1)
 docker('volume','create','--label','nemoclaw.nvidia.com/uid='+uid,'--label','nemoclaw.nvidia.com/generation='+'a'*32,name+'-auth')
 tofu('apply','-auto-approve','-input=false','-var=revision=must-not-create',success=False)
 assert state()==noop_state
 assert subprocess.run(['docker','--host',engine,'inspect',name],capture_output=True).returncode!=0
 print('PASS: standalone HCL create/no-op/replacement/start-failure recovery/retained teardown/cache reconstruction; missing and substituted credentials block compute',flush=True)
finally:
 for kind,n in [('container',name),('volume',name+'-data'),('volume',name+'-auth')]:
  p=subprocess.run(['docker','--host',engine,kind,'inspect',n],capture_output=True)
  if p.returncode: continue
  v=json.loads(p.stdout)[0]; labels=v.get('Config',v).get('Labels',{})
  assert labels.get('nemoclaw.nvidia.com/uid')==uid
  subprocess.run(['docker','--host',engine,kind,'rm',*(['-f'] if kind=='container' else []),n],check=True,capture_output=True)
