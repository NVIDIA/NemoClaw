// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Runs as the gateway user: inspect the real unconfigured gateway, then load the
// package in a separate, test-only Hermes process. No provider calls or durable config.
export const HERMES_SWITCHYARD_PACKAGE_PROBE = String.raw`
pid="$(ps -eo pid=,user=,args= | awk '$2 == "gateway" && (index($0, "hermes gateway run") || index($0, "hermes.real gateway run")) { print $1; exit }')"
test -n "$pid"
/usr/bin/setpriv --reuid=gateway --regid=gateway --init-groups -- /opt/hermes/.venv/bin/python -I -X faulthandler - "$pid" <<'PY'
import hashlib
from importlib.metadata import version
import os
from pathlib import Path
import platform
import sys
from tempfile import TemporaryDirectory
import tomllib
import nemo_relay
from agent import relay_runtime

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
with TemporaryDirectory() as directory:
    config = Path(directory) / 'plugins.toml'
    config.write_text('''[[plugins.dynamic]]
manifest = "/opt/nemo-relay/plugins/switchyard/relay-plugin.toml"
[plugins.policy.overrides."nvidia.switchyard"]
attestation = "integrity_only"
[plugins.dynamic.config.switchyard_config]
schema_version = 1
[plugins.dynamic.config.switchyard_config.llm_clients.primary]
format = "openai_chat"
base_url = "http://127.0.0.1:1/v1"
forward_auth = false
[plugins.dynamic.config.switchyard_config.targets.default]
id = "fixture-model"
llm_client = "primary"
[plugins.dynamic.config.switchyard_config.routes.default]
id = "switchyard/fixture"
type = "passthrough"
target = "default"
''')
    os.environ[relay_runtime.RELAY_PLUGINS_CONFIG_ENV] = str(config)
    runtime = relay_runtime.RelayRuntime()
    try:
        assert runtime.managed_execution_enabled(), runtime._plugin_configuration_state
        assert str(library) in Path('/proc/self/maps').read_text()
        assert nemo_relay.plugin.report() is not None
    finally:
        runtime.shutdown()
        os.environ.pop(relay_runtime.RELAY_PLUGINS_CONFIG_ENV)
    assert nemo_relay.plugin.report() is None
# Record loader state without requiring immediate unmapping after shutdown.
print('Switchyard library mapped after shutdown:', str(library) in Path('/proc/self/maps').read_text(),
      file=sys.stderr, flush=True)
# The separate probe must not change the gateway's routing state.
assert library.name not in Path(f'/proc/{pid}/maps').read_text()
print('Switchyard package, disabled gateway, native activation, and cleanup verified', flush=True)
PY
`;
