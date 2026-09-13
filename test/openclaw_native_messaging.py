# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Native Fabric/OpenClaw, local Telegram and model protocol fixtures. No internet."""
import asyncio
import http.server
import json
import os
from pathlib import Path
import re
import ssl
import subprocess
import sys
import threading
import time

sys.path.insert(0, '/opt/nemoclaw')
import socket
import uuid

PHASE = sys.argv[1]
EVIDENCE = Path('/evidence')
TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk'
condition = threading.Condition()
updates, sent, models, methods = [], [], [], []
next_update = 10000 if PHASE == 'recreate' else 100
NATIVE_ENV = dict(os.environ, HOME='/sandbox', OPENCLAW_HOME='/sandbox',
                  OPENCLAW_STATE_DIR='/sandbox/.openclaw', OPENCLAW_CONFIG_PATH='/sandbox/.openclaw/openclaw.json',
                  SSL_CERT_FILE='/certs/fixture.crt', NODE_EXTRA_CA_CERTS='/certs/fixture.crt')
commands = []


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.do_POST()

    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        body = json.loads(raw) if raw else {}
        if '/chat/completions' in self.path:
            with condition:
                models.append(body)
            text = '\n'.join(str(m.get('content', '')) for m in body.get('messages', []) if m.get('role') == 'user' and isinstance(m.get('content'), str))
            markers = re.findall(r'PROBE_[A-Z_]+', text)
            answer = markers[-1] if markers else 'FIXTURE_REPLY'
            # Verify a real native tool call and its resulting file independently.
            if 'PROBE_TOOL' in text and not any(m.get('role') == 'tool' for m in body['messages']):
                delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'channel-tool-proof',
                    'type': 'function', 'function': {'name': 'exec', 'arguments': json.dumps({
                        'command': "printf fabric-channel-tool-proof > /sandbox/workspace/channel-proof.txt"})}}]}
                finish = 'tool_calls'
            else:
                delta, finish = {'role': 'assistant', 'content': answer}, 'stop'
            if body.get('stream'):
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                for chunk in [dict(id='fixture', object='chat.completion.chunk', created=int(time.time()), model='primary',
                                   choices=[{'index': 0, 'delta': delta, 'finish_reason': None}]),
                              dict(id='fixture', object='chat.completion.chunk', created=int(time.time()), model='primary',
                                   choices=[{'index': 0, 'delta': {}, 'finish_reason': finish}],
                                   usage={'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15})]:
                    self.wfile.write(('data: '+json.dumps(chunk)+'\n\n').encode())
                self.wfile.write(b'data: [DONE]\n\n')
                self.wfile.flush()
                return
            return self.respond({'id': 'fixture', 'object': 'chat.completion', 'model': 'primary',
                                 'choices': [{'index': 0, 'message': delta, 'finish_reason': finish}],
                                 'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15}})
        if not self.path.startswith('/bot'+TOKEN+'/'):
            return self.respond({'ok': False, 'error_code': 401, 'description': 'Unauthorized'}, 401)
        method = self.path.rsplit('/', 1)[-1].split('?', 1)[0]
        with condition:
            methods.append(method)
        if method == 'getMe':
            result = {'id': 123456, 'is_bot': True, 'first_name': 'Fixture', 'username': 'fabric_fixture_bot',
                      'can_join_groups': True, 'can_read_all_group_messages': False, 'supports_inline_queries': False}
        elif method == 'getUpdates':
            with condition:
                condition.wait(0.2)
                result = [x for x in updates if x['update_id'] >= int(body.get('offset', 0))]
        elif method == 'getWebhookInfo':
            result = {'url': '', 'has_custom_certificate': False, 'pending_update_count': 0}
        elif method in ('sendMessage', 'editMessageText'):
            with condition:
                sent.append(body)
            result = {'message_id': len(sent), 'date': int(time.time()),
                      'chat': {'id': int(body['chat_id']), 'type': 'private'}, 'text': body.get('text', '')}
        elif method == 'getMyCommands':
            result = []
        else:
            result = True
        self.respond({'ok': True, 'result': result})

    def respond(self, value, status=200):
        raw = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ssl.SSLEOFError):
            pass


def message(user, text):
    global next_update
    next_update += 1
    with condition:
        updates.append({'update_id': next_update, 'message': {'message_id': next_update, 'date': int(time.time()),
            'from': {'id': user, 'is_bot': False, 'first_name': f'User{user}'},
            'chat': {'id': user, 'type': 'private', 'first_name': f'User{user}'}, 'text': text}})
        condition.notify_all()


def wait(predicate, label, seconds=80):
    deadline = time.monotonic()+seconds
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.25)
    raise AssertionError('timed out: '+label)


def native(*args, parse=True):
    commands.append(list(args))
    result = subprocess.run(['/usr/local/bin/openclaw', *args], capture_output=True, text=True,
                            env=NATIVE_ENV, timeout=90, user=1000, group=1000)
    if result.returncode != 0:
        raise AssertionError('native command failed: '+str(args)+'\n'+result.stdout+result.stderr)
    return json.loads(result.stdout) if parse else result.stdout


def configure(path, value):
    native('config', 'set', '--strict-json', path, json.dumps(value), parse=False)


def status():
    return native('channels', 'status', '--probe', '--json')['channelAccounts']['telegram'][0]


def wait_channel(enabled, authenticated=True):
    deadline = time.monotonic()+90
    last = None
    while time.monotonic() < deadline:
        try:
            last = status()
            if enabled and last.get('running') and last.get('probe', {}).get('ok') is authenticated:
                return last
            if not enabled and last.get('enabled') is False and not last.get('running'):
                return last
            if enabled and not authenticated and last.get('probe', {}).get('ok') is False:
                return last
        except (AssertionError, KeyError):
            pass
        time.sleep(1)
    raise AssertionError('native channel state did not converge: '+str(last))


def probe():
    with socket.socket(socket.AF_UNIX) as connection:
        connection.connect('/sandbox/fabric.sock')
        connection.sendall(b'{"operation":"check"}\n')
        return json.loads(connection.makefile().readline())


def gateway_pid():
    for path in Path('/proc').iterdir():
        if not path.name.isdigit():
            continue
        try:
            cmd = (path/'cmdline').read_bytes().replace(b'\x00', b' ').strip()
            if cmd == b'openclaw-gateway' or cmd.startswith(b'/usr/local/bin/node /app/openclaw.mjs gateway'):
                return int(path.name)
        except OSError:
            pass
    raise AssertionError('missing native gateway process')


def reply(user, marker):
    message(user, marker)
    wait(lambda: any(str(x.get('chat_id')) == str(user) and marker in x.get('text', '') for x in sent), marker)


def start():
    env = dict(NATIVE_ENV, HOME='/sandbox', TMPDIR='/sandbox/tmp', NEMOCLAW_AGENT_NAME='main',
               NEMOCLAW_FABRIC_HARNESS='openclaw', OPENAI_API_KEY='openshell-placeholder',
               ADAPTER_PYTHON='/opt/fabric/bin/python', PYTHONPATH='/opt/nemoclaw',
               SSL_CERT_FILE='/certs/fixture.crt', NODE_EXTRA_CA_CERTS='/certs/fixture.crt',
               PATH='/opt/fabric/bin:/usr/local/bin:/usr/bin:/bin')
    log = (EVIDENCE / (PHASE+'-fabric.log')).open('ab')
    process = subprocess.Popen(['/opt/fabric/bin/python', '/opt/nemoclaw/fabric.py', 'serve'],
                                env=env, stdout=log, stderr=log, user=1000, group=1000)
    def ready():
        if process.poll() is not None:
            raise AssertionError('Fabric startup failed; inspect log')
        try:
            return probe()['ready']
        except (OSError, ConnectionError):
            return False
    wait(ready, 'adapter startup', 120)
    return process, log


def stop(process, log):
    process.terminate()
    try:
        process.wait(25)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    log.close()


def main():
    # Isolated loopback alias passes native model SSRF checks without weakening them.
    # --network none ensures this address never routes to an external system.
    subprocess.run(['ip', 'addr', 'add', '8.8.4.4/32', 'dev', 'lo'], check=True)
    server = http.server.ThreadingHTTPServer(('0.0.0.0', 443), Handler)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain('/certs/fixture.crt', '/certs/fixture.key')
    server.socket = tls.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    process, log = start()
    proof = {'phase': PHASE, 'evidence_type': 'native processes; Telegram and inference protocol fixtures; network none'}
    try:
        assert not Path('/sandbox/fabric-channels.sock').exists(), 'retired channel interface present'
        proof['runtime_id'] = probe()['runtime_id']
        if PHASE == 'configure':
            # Every channel operation is an existing native command, not an adapter extension.
            configure('session.dmScope', 'per-channel-peer')
            configure('bindings', [{'agentId': 'main', 'match': {'channel': 'telegram', 'accountId': 'default'}}])
            configure('plugins.entries.telegram.enabled', True)
            desired = {'enabled': True, 'tokenFile': '/run/native-secrets/bot-token',
                       'dmPolicy': 'pairing', 'allowFrom': [], 'groupPolicy': 'disabled',
                       'streaming': {'mode': 'off'}}
            configure('channels.telegram', desired)
            wait_channel(True)
            before = len(models)
            message(111, 'PROBE_UNAUTHORIZED')
            wait(lambda: len(sent) > 0, 'pairing challenge')
            time.sleep(1)
            assert len(models) == before, 'unauthorized sender reached model'
            pending = native('pairing', 'list', 'telegram', '--json')['requests']
            assert len(pending) == 1 and str(pending[0]['id']) == '111', pending
            native('pairing', 'approve', 'telegram', pending[0]['code'], parse=False)
            reply(111, 'PROBE_CHAT_A_SECRET')
            message(222, 'PROBE_SECOND_PAIRING')
            wait(lambda: any(str(x.get('chat_id')) == '222' for x in sent), 'second pairing challenge')
            pending = native('pairing', 'list', 'telegram', '--json')['requests']
            native('pairing', 'approve', 'telegram', next(x['code'] for x in pending if str(x['id']) == '222'), parse=False)
            prior = len(models)
            reply(222, 'PROBE_CHAT_B_SECRET')
            assert all('PROBE_CHAT_A_SECRET' not in json.dumps(x) for x in models[prior:]), 'conversation history leaked'
            reply(111, 'PROBE_TOOL')
            assert Path('/sandbox/workspace/channel-proof.txt').read_text() == 'fabric-channel-tool-proof'
            assert any(m.get('role') == 'tool' for x in models for m in x['messages']), 'missing native tool result'
            pid = gateway_pid()
            # A deployment readiness check accepts native channel settings without changing them.
            config_bytes = Path('/sandbox/.openclaw/openclaw.json').read_bytes()
            check = subprocess.run(['/opt/fabric/bin/python', '/opt/nemoclaw/fabric.py', 'check', 'main', 'openclaw'])
            assert check.returncode == 0
            assert config_bytes == Path('/sandbox/.openclaw/openclaw.json').read_bytes()
            assert gateway_pid() == pid and probe()['runtime_id'] == proof['runtime_id']
            proof.update(unauthorized_blocked=True, native_pairing=True, separate_conversations=True,
                         native_tool_verified=True, provisioning_check_preserves_native_settings=True,
                         gateway_pid=pid)
        else:
            wait_channel(True)
            previous = json.loads((EVIDENCE/'configure-proof.json').read_text())
            assert proof['runtime_id'] != previous['runtime_id']
            reply(111, 'PROBE_AFTER_RECREATE')
            assert any('PROBE_CHAT_A_SECRET' in json.dumps(x) for x in models), 'history was not retained'
            assert Path('/sandbox/workspace/channel-proof.txt').read_text() == 'fabric-channel-tool-proof'
            proof['recreated_runtime_retains_native_configuration_enrollment_history_workspace'] = True
            configure('channels.telegram.enabled', False)
            wait_channel(False)
            before = len(models)
            message(111, 'PROBE_DISABLED')
            time.sleep(3)
            assert len(models) == before, 'disabled channel invoked model'
            proof['native_disable_blocks_invocation'] = True
            Path('/run/native-secrets/bot-token').write_text('999999:INVALID_TOKEN_FOR_FIXTURE')
            configure('channels.telegram.enabled', True)
            wait_channel(True, authenticated=False)
            result = native('gateway', 'call', 'agent', '--params', json.dumps({
                'agentId': 'main', 'sessionKey': 'agent:main:native-cli-proof',
                'message': 'PROBE_AGENT_USABLE', 'idempotencyKey': str(uuid.uuid4()), 'deliver': False}),
                '--expect-final', '--json', '--timeout', '80000')
            assert result['status'] == 'ok' and 'PROBE_AGENT_USABLE' in json.dumps(result), result
            configure('channels.telegram.enabled', False)
            wait_channel(False)
            proof.update(native_credential_failure_visible=True, native_agent_independent_of_channel_failure=True)
        (EVIDENCE/(PHASE+'-proof.json')).write_text(json.dumps(proof, indent=2)+'\n')
        print(json.dumps(proof), flush=True)
    finally:
        (EVIDENCE/(PHASE+'-fixture.json')).write_text(json.dumps({'sent': sent, 'models': models, 'methods': methods, 'native_commands': commands}, indent=2)+'\n')
        stop(process, log)
        server.shutdown()


if __name__ == '__main__':
    main()
