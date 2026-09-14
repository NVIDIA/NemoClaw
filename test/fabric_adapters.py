# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Real packaged adapters against local TLS fixtures, inside an offline container."""
import asyncio
import http.server
import json
import os
from pathlib import Path
import ssl
import shutil
import subprocess
import sys
import threading
import time

sys.path.insert(0, '/opt/nemoclaw')

HARNESS = sys.argv[1]
requests = []
EVIDENCE = Path(os.environ.get("FABRIC_FIXTURE_EVIDENCE", "/evidence"))
MARKER = os.environ.get("FABRIC_FIXTURE_MARKER", "FABRIC_FIXTURE_OK")


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.respond({'data': [{'id': 'primary', 'object': 'model'}]})

    def respond(self, value):
        data = json.dumps(value).replace('FABRIC_FIXTURE_OK', MARKER).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
        requests.append({'path': self.path, 'body': body})
        (EVIDENCE / 'requests.json').write_text(json.dumps(requests, indent=2))
        text = 'FABRIC_FIXTURE_OK'
        if '/responses' in self.path:
            item = {'id': 'msg_fixture', 'type': 'message', 'role': 'assistant', 'status': 'completed',
                    'content': [{'type': 'output_text', 'text': text, 'annotations': []}]}
            response = {'id': 'resp_fixture', 'object': 'response', 'status': 'completed', 'model': 'primary',
                        'output': [item], 'usage': {'input_tokens': 10, 'output_tokens': 5, 'total_tokens': 15}}
            if not body.get('stream'):
                return self.respond(response)
            events = [('response.created', {'response': {**response, 'status': 'in_progress', 'output': []}}),
                      ('response.output_item.added', {'output_index': 0, 'item': {**item, 'status': 'in_progress', 'content': []}}),
                      ('response.output_text.delta', {'item_id': item['id'], 'output_index': 0, 'content_index': 0, 'delta': text}),
                      ('response.output_item.done', {'output_index': 0, 'item': item}),
                      ('response.completed', {'response': response})]
        elif '/messages' in self.path:
            response = {'id': 'msg_fixture', 'type': 'message', 'role': 'assistant', 'model': 'primary',
                        'content': [{'type': 'text', 'text': text}], 'stop_reason': 'end_turn', 'stop_sequence': None,
                        'usage': {'input_tokens': 10, 'output_tokens': 5}}
            if not body.get('stream'):
                return self.respond(response)
            events = [('message_start', {'message': {**response, 'content': [], 'stop_reason': None}}),
                      ('content_block_start', {'index': 0, 'content_block': {'type': 'text', 'text': ''}}),
                      ('content_block_delta', {'index': 0, 'delta': {'type': 'text_delta', 'text': text}}),
                      ('content_block_stop', {'index': 0}),
                      ('message_delta', {'delta': {'stop_reason': 'end_turn', 'stop_sequence': None}, 'usage': {'output_tokens': 5}}),
                      ('message_stop', {})]
        else:
            message = {'role': 'assistant', 'content': text}
            if HARNESS in ('mini-swe-agent', 'nooa', 'nooa-bench'):
                command = "printf FABRIC_FIXTURE_OK > /sandbox/workspace/tool-proof.txt"
                if HARNESS == 'mini-swe-agent':
                    tool, args = 'bash', {'command': command + '; printf "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT\\nFABRIC_FIXTURE_OK\\n"'}
                else:
                    code = 'await self.shell.run(' + repr(command) + ')\n'
                    if HARNESS == 'nooa':
                        code += 'self.message("FABRIC_FIXTURE_OK")\nreturn_result(RespondResult(kind="DONE", explanation="FABRIC_FIXTURE_OK"))'
                    else:
                        code += 'return_result(TaskResult(solution_description="FABRIC_FIXTURE_OK", evidence="file written", command_to_verify="cat /sandbox/workspace/tool-proof.txt"))'
                    tool, args = 'execute_python', {'code': code}
                message = {'role': 'assistant', 'content': None, 'tool_calls': [{'id': 'call_'+str(len(requests)), 'type': 'function',
                           'function': {'name': tool, 'arguments': json.dumps(args)}}]}

            response = {'id': 'chat_fixture', 'object': 'chat.completion', 'created': int(time.time()), 'model': 'primary',
                        'choices': [{'index': 0, 'message': message, 'finish_reason': 'tool_calls' if 'tool_calls' in message else 'stop'}],
                        'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15, 'cost': 0}}
            if not body.get('stream'):
                return self.respond(response)
            events = [(None, {**response, 'object': 'chat.completion.chunk', 'choices': [{'index': 0, 'delta': message, 'finish_reason': None}]}),
                      (None, {**response, 'object': 'chat.completion.chunk', 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]})]
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        for seq, (event, data) in enumerate(events):
            if event:
                data = {'type': event, 'sequence_number': seq, **data}
                self.wfile.write(f'event: {event}\n'.encode())
            self.wfile.write(('data: '+json.dumps(data).replace('FABRIC_FIXTURE_OK', MARKER)+'\n\n').encode())
        if events[0][0] is None:
            self.wfile.write(b'data: [DONE]\n\n')
        self.wfile.flush()


