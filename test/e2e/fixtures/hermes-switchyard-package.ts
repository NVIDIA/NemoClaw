// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { switchyardBindingFixture } from "../../helpers/hermes-switchyard.ts";
import { applyHermesManagedRoute } from "../../../src/lib/hermes-managed-route.ts";

import {
  type HermesSwitchyardRoutingIntent,
  createHermesSwitchyardRoutingIntent,
  HERMES_RELAY_PLUGINS_FILE,
  HERMES_RELAY_PLUGIN_STATE_FILE,
  HERMES_SWITCHYARD_DEPLOYMENT_FILE,
  serializeHermesSwitchyardRouting,
} from "../../../src/lib/hermes-switchyard-routing.ts";

const intent = createHermesSwitchyardRoutingIntent({
  efficient: { provider: "nvidia-prod", model: "fixture-efficient" },
  capable: { provider: "openai-api", model: "fixture-capable" },
});
const packageRouting = serializeHermesSwitchyardRouting(intent, switchyardBindingFixture(intent));
const routedGatewayConfig: Record<string, unknown> = {};
applyHermesManagedRoute(routedGatewayConfig, {
  model: intent.routeId,
  baseUrl: "https://integrate.api.nvidia.com/v1",
  upstreamProvider: "nvidia-prod",
  inferenceApi: "openai-completions",
});
const routedGatewayConfigBase64 = Buffer.from(JSON.stringify(routedGatewayConfig)).toString(
  "base64",
);
const relayPluginsBase64 = Buffer.from(packageRouting.relayPluginsToml, "utf8").toString("base64");
const relayPluginStateBase64 = Buffer.from(packageRouting.relayPluginStateJson, "utf8").toString(
  "base64",
);
const switchyardDeploymentBase64 = Buffer.from(
  packageRouting.switchyardDeploymentToml,
  "utf8",
).toString("base64");

export const HERMES_SWITCHYARD_LOCAL_UPSTREAM = String.raw`
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import socket
from threading import Thread

class LocalUpstream:
    def __init__(self, role, evidence=None):
        self.role = role
        self.calls = []
        self.evidence = evidence

    def __enter__(self):
        upstream = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                assert self.path == '/v1/chat/completions'
                length = int(self.headers.get('content-length', '0'))
                body = json.loads(self.rfile.read(length))
                upstream.calls.append(body)
                if upstream.evidence is not None:
                    key = 'OPENAI_API_KEY' if upstream.role in ('capable', 'judge') else 'NVIDIA_INFERENCE_API_KEY'
                    authorized = self.headers.get('authorization') == 'Bearer xapp-OPENSHELL-RESOLVE-ENV-' + key
                    if not authorized:
                        self.send_error(401)
                        return
                    with socket.socket() as connection:
                        gateway_listening = connection.connect_ex(('127.0.0.1', 18642)) == 0
                    with upstream.evidence.open('a', encoding='utf-8') as evidence:
                        evidence.write(json.dumps({
                            'role': upstream.role, 'model': body['model'],
                            'gatewayListening': gateway_listening,
                        }) + '\n')
                if upstream.role in ('capable', 'judge'):
                    content = json.dumps({
                        'crux': 'bounded fixture task',
                        'primary_rule': 'SUP-1',
                        'capability_boundary': 'supported',
                        'p_solve': 0.9,
                    }, separators=(',', ':'))
                else:
                    content = 'routed-efficient'
                response = json.dumps({
                    'id': 'chatcmpl-switchyard-probe',
                    'object': 'chat.completion',
                    'created': 1,
                    'model': body['model'],
                    'choices': [{
                        'index': 0,
                        'message': {'role': 'assistant', 'content': content},
                        'finish_reason': 'stop',
                    }],
                    'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2},
                }).encode('utf-8')
                self.send_response(200)
                self.send_header('content-type', 'application/json')
                self.send_header('content-length', str(len(response)))
                self.end_headers()
                self.wfile.write(response)

            def log_message(self, _format, *_args):
                pass

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    @property
    def base_url(self):
        return f'http://127.0.0.1:{self.server.server_port}/v1'

    def __exit__(self, _type, _value, _traceback):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        assert not self.thread.is_alive()
`;

