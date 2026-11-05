// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

import {
  createHermesSwitchyardRoutingIntent,
  HERMES_SWITCHYARD_DEPLOYMENT_FILE,
  serializeHermesSwitchyardRouting,
} from "../../../src/lib/hermes-switchyard-routing.ts";

const packageRouting = serializeHermesSwitchyardRouting(
  createHermesSwitchyardRoutingIntent({
    efficient: { provider: "nvidia-prod", model: "fixture-efficient" },
    capable: { provider: "openai-api", model: "fixture-capable" },
  }),
);
const relayPluginsBase64 = Buffer.from(packageRouting.relayPluginsToml, "utf8").toString("base64");
const relayPluginStateBase64 = Buffer.from(packageRouting.relayPluginStateJson, "utf8").toString(
  "base64",
);
const switchyardDeploymentBase64 = Buffer.from(
  packageRouting.switchyardDeploymentToml,
  "utf8",
).toString("base64");

// Runs as the gateway user: inspect the real unconfigured gateway, then load the
// package in a separate, test-only Hermes process. No external calls or durable config.
export const HERMES_SWITCHYARD_PACKAGE_PROBE = String.raw`
pid="$(ps -eo pid=,user=,args= | awk '$2 == "gateway" && (index($0, "hermes gateway run") || index($0, "hermes.real gateway run")) { print $1; exit }')"
test -n "$pid"
/usr/bin/setpriv --reuid=gateway --regid=gateway --init-groups -- /opt/hermes/.venv/bin/python -I - "$pid" <<'PY'
import asyncio
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib.metadata import version
import json
import os
from pathlib import Path
import platform
import sys
from tempfile import TemporaryDirectory
from threading import Thread
import tomllib
import nemo_relay
from agent import relay_runtime

RELAY_PLUGINS_SOURCE = base64.b64decode('${relayPluginsBase64}').decode('utf-8')
RELAY_PLUGIN_STATE_SOURCE = base64.b64decode('${relayPluginStateBase64}').decode('utf-8')
SWITCHYARD_DEPLOYMENT_SOURCE = base64.b64decode('${switchyardDeploymentBase64}').decode('utf-8')
SWITCHYARD_DEPLOYMENT_PATH = '${HERMES_SWITCHYARD_DEPLOYMENT_FILE}'


class LocalUpstream:
    def __init__(self, role):
        self.role = role
        self.calls = []

    def __enter__(self):
        upstream = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                assert self.path == '/v1/chat/completions'
                length = int(self.headers.get('content-length', '0'))
                body = json.loads(self.rfile.read(length))
                upstream.calls.append(body)
                if upstream.role == 'capable':
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

bundle = Path('/opt/nemo-relay/plugins/switchyard')
library = bundle / 'libswitchyard_nemo_relay_plugin.so'
expected_digest = {
    'x86_64': '9b53b057eae53bd1893282e958153d6f353d44405e1b86ab6966d6033cfc102d',
    'aarch64': '07f7b9c8051dede541d7d0dfc73bf10a702c33bf8c93f1e222ee2e1d6b471897',
}[platform.machine()]
assert hashlib.sha256(library.read_bytes()).hexdigest() == expected_digest
manifest = tomllib.loads((bundle / 'relay-plugin.toml').read_text())
assert manifest['defaults']['enabled'] is False
assert manifest['integrity']['sha256'] == 'sha256:' + expected_digest
assert {str(p.relative_to(bundle)) for p in bundle.rglob('*') if p.is_file()} == {
    'relay-plugin.toml', 'config.schema.json', library.name,
    'LICENSE', 'NOTICE', 'ATTRIBUTIONS-Rust.md', 'THIRD_PARTY_NOTICES.md',
    'notices/protocol/LICENSE', 'notices/protocol/NOTICE',
    'notices/switchyard-translation/LICENSE', 'notices/switchyard-translation/NOTICE',
}
for entry in [*bundle.parents, bundle, *bundle.rglob('*')]:
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
        assert len(capable.calls) == 1
        assert capable.calls[0]['model'] == 'fixture-capable'
        assert capable.calls[0]['response_format']['type'] == 'json_schema'
        assert len(efficient.calls) == 1
        assert efficient.calls[0]['model'] == 'fixture-efficient'
        assert state.read_bytes() == state_before
    finally:
        if runtime is not None:
            runtime.shutdown()
        for name, value in previous_environment.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
    assert nemo_relay.plugin.report() is None
# The separate probe must not change the gateway's routing state.
assert library.name not in Path(f'/proc/{pid}/maps').read_text()
print('Switchyard package, disabled gateway, adaptive route, native activation, and cleanup verified')
PY
`;
