# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Fabric adapter: Fabric owns one OpenClaw gateway and session.

Uses the pinned OpenClaw gateway RPC CLI, never the CLI's local-agent fallback.
No invocation retry or session recovery is attempted after an uncertain result.
"""
import asyncio
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import urllib.request


from nemo_fabric_adapter_contract.models import AgentRunError, AgentRunResult, AgentRunStatus
from nemo_fabric_adapters.common import lifecycle

ROOT = Path('/sandbox/.openclaw')
NODE = '/usr/local/bin/node'
CLI = '/app/openclaw.mjs'


def native_configuration(name, inference=None):
    config = {
        'gateway': {'mode': 'local', 'bind': 'loopback', 'port': 18789,
                    'auth': {'mode': 'none'}, 'controlUi': {'enabled': False}},
        'models': {'mode': 'replace', 'providers': {'openshell': {
            'baseUrl': 'https://inference.local/v1', 'api': 'openai-completions',
            'apiKey': 'openshell-placeholder', 'models': [{
                'id': 'primary', 'name': 'OpenShell route', 'contextWindow': 32768,
                'maxTokens': 4096, 'input': ['text'], 'reasoning': False,
            }],
        }}},
        'agents': {'defaults': {'model': {'primary': 'openshell/primary'},
                              'workspace': '/sandbox/workspace', 'sandbox': {'mode': 'off'},
                              'heartbeat': {'every': '0m'}},
                   'entries': {name: {}}},
        'memory': {'search': {'enabled': False}},
        'cron': {'enabled': False},
        'update': {'checkOnStart': False, 'auto': {'enabled': False}},
        'tools': {'profile': 'coding', 'exec': {'host': 'gateway', 'mode': 'full'}},
    }

    if inference is not None:
        provider = config['models']['providers']['openshell']
        provider['api'] = inference['api']
        model = provider['models'][0]
        for key, value in inference['tuning'].items():
            if key != 'reasoningEffort':
                model[key] = value
            elif value != 'default':
                config['agents']['defaults']['thinkingDefault'] = value
    return config


def contains(actual, required):
    if isinstance(required, dict):
        return isinstance(actual, dict) and all(k in actual and contains(actual[k], v) for k, v in required.items())
    return actual == required


def owned_configuration(name, inference=None):
    config = {
        'gateway': {'mode': 'local', 'bind': 'loopback', 'port': 18789},
        'models': {'providers': {'openshell': {
            'baseUrl': 'https://inference.local/v1', 'api': 'openai-completions',
            'apiKey': 'openshell-placeholder'}}},
        'agents': {'defaults': {'model': {'primary': 'openshell/primary'},
                               'workspace': '/sandbox/workspace'}, 'entries': {name: {}}},
    }

    if inference is not None:
        native = native_configuration(name, inference)
        config['models'] = native['models']
        if 'thinkingDefault' in native['agents']['defaults']:
            config['agents']['defaults']['thinkingDefault'] = native['agents']['defaults']['thinkingDefault']
    return config


def configuration_matches(name, inference=None):
    actual = json.loads((ROOT / 'openclaw.json').read_text())
    # Native settings (including channels, pairing and plugins) belong to OpenClaw.
    return contains(actual, owned_configuration(name, inference))


def healthy(name, runtime_id, inference=None):
    if not re.fullmatch(r'[a-zA-Z0-9_-]+', runtime_id):
        return False
    try:
        if not configuration_matches(name, inference):
            return False
        with urllib.request.urlopen('http://127.0.0.1:18789/healthz', timeout=3) as response:
            return response.status == 200
    except (OSError, ValueError):
        return False


def normalize_messages(messages):
    normalized = []
    for message in messages:
        role = message.get('role')
        content = message.get('content', [])
        blocks = content if isinstance(content, list) else []
        text = content if isinstance(content, str) else '\n'.join(
            b['text'] for b in blocks if b.get('type') == 'text' and isinstance(b.get('text'), str))
        item = {'role': 'tool' if role == 'toolResult' else role, 'content': text}
        if role == 'assistant':
            item['tool_calls'] = [
                {'id': b['id'], 'type': 'function', 'function': {
                    'name': b['name'], 'arguments': json.dumps(b.get('arguments', {}))}}
                for b in blocks if b.get('type') == 'toolCall'
            ]
        if role == 'toolResult':
            item['tool_call_id'] = message.get('toolCallId', '')
            item['is_error'] = message.get('isError', False)
        normalized.append(item)
    return normalized


class OpenClawRuntime:
    def __init__(self):
        self.inference = None
        self.process = None
        self.log = None
        self.runtime_id = None
        self.failed = False
        self.lock = asyncio.Lock()
        self.state_lock = None

    async def start(self, payload):
        config = payload['config']
        self.runtime_id = payload['runtime_context']['runtime_id']
        self.name = config['harness']['settings']['agent_name']
        self.inference = config['harness']['settings'].get('inference')
        if (not re.fullmatch(r'[a-z][a-z0-9-]*', self.name)
                or not re.fullmatch(r'[a-zA-Z0-9_-]+', self.runtime_id)):
            raise ValueError('invalid OpenClaw runtime identity')
        model = config['models']['default']
        if (model['provider'] != 'openai' or model['model'] != 'primary'
                or model.get('base_url') != 'https://inference.local/v1'
                or model.get('api_key_env') != 'OPENAI_API_KEY'):
            raise ValueError('local OpenClaw adapter requires the OpenShell primary route')
        self.home = ROOT
        self.home.mkdir(parents=True, mode=0o700, exist_ok=True)
        self.state_lock = open(self.home / 'adapter.lock', 'a')
        try:
            fcntl.flock(self.state_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.state_lock.close()
            self.state_lock = None
            raise RuntimeError('retained channel state is already in use') from None
        self.initialize_configuration()
        self.env = dict(os.environ, OPENCLAW_HOME='/sandbox',
                        OPENCLAW_STATE_DIR=str(self.home),
                        OPENCLAW_CONFIG_PATH=str(self.home / 'openclaw.json'))
        self.session_key = f'agent:{self.name}:fabric-{self.runtime_id}'
        await self.start_gateway()

    def initialize_configuration(self):
        path = self.home / 'openclaw.json'
        if path.exists():
            if not configuration_matches(self.name, self.inference):
                raise RuntimeError('native configuration conflicts with deployment-owned settings')
            return
        temporary = path.with_suffix('.tmp')
        with open(temporary, 'w', opener=lambda p, flags: os.open(p, flags, 0o600)) as output:
            json.dump(native_configuration(self.name, self.inference), output)
            output.flush()
            os.fsync(output.fileno())
        temporary.replace(path)

    async def start_gateway(self):
        self.log = (self.home / 'gateway.log').open('ab')
        self.process = await asyncio.create_subprocess_exec(
            NODE, CLI, 'gateway', env=self.env, cwd='/sandbox',
            stdout=self.log, stderr=self.log, start_new_session=True)
        deadline = asyncio.get_running_loop().time() + 75
        while asyncio.get_running_loop().time() < deadline:
            if self.process.returncode is not None:
                await self.stop_gateway()
                raise RuntimeError('OpenClaw gateway exited during startup; inspect gateway.log')
            if await asyncio.to_thread(healthy, self.name, self.runtime_id, self.inference):
                return
            await asyncio.sleep(0.05)
        await self.stop_gateway()
        raise RuntimeError('OpenClaw gateway did not become healthy')

    async def rpc(self, method, params, timeout=280):
        process = await asyncio.create_subprocess_exec(
            NODE, CLI, 'gateway', 'call', method, '--params', json.dumps(params),
            '--expect-final', '--json', '--timeout', str(timeout * 1000),
            env=self.env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            start_new_session=True)
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout + 5)
        except BaseException:
            if process.returncode is None:
                os.killpg(process.pid, signal.SIGKILL)
            await process.wait()
            raise
        if process.returncode:
            raise RuntimeError(f'OpenClaw RPC {method} failed: {stderr.decode(errors="replace")[-2000:]}')
        return json.loads(stdout)

    async def invoke(self, request, context):
        async with self.lock:
            return await self._invoke(request, context)

    async def _invoke(self, request, context):
        if self.failed or context.runtime_id != self.runtime_id or self.process.returncode is not None:
            raise lifecycle.LifecycleError('openclaw_runtime_unavailable', 'OpenClaw runtime is unavailable; no replay')
        if not isinstance(request.input, str):
            raise ValueError('local OpenClaw adapter accepts text input only')
        try:
            result = await self.rpc('agent', {
                'agentId': self.name, 'sessionKey': self.session_key,
                'message': request.input, 'idempotencyKey': context.invocation_id,
                'deliver': False, 'timeout': 260,
            })
            if result.get('status') != 'ok':
                raise RuntimeError('OpenClaw returned a non-successful terminal result')
            native = result.get('result', {})
            if (native.get('meta', {}).get('aborted') or native.get('meta', {}).get('error')
                    or any(p.get('isError') for p in native.get('payloads', []))):
                raise RuntimeError('OpenClaw agent turn aborted or failed')
            response = '\n'.join(p['text'] for p in native.get('payloads', []) if isinstance(p.get('text'), str))
            history = await self.rpc('chat.history', {'sessionKey': self.session_key, 'limit': 200}, timeout=15)
            return AgentRunResult(status=AgentRunStatus.SUCCEEDED, output={
                'harness': 'openclaw', 'response': response,
                'session_key': self.session_key, 'gateway_pid': self.process.pid,
                'messages': normalize_messages(history.get('messages', [])),
                'native_result': result,
            })
        except BaseException as error:
            # An RPC failure can leave the gateway still working on the turn.
            # Quarantine and stop it, rather than accepting overlapping requests.
            self.failed = True
            await self.stop()
            if not isinstance(error, Exception):
                raise
            return AgentRunResult(status=AgentRunStatus.FAILED,
                                  output={'harness': 'openclaw', 'session_key': self.session_key},
                                  error=AgentRunError(code='openclaw_invocation_failed', message=str(error)))

    async def stop(self):
        await self.stop_gateway()
        if self.state_lock is not None:
            self.state_lock.close()
            self.state_lock = None

    async def stop_gateway(self):
        if self.process is not None and self.process.returncode is None:
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
                await asyncio.wait_for(self.process.wait(), 10)
            except asyncio.TimeoutError:
                os.killpg(self.process.pid, signal.SIGKILL)
                await self.process.wait()
            except ProcessLookupError:
                await self.process.wait()
        if self.log is not None:
            self.log.close()


if __name__ == '__main__':
    lifecycle.serve(OpenClawRuntime)