// Runs as the gateway user: inspect the real unconfigured gateway, then load the
// package in a separate, test-only Hermes process. No external calls or durable config.
export const HERMES_SWITCHYARD_PACKAGE_PROBE = String.raw`
pid="$(ps -eo pid=,user=,args= | awk '$2 == "gateway" && (index($0, "hermes gateway run") || index($0, "hermes.real gateway run")) { print $1; exit }')"
test -n "$pid"
/usr/bin/setpriv --reuid=gateway --regid=gateway --init-groups -- /opt/hermes/.venv/bin/python -I -X faulthandler - "$pid" <<'PY'
import asyncio
import base64
import hashlib
import importlib.util
from importlib.metadata import version
import os
import platform
import sys
from tempfile import TemporaryDirectory
import tomllib
import nemo_relay
from agent import relay_runtime
${HERMES_SWITCHYARD_LOCAL_UPSTREAM}

capture = os.environ.get('NEMOCLAW_HERMES_CRASH_CAPTURE') == '1'
if capture:
    import resource
    Path('/tmp/nemoclaw-hermes-crash').mkdir(mode=0o700)
    assert resource.getrlimit(resource.RLIMIT_CORE) == (0, 268435456)
    resource.setrlimit(resource.RLIMIT_CORE, (268435456, 268435456))
    executable = os.readlink('/proc/self/exe')
    print('NEMOCLAW_HERMES_CRASH_PROCESS=' + json.dumps({
        'pid': os.getpid(), 'executable': executable,
        'python_sha256': hashlib.sha256(Path(executable).read_bytes()).hexdigest(),
        'python_version': platform.python_version(),
        'kernel': platform.release(), 'architecture': platform.machine(),
        'hermes_version': version('hermes-agent'), 'relay_version': version('nemo-relay'),
    }), flush=True)

def capture_maps(stage):
    if capture:
        # Mapping metadata only: never read mapped memory, environment or locals.
        print('NEMOCLAW_HERMES_MAPS_' + stage + '\n' + Path('/proc/self/maps').read_text(), flush=True)

capture_maps('initial')

RELAY_PLUGINS_SOURCE = base64.b64decode('${relayPluginsBase64}').decode('utf-8')
RELAY_PLUGIN_STATE_SOURCE = base64.b64decode('${relayPluginStateBase64}').decode('utf-8')
SWITCHYARD_DEPLOYMENT_SOURCE = base64.b64decode('${switchyardDeploymentBase64}').decode('utf-8')
SWITCHYARD_DEPLOYMENT_PATH = '${HERMES_SWITCHYARD_DEPLOYMENT_FILE}'

bundle = Path('/opt/nemo-relay/plugins/switchyard')
library = bundle / 'libswitchyard_nemo_relay_plugin.so'
expected_digest = {
    'x86_64': '9b53b057eae53bd1893282e958153d6f353d44405e1b86ab6966d6033cfc102d',
    'aarch64': '07f7b9c8051dede541d7d0dfc73bf10a702c33bf8c93f1e222ee2e1d6b471897',
}[platform.machine()]
assert hashlib.sha256(library.read_bytes()).hexdigest() == expected_digest
if capture:
    print('NEMOCLAW_HERMES_SWITCHYARD_SHA256=' + expected_digest, flush=True)
manifest = tomllib.loads((bundle / 'relay-plugin.toml').read_text())
assert manifest['defaults']['enabled'] is False
assert manifest['integrity']['sha256'] == 'sha256:' + expected_digest
assert {str(p.relative_to(bundle)) for p in bundle.rglob('*') if p.is_file()} == {
    'relay-plugin.toml', 'config.schema.json', library.name,
    'LICENSE', 'NOTICE', 'ATTRIBUTIONS-Rust.md', 'THIRD_PARTY_NOTICES.md',
    'notices/protocol/LICENSE', 'notices/protocol/NOTICE',
    'notices/switchyard-translation/LICENSE', 'notices/switchyard-translation/NOTICE',
}
qualifier_script = Path('/opt/nemoclaw-hermes-config/qualify-switchyard-judge.py')
for entry in [*bundle.parents, bundle, *bundle.rglob('*'),
              *qualifier_script.parents, qualifier_script]:
    assert not entry.is_symlink(), entry
    assert entry.stat().st_uid == 0, entry
    assert entry.stat().st_mode & 0o022 == 0, entry
    assert not os.access(entry, os.W_OK), entry
assert not Path('/switchyard.tar.gz').exists()
assert not Path('/install-switchyard.py').exists()
assert version('hermes-agent') == '0.21.3'
assert version('nemo-relay') == '0.8.3'
# The supervised gateway is already healthy. Packaging must not activate routing.
pid = int(sys.argv[1])
assert library.name not in Path(f'/proc/{pid}/maps').read_text()
assert relay_runtime.RELAY_PLUGINS_CONFIG_ENV.encode() not in {
    entry.partition(b'=')[0] for entry in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0')
}
assert not os.environ.get(relay_runtime.RELAY_PLUGINS_CONFIG_ENV)
runtime = relay_runtime.RelayRuntime()
try:
    assert not runtime.managed_execution_enabled()
    assert nemo_relay.plugin.report() is None
finally:
    runtime.shutdown()
with TemporaryDirectory() as directory, LocalUpstream('efficient') as efficient, LocalUpstream('capable') as capable:
    config = Path(directory) / 'plugins.toml'
    deployment = Path(directory) / 'switchyard.toml'
    assert RELAY_PLUGINS_SOURCE.count(SWITCHYARD_DEPLOYMENT_PATH) == 1
    config.write_text(
        RELAY_PLUGINS_SOURCE.replace(SWITCHYARD_DEPLOYMENT_PATH, str(deployment)),
        encoding='utf-8',
    )
    deployment_source = SWITCHYARD_DEPLOYMENT_SOURCE
    endpoints = {
        'https://integrate.api.nvidia.com/v1': efficient.base_url,
        'https://api.openai.com/v1': capable.base_url,
    }
    for production, local in endpoints.items():
        assert deployment_source.count(production) == 1
        deployment_source = deployment_source.replace(production, local)
    deployment.write_text(deployment_source, encoding='utf-8')
    state = Path(directory) / '.dynamic-plugins.json'
    state.write_text(RELAY_PLUGIN_STATE_SOURCE, encoding='utf-8')
    state_before = state.read_bytes()
    lifecycle = json.loads(state_before)
    assert lifecycle['schema_version'] == 1
    assert len(lifecycle['records']) == 1
    record = lifecycle['records'][0]
    assert record['metadata'] == {
        'id': 'nvidia.switchyard',
        'kind': 'rust_dynamic',
        'generation': 1,
    }
    assert record['spec'] == {'present': True, 'enabled': True}
    assert record['source']['manifest_ref'] == str(bundle / 'relay-plugin.toml')
    assert record['load']['rust_dynamic'] == {
        'library': library.name,
        'symbol': 'nemo_relay_register_plugin',
    }
    dynamic_plugins = nemo_relay.plugin.load_dynamic_plugin_activation_specs(config)
    assert len(dynamic_plugins) == 1
    assert dynamic_plugins[0].plugin_id == 'nvidia.switchyard'
    # Hermes 0.21.3 treats this explicit config as activation consent. Its
    # compatibility host reads the config and leaves Relay lifecycle state untouched.
    environment = {
        relay_runtime.RELAY_PLUGINS_CONFIG_ENV: str(config),
        'NVIDIA_INFERENCE_API_KEY': 'switchyard-probe-key',
        'OPENAI_API_KEY': 'switchyard-probe-key',
    }
    previous_environment = {name: os.environ.get(name) for name in environment}
    os.environ.update(environment)
    runtime = None
    try:
        runtime = relay_runtime.RelayRuntime()
        assert runtime.managed_execution_enabled(), runtime._plugin_configuration_state
        assert str(library) in Path('/proc/self/maps').read_text()
        assert nemo_relay.plugin.report() is not None
        assert state.read_bytes() == state_before

        async def reject_passthrough(_request):
            raise AssertionError('Switchyard route passed through to the original provider')

        async def execute_switchyard_route():
            return await nemo_relay.llm.execute(
                'openai.chat_completions',
                nemo_relay.LLMRequest({}, {
                    'model': 'switchyard',
                    'messages': [{'role': 'user', 'content': 'Use the efficient fixture model.'}],
                }),
                reject_passthrough,
            )

        result = asyncio.run(execute_switchyard_route())
        assert result['choices'][0]['message']['content'] == 'routed-efficient'
        # Exercise the shipped qualification consumer against native marks and accounting.
        # The local endpoints substitute only fixture transport, not the classifier or Relay API.
        runtime.shutdown()
        runtime = None
        spec = importlib.util.spec_from_file_location(
            'judge_qualification', '/opt/nemoclaw-hermes-config/qualify-switchyard-judge.py')
        qualification = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(qualification)
        qualification.PLUGINS_PATH = str(config)
        qualification.qualify(
            ('fixture-capable', 'fixture-efficient', 'fixture-capable'),
            relay=nemo_relay, runtime_factory=relay_runtime.RelayRuntime)
        assert len(capable.calls) == 2
        assert capable.calls[0]['model'] == 'fixture-capable'
        assert capable.calls[0]['response_format']['type'] == 'json_schema'
        assert len(efficient.calls) == 2
        assert efficient.calls[0]['model'] == 'fixture-efficient'
        assert state.read_bytes() == state_before
        capture_maps('before_shutdown')
    finally:
        if runtime is not None:
            runtime.shutdown()
        for name, value in previous_environment.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
    assert nemo_relay.plugin.report() is None
    capture_maps('after_shutdown')
# The separate probe must not change the gateway's routing state.
assert library.name not in Path(f'/proc/{pid}/maps').read_text()
print('Switchyard package, disabled gateway, adaptive route, native activation, and cleanup verified')
PY
`;

