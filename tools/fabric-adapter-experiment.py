# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Test a built Fabric harness image with real adapters and offline model fixtures."""
import argparse
import json
from pathlib import Path
import subprocess
import uuid

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--harness', required=True, choices=('openclaw', 'hermes', 'claude', 'codex', 'mini-swe-agent', 'nooa', 'nooa-bench', 'remote-agent', 'pi'))
parser.add_argument('--inference-api', choices=('openai-completions', 'openai-responses', 'anthropic-messages'), help='Exercise explicit API selection; OpenClaw also exercises route tuning')
parser.add_argument('--image', help='Explicit locally built image reference')
parser.add_argument('--pi-catalog', action='store_true', help='Exercise Pi catalog models instead of custom metadata')
args = parser.parse_args()
h = args.harness
out = ROOT / '.local' / f'fabric-{h}-{uuid.uuid4()}'
out.mkdir(parents=True)
certs = out / 'certs'
certs.mkdir()
def openssl(*args):
    subprocess.run(['openssl', *args], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(certs/'ca.key'),
        '-out', str(certs/'ca.crt'), '-days', '1', '-subj', '/CN=Fabric fixture CA',
        '-addext', 'keyUsage=critical,keyCertSign,cRLSign')
openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(certs/'fixture.key'),
        '-out', str(certs/'fixture.csr'), '-subj', '/CN=inference.local')
(certs/'extensions').write_text('subjectAltName=DNS:inference.local\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n')
openssl('x509', '-req', '-in', str(certs/'fixture.csr'), '-CA', str(certs/'ca.crt'),
        '-CAkey', str(certs/'ca.key'), '-CAcreateserial', '-out', str(certs/'fixture.crt'),
        '-days', '1', '-extfile', str(certs/'extensions'))
(certs/'fixture.key').chmod(0o644)
out.chmod(0o777)
image = subprocess.check_output(['docker','image','inspect',args.image or f'nc-prototype-fabric:{h}','--format','{{.Id}}'],text=True).strip()
name = 'nc-fixture-' + str(uuid.uuid4())
cmd = ['docker', 'run', '--name', name, '--rm', '--runtime=runc', '--network', 'none', *(['--user', '0', '--cap-add', 'NET_ADMIN'] if h == 'openclaw' else []),
       '--add-host', 'inference.local:' + ('8.8.4.4' if h == 'openclaw' else '127.0.0.1'),
       '-e', f'FABRIC_INFERENCE_API={args.inference_api or ""}', '-e', f'FABRIC_PI_CATALOG={int(args.pi_catalog)}', '-e', 'HOME=/sandbox', '-e', 'TMPDIR=/sandbox/tmp', '-e', 'ADAPTER_PYTHON=/opt/fabric/bin/python',
       '-e', 'PYTHONPATH=/opt/nemoclaw', '-e', 'OPENAI_API_KEY=fixture-only', '-e', 'SSL_CERT_FILE=/certs/ca.crt', '-e', 'REQUESTS_CA_BUNDLE=/certs/ca.crt',
       '-e', 'NODE_EXTRA_CA_CERTS=/certs/ca.crt', '-e', 'LITELLM_LOCAL_MODEL_COST_MAP=True',
       '-v', f'{certs}:/certs:ro', '-v', f'{out}:/evidence', '-v', f'{ROOT / "test/fabric_adapters.py"}:/test.py:ro',
       '--entrypoint', '/opt/fabric/bin/python', image, '/test.py', h]
print(out, flush=True)
with (out/'test.log').open('w') as log:
    try:
        result = subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT, timeout=600)
    finally:
        subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
(out/'image.json').write_text(json.dumps({'image': image, 'exit_code': result.returncode},indent=2)+'\n')
if result.returncode:
    print((out/'test.log').read_text()[-10000:])
raise SystemExit(result.returncode)