async def main():
    from fabric import configuration
    from nemo_fabric import Fabric, FabricConfig
    for d in ('/sandbox/tmp', '/sandbox/workspace', '/sandbox/artifacts'):
        Path(d).mkdir(parents=True, exist_ok=True)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 443), Handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain('/certs/fixture.crt', '/certs/fixture.key')
    server.socket = ctx.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    config = configuration('fixture', HARNESS)
    env = dict(os.environ, NEMOCLAW_AGENT_NAME='fixture', NEMOCLAW_FABRIC_HARNESS=HARNESS)
    with open('/evidence/host.log', 'w') as log:
        host = subprocess.Popen([sys.executable, '/opt/nemoclaw/fabric.py', 'serve'], env=env, stdout=log, stderr=log)
        try:
            for _ in range(90):
                if host.poll() is not None:
                    raise AssertionError('host exited: '+Path('/evidence/host.log').read_text())
                if Path('/sandbox/fabric.sock').exists():
                    break
                await asyncio.sleep(1)
            for _ in range(2):
                subprocess.run([sys.executable, '/opt/nemoclaw/fabric.py', 'check', 'fixture', HARNESS], check=True)
            mismatch = subprocess.run([sys.executable, '/opt/nemoclaw/fabric.py', 'check', 'wrong-name', HARNESS])
            assert mismatch.returncode != 0, 'readiness accepted different configuration'
            assert not requests, 'readiness made an inference request'
        finally:
            host.terminate()
            host.wait(timeout=30)
    runtime = await Fabric().start_runtime(FabricConfig.model_validate(config), base_dir='/sandbox')
    results = []
    try:
        for _ in range(2):
            result = await runtime.invoke(input='Reply FABRIC_FIXTURE_OK, then finish the task.')
            mapping = result.to_mapping()
            results.append(mapping)
            Path('/evidence/results.json').write_text(json.dumps(results, indent=2))
            assert mapping['runtime_id'] == runtime.runtime_id, mapping
            assert mapping['status'] == 'succeeded', mapping
            assert 'FABRIC_FIXTURE_OK' in json.dumps(mapping.get('output')), mapping
    finally:
        await runtime.stop()
        shutil.copytree("/sandbox/artifacts", "/evidence/artifacts", dirs_exist_ok=True)
        for f in Path("/sandbox").rglob("*log*"):
            if f.is_file() and "artifacts" not in str(f):
                dest = Path("/evidence/native") / f.relative_to("/sandbox")
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(f, dest)
        server.shutdown()
    if HARNESS in ('mini-swe-agent', 'nooa', 'nooa-bench'):
        assert Path('/sandbox/workspace/tool-proof.txt').read_text() == 'FABRIC_FIXTURE_OK'
    Path('/evidence/proof.json').write_text(json.dumps({'harness': HARNESS, 'readiness_without_inference': True,
        'tool_file_verified': HARNESS in ('mini-swe-agent', 'nooa', 'nooa-bench'),
        'stopped': True, 'ordered_invocations': len(results), 'runtime_id': runtime.runtime_id, 'request_paths': sorted({r['path'] for r in requests}),
        'network': 'none; local TLS protocol fixture; no live model'}, indent=2)+'\n')


if __name__ == "__main__":
    if len(sys.argv) == 5 and sys.argv[2] == "--serve-fixture":
        http.server.ThreadingHTTPServer((sys.argv[3], int(sys.argv[4])), Handler).serve_forever()
    else:
        asyncio.run(main())