const routedUpstreamBase64 = Buffer.from(
  HERMES_SWITCHYARD_LOCAL_UPSTREAM +
    String.raw`
from threading import Event
with LocalUpstream('efficient', Path('/tmp/switchyard-efficient.jsonl')) as efficient, \
     LocalUpstream('capable', Path('/tmp/switchyard-capable.jsonl')) as capable, \
     LocalUpstream('judge', Path('/tmp/switchyard-judge.jsonl')) as judge:
    print(json.dumps({'efficient': efficient.base_url, 'capable': capable.base_url,
                      'judge': judge.base_url}), flush=True)
    Event().wait()
`,
  "utf8",
).toString("base64");

export const HERMES_SWITCHYARD_LOCALIZE_DEPLOYMENT = String.raw`
import tomllib

def localize_deployment(deployment, endpoints):
    clients = tomllib.loads(deployment)['llm_clients']
    for role, client in clients.items():
        original = ('https://integrate.api.nvidia.com/v1' if role == 'efficient'
                    else 'https://api.openai.com/v1')
        if client['base_url'] != original:
            raise ValueError('Unexpected Switchyard fixture endpoint')
        start = deployment.index('[llm_clients.' + role + ']')
        end = deployment.find('\n[', start + 1)
        end = len(deployment) if end == -1 else end
        section = deployment[start:end]
        source = 'base_url = "' + original + '"'
        if section.count(source) != 1:
            raise ValueError('Ambiguous Switchyard fixture endpoint')
        section = section.replace(source, 'base_url = "' + endpoints[role] + '"')
        deployment = deployment[:start] + section + deployment[end:]
    return deployment
`;

