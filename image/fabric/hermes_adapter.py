# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Fabric owns a native Hermes API process; dashboard sessions remain separate."""
import asyncio
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import sys
import urllib.request
from interfaces import token

ROOT = Path('/sandbox/.hermes')
PORT = 8642
MODES = {'openai-completions': 'chat_completions', 'openai-responses': 'codex_responses',
         'anthropic-messages': 'anthropic_messages'}


def native_configuration(inference):
    api = (inference or {}).get('api', 'openai-completions')
    return {'model': {'default': 'primary', 'provider': 'custom:openshell',
                      'base_url': 'https://inference.local/v1', 'api_mode': MODES[api]},
            'custom_providers': [{'name': 'openshell', 'base_url': 'https://inference.local/v1',
                                  'api_mode': MODES[api], 'api_key': 'openshell-placeholder'}],
            'agent': {'max_turns': 8}, 'terminal': {'backend': 'local', 'cwd': '/sandbox/workspace'},
            'approvals': {'mode': 'manual'}}


def configuration_matches(inference):
    import yaml
    actual = yaml.safe_load((ROOT / 'config.yaml').read_text())
    return isinstance(actual, dict) and all(actual.get(k) == v for k, v in native_configuration(inference).items())


def initialize(inference):
    ROOT.mkdir(parents=True, mode=0o700, exist_ok=True)
    path = ROOT / 'config.yaml'
    token(ROOT, create=not path.exists())
    if path.exists():
        if not configuration_matches(inference):
            raise RuntimeError('native Hermes configuration conflicts with deployment-owned settings')
        return
    with open(path, 'x', opener=lambda p, flags: os.open(p, flags, 0o600)) as output:
        json.dump(native_configuration(inference), output)
        output.flush()
        os.fsync(output.fileno())


def api_request(path, body=None, timeout=3):
    request = urllib.request.Request(f'http://127.0.0.1:{PORT}' + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Authorization': 'Bearer ' + token(ROOT), 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read(4 * 1024 * 1024 + 1)
        if len(raw) > 4 * 1024 * 1024:
            raise RuntimeError('Hermes response exceeds limit')
        return json.loads(raw)


def healthy(inference=None):
    try:
        return configuration_matches(inference) and api_request('/v1/models')['data'][0]['id'] == 'primary'
    except (OSError, ValueError, KeyError, IndexError, RuntimeError):
        return False


async def native_server():
    from gateway.config import PlatformConfig
    from gateway.platforms.api_server import APIServerAdapter
    adapter = APIServerAdapter(PlatformConfig(enabled=True, extra={
        'host': '127.0.0.1', 'port': PORT, 'key': token(ROOT), 'model_name': 'primary'}))
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    try:
        if not await adapter.connect():
            raise RuntimeError('Hermes native API startup failed')
        await stop.wait()
    finally:
        await adapter.disconnect()


class HermesRuntime:
    def __init__(self):
        self.process = None
        self.log = None
        self.state_lock = None
        self.failed = False
        self.lock = asyncio.Lock()
        self.previous_response = None

    async def start(self, payload):
        config = payload['config']
        settings = config['harness']['settings']
        self.inference = settings.get('inference')
        self.runtime_id = payload['runtime_context']['runtime_id']
        if not re.fullmatch(r'[A-Za-z0-9_-]+', self.runtime_id):
            raise ValueError('invalid runtime identity')
        model = config['models']['default']
        if model['model'] != 'primary' or model.get('base_url') != 'https://inference.local/v1':
            raise ValueError('Hermes requires the OpenShell primary route')
        ROOT.mkdir(parents=True, mode=0o700, exist_ok=True)
        self.state_lock = (ROOT / 'adapter.lock').open('a')
        try:
            fcntl.flock(self.state_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            initialize(self.inference)
            self.log = (ROOT / 'api.log').open('ab')
            env = dict(os.environ, HERMES_HOME=str(ROOT), OPENAI_API_KEY='openshell-placeholder',
                       OPENAI_BASE_URL='https://inference.local/v1', HERMES_DISABLE_LAZY_INSTALLS='1')
            self.process = await asyncio.create_subprocess_exec(sys.executable, __file__, 'server',
                env=env, cwd='/sandbox/workspace', stdout=self.log, stderr=self.log, start_new_session=True)
            deadline = asyncio.get_running_loop().time() + 75
            while asyncio.get_running_loop().time() < deadline:
                if self.process.returncode is not None:
                    raise RuntimeError('Hermes API exited during startup; inspect api.log')
                if await asyncio.to_thread(healthy, self.inference):
                    return
                await asyncio.sleep(0.1)
            raise RuntimeError('Hermes API readiness timed out')
        except BaseException:
            await self.stop()
            raise

    async def invoke(self, request, context):
        from nemo_fabric_adapter_contract.models import AgentRunResult, AgentRunStatus, AgentRunError
        async with self.lock:
            if self.failed or context.runtime_id != self.runtime_id or self.process.returncode is not None:
                raise RuntimeError('Hermes runtime unavailable; no replay')
            if not isinstance(request.input, str):
                raise ValueError('Hermes requires a text prompt')
            if not configuration_matches(self.inference):
                raise RuntimeError('Hermes configuration drifted')
            body = {'model': 'primary', 'input': request.input, 'store': True}
            if self.previous_response:
                body['previous_response_id'] = self.previous_response
            try:
                result = await asyncio.to_thread(api_request, '/v1/responses', body, 280)
                if result.get('status') != 'completed' or not result.get('id'):
                    raise RuntimeError('Hermes returned an unsuccessful response')
                self.previous_response = result['id']
                text = '\n'.join(c['text'] for item in result.get('output', [])
                                 for c in item.get('content', []) if c.get('type') == 'output_text')
                return AgentRunResult(status=AgentRunStatus.SUCCEEDED,
                    output={'harness': 'hermes', 'response': text, 'response_id': result['id']})
            except BaseException as error:
                self.failed = True
                await self.stop()
                if not isinstance(error, Exception):
                    raise
                return AgentRunResult(status=AgentRunStatus.FAILED, output={'harness': 'hermes'},
                    error=AgentRunError(code='hermes_invocation_failed', message='Hermes invocation failed; no replay; inspect api.log'))

    async def stop(self):
        if self.process is not None and self.process.returncode is None:
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
                await asyncio.wait_for(self.process.wait(), 10)
            except asyncio.TimeoutError:
                os.killpg(self.process.pid, signal.SIGKILL)
                await self.process.wait()
            except ProcessLookupError:
                await self.process.wait()
        if self.log:
            self.log.close()
        if self.state_lock:
            self.state_lock.close()
            self.state_lock = None


if __name__ == '__main__':
    if sys.argv[1:] == ['server']:
        asyncio.run(native_server())
    else:
        from nemo_fabric_adapters.common import lifecycle
        lifecycle.serve(HermesRuntime)
