// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import {
  createHermesSwitchyardRoutingIntent,
  serializeHermesSwitchyardRouting,
  HERMES_SWITCHYARD_DEPLOYMENT_FILE,
  type HermesSwitchyardRoutingIntent,
} from "../../../src/lib/hermes-switchyard-routing.ts";
import { switchyardBindingFixture } from "../../helpers/hermes-switchyard.ts";
import {
  HERMES_SWITCHYARD_LOCALIZE_DEPLOYMENT,
  HERMES_SWITCHYARD_LOCAL_UPSTREAM,
} from "./hermes-switchyard-package.ts";

// Every child owns one native runtime and its loopback providers. Parallel cases
// keep qualification bounded without shortening the production client deadline.
const worker = String.raw`
import asyncio
import base64
from contextlib import ExitStack
import json
import os
from pathlib import Path
import signal
import sys
from tempfile import TemporaryDirectory
import time
import uuid
import nemo_relay
from agent import relay_runtime
${HERMES_SWITCHYARD_LOCAL_UPSTREAM}
${HERMES_SWITCHYARD_LOCALIZE_DEPLOYMENT}

judge_mode, target, fault, encoded_deployment, encoded_plugins, encoded_state = sys.argv[1:]
judge = 'judge' if judge_mode == 'dedicated' else 'capable'
failed_role = judge if target == 'judge' else target
phase = 'judge' if target == 'judge' else 'answer'
# A watchdog exit is a failed test, never evidence of a native timeout.
signal.alarm(150)
with TemporaryDirectory() as directory, ExitStack() as resources:
    directory = Path(directory)
    providers = {
        role: resources.enter_context(LocalUpstream(
            role, directory / (role + '.jsonl'),
            fault=fault if role == failed_role else None, phase=phase,
            prefix_delay=20 if fault == 'stall' else 0,
            p_solve=0.1 if target == 'capable' else 0.9))
        for role in ('efficient', 'capable', 'judge')
    }
    deployment = localize_deployment(base64.b64decode(encoded_deployment).decode(),
                                     {role: provider.base_url for role, provider in providers.items()})
    parsed = tomllib.loads(deployment)
    for client in parsed['llm_clients'].values():
        assert client['timeout_ms'] == 120000 and client['max_retries'] == 0
    deployment_path = directory / 'switchyard.toml'
    deployment_path.write_text(deployment)
    plugins = directory / 'plugins.toml'
    plugins.write_text(base64.b64decode(encoded_plugins).decode().replace(
        '${HERMES_SWITCHYARD_DEPLOYMENT_FILE}', str(deployment_path)))
    (directory / '.dynamic-plugins.json').write_bytes(base64.b64decode(encoded_state))
    os.environ[relay_runtime.RELAY_PLUGINS_CONFIG_ENV] = str(plugins)
    for key in ('OPENAI_API_KEY', 'NVIDIA_INFERENCE_API_KEY'):
        os.environ[key] = 'xapp-OPENSHELL-RESOLVE-ENV-' + key
    runtime = relay_runtime.RelayRuntime()
    try:
        assert runtime.managed_execution_enabled()
        chunks = []
        bypassed = []

        async def reject_passthrough(_request):
            bypassed.append(True)
            raise AssertionError('native route bypassed')

        async def reject_stream_passthrough(_request):
            bypassed.append(True)
            raise AssertionError('native stream route bypassed')
            yield None

        async def run():
            request = nemo_relay.LLMRequest({'x-switchyard-session-id': str(uuid.uuid4())}, {
                'model': 'switchyard',
                'messages': [{'role': 'user', 'content': 'Bound this fixture call.'}],
            })
            if target == 'judge':
                await nemo_relay.llm.execute('openai.chat_completions', request, reject_passthrough)
            else:
                stream = await nemo_relay.llm.stream_execute(
                    'openai.chat_completions', request, reject_stream_passthrough,
                    chunks.append, lambda: {'choices': []})
                try:
                    async for _chunk in stream:
                        pass
                finally:
                    await stream.aclose()

        failed = False
        try:
            asyncio.run(run())
        except Exception:
            failed = True
        finished = time.monotonic()
        assert not bypassed, 'native routing was bypassed'
        assert failed, 'native call unexpectedly succeeded'
        provider = providers[failed_role]
        assert len(provider.faults) == 1, 'failed physical client retried or was never reached'
        expected_calls = {role: 0 for role in providers}
        expected_calls[judge] += 1
        if target != 'judge':
            expected_calls[target] += 1
        assert {role: len(p.calls) for role, p in providers.items()} == expected_calls
        # Only authenticated calls reach the fault branch and its evidence file.
        assert (directory / (failed_role + '.jsonl')).is_file()
        elapsed = finished - provider.faults[0]['started']
        assert elapsed <= 125, ('native call exceeded its deadline scheduling tolerance', elapsed)
        if fault == 'stall':
            observation = provider.faults[0]
            assert observation.get('prefixSent') is True
            assert elapsed >= 119, ('native call failed before its deadline', elapsed)
            if target != 'judge':
                assert observation['stream'] is True
                choices = [choice for chunk in chunks for choice in chunk.get('choices', [])]
                assert any(choice.get('delta', {}).get('content') == 'partial' for choice in choices)
                assert not any(choice.get('finish_reason') == 'stop' for choice in choices)
        print(json.dumps({'judgeMode': judge_mode, 'target': target, 'fault': fault,
                          'attempts': len(provider.faults), 'nativeFailure': failed}), flush=True)
    finally:
        runtime.shutdown()
    assert nemo_relay.plugin.report() is None
signal.alarm(0)
`;

export function hermesSwitchyardBoundsProbe(
  judgeMode: HermesSwitchyardRoutingIntent["judge"]["mode"],
): string {
  const intent = createHermesSwitchyardRoutingIntent({
    efficient: { provider: "nvidia-prod", model: "fixture-efficient" },
    capable: { provider: "openai-api", model: "fixture-capable" },
    ...(judgeMode === "dedicated"
      ? { judge: { provider: "openai-api", model: "fixture-judge" } }
      : {}),
  });
  const routing = serializeHermesSwitchyardRouting(intent, switchyardBindingFixture(intent));
  return String.raw`
/usr/bin/setpriv --reuid=gateway --regid=gateway --init-groups -- /opt/hermes/.venv/bin/python -I - <<'PY'
import base64
from concurrent.futures import ThreadPoolExecutor
import json
import subprocess
import sys

worker = base64.b64decode('${Buffer.from(worker).toString("base64")}').decode()
cases = [(target, fault) for target in ('efficient', 'capable', 'judge')
         for fault in ('retryable', 'stall')]
def check(case):
    target, fault = case
    result = subprocess.run([sys.executable, '-I', '-c', worker, '${judgeMode}', target, fault,
                             '${Buffer.from(routing.switchyardDeploymentToml).toString("base64")}',
                             '${Buffer.from(routing.relayPluginsToml).toString("base64")}',
                             '${Buffer.from(routing.relayPluginStateJson).toString("base64")}'],
                            capture_output=True, text=True, timeout=155)
    if result.returncode != 0:
        # Child input contains only synthetic credentials and loopback addresses.
        raise AssertionError((case, result.returncode, result.stderr[-4096:]))
    return json.loads(result.stdout)
with ThreadPoolExecutor(max_workers=6) as pool:
    for result in pool.map(check, cases):
        print(json.dumps(result), flush=True)
PY
`;
}