// Fresh-image provisioning, matching agents/hermes/Dockerfile. Runtime updates
// must still use the production transaction and startup-owner checks.
export const HERMES_SWITCHYARD_PROVISION_CONFIG_HASHES = String.raw`
import hashlib
from pathlib import Path

def provision_config_hashes(hermes_dir, strict_hash):
    hash_paths = (hermes_dir / 'config.yaml', hermes_dir / '.env')
    hash_text = ''.join(
        hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + str(path) + '\n'
        for path in hash_paths)
    # Update the compatibility anchor first and retain both files' metadata.
    (hermes_dir / '.config-hash').write_text(hash_text)
    strict_hash.write_text(hash_text)
`;

// Only transport and credentials are synthetic. The entrypoint, privilege drop,
// production routing paths, qualifier main(), and native router remain unchanged.
export function hermesSwitchyardRoutedFixture(
  judgeMode: HermesSwitchyardRoutingIntent["judge"]["mode"],
): { bootstrap: string; evidence: string } {
  const routedIntent = createHermesSwitchyardRoutingIntent({
    efficient: intent.efficient,
    capable: intent.capable,
    ...(judgeMode === "dedicated"
      ? { judge: { provider: "openai-api", model: "fixture-judge" } }
      : {}),
  });
  const routedDeploymentBase64 = Buffer.from(
    serializeHermesSwitchyardRouting(routedIntent, switchyardBindingFixture(routedIntent))
      .switchyardDeploymentToml,
    "utf8",
  ).toString("base64");
  const selectedRoles = [judgeMode === "dedicated" ? "judge" : "capable", "efficient"];
  const bootstrap = String.raw`
set -euo pipefail
exec /opt/hermes/.venv/bin/python -I - <<'PY'
import base64
import json
import os
from pathlib import Path
import selectors
import subprocess
import yaml
${HERMES_SWITCHYARD_PROVISION_CONFIG_HASHES}
${HERMES_SWITCHYARD_LOCALIZE_DEPLOYMENT}

upstream = subprocess.Popen([
    '/usr/bin/setpriv', '--reuid=gateway', '--regid=gateway', '--init-groups', '--',
    '/opt/hermes/.venv/bin/python', '-I', '-c',
    base64.b64decode('${routedUpstreamBase64}').decode('utf-8'),
], stdout=subprocess.PIPE)
try:
    with selectors.DefaultSelector() as selector:
        selector.register(upstream.stdout, selectors.EVENT_READ)
        if not selector.select(timeout=10):
            raise RuntimeError('Local Switchyard fixtures did not start')
        endpoints = json.loads(upstream.stdout.readline(4096))
    deployment = localize_deployment(
        base64.b64decode('${routedDeploymentBase64}').decode('utf-8'), endpoints)
    directory = Path('${HERMES_RELAY_PLUGINS_FILE}').parent
    directory.mkdir(exist_ok=True)
    directory.chmod(0o755)
    os.chown(directory, 0, 0)
    for path, content in (
        ('${HERMES_RELAY_PLUGINS_FILE}', base64.b64decode('${relayPluginsBase64}').decode('utf-8')),
        ('${HERMES_RELAY_PLUGIN_STATE_FILE}', base64.b64decode('${relayPluginStateBase64}').decode('utf-8')),
        ('${HERMES_SWITCHYARD_DEPLOYMENT_FILE}', deployment),
    ):
        target = Path(path)
        target.write_text(content, encoding='utf-8')
        os.chown(target, 0, 0)
        target.chmod(0o444)
    # Provision the generated route and its policy before startup, as the image
    # builder does. Keep both integrity anchors consistent; do not bypass the guard.
    route = json.loads(base64.b64decode('${routedGatewayConfigBase64}'))
    config_path = Path('/sandbox/.hermes/config.yaml')
    config = yaml.safe_load(config_path.read_text())
    config.update(route)
    config_path.write_text(yaml.safe_dump(config, sort_keys=False))
    policy_path = directory / 'hermes-managed-policy.json'
    policy = json.loads(policy_path.read_text())
    policy['config'].update(route)
    policy_path.write_text(json.dumps(policy))
    provision_config_hashes(config_path.parent, Path('/etc/nemoclaw/hermes.config-hash'))
    environment = dict(os.environ, HERMES_NEMO_RELAY_PLUGINS_TOML='${HERMES_RELAY_PLUGINS_FILE}')
    for key in ('NVIDIA_INFERENCE_API_KEY', 'OPENAI_API_KEY'):
        environment[key] = 'xapp-OPENSHELL-RESOLVE-ENV-' + key
    os.execve('/usr/local/bin/nemoclaw-start', ['/usr/local/bin/nemoclaw-start'], environment)
finally:
    upstream.terminate()
    upstream.wait(timeout=5)
PY
`;

  const evidence = String.raw`
pid="$(ps -eo pid=,user=,args= | awk '$2 == "gateway" && (index($0, "hermes gateway run") || index($0, "hermes.real gateway run")) { print $1; exit }')"
test -n "$pid"
/usr/bin/setpriv --reuid=gateway --regid=gateway --init-groups -- /opt/hermes/.venv/bin/python -I - "$pid" <<'PY'
import json
import os
from pathlib import Path
import stat
import sys
import yaml

assert yaml.safe_load(Path('/sandbox/.hermes/config.yaml').read_text())['model']['default'] == 'switchyard'
# Only the real entrypoint can have issued these calls: this scenario never invokes
# the qualifier itself. The selected judge and answer must precede the gateway listener.
for role in ('capable', 'efficient', 'judge'):
    evidence_path = Path('/tmp/switchyard-' + role + '.jsonl')
    calls = ([json.loads(line) for line in evidence_path.read_text().splitlines()]
             if evidence_path.exists() else [])
    assert calls == ([{'role': role, 'model': 'fixture-' + role, 'gatewayListening': False}]
                     if role in ${JSON.stringify(selectedRoles)} else []), calls
for name in ('hermes-relay-plugins.toml', 'hermes-switchyard-v1.toml', '.dynamic-plugins.json'):
    path = Path('/usr/local/share/nemoclaw') / name
    assert path.stat().st_uid == 0 and stat.S_IMODE(path.stat().st_mode) == 0o444
    assert not os.access(path, os.W_OK)
pid = int(sys.argv[1])
# Hermes can initialize its agent runtime lazily; readiness must retain activation
# consent, not require the gateway to load the library before its first agent turn.
assert b'HERMES_NEMO_RELAY_PLUGINS_TOML=${HERMES_RELAY_PLUGINS_FILE}' in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0')
print(json.dumps({'qualificationBeforeGateway': True, 'routedGatewayConfigured': True}))
PY
`;
  return { bootstrap, evidence };
}
