# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
import copy
import json
import os
import asyncio
import gzip
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import openclaw_adapter as adapter
from fabric import configuration

class Observability(unittest.TestCase):
    def test_native_telemetry_and_drift(self):
        options = {'api': 'openai-completions', 'tuning': {}, 'observability': {'otlp': {
            'enabled': True, 'endpoint': 'http://host.openshell.internal:4318',
            'serviceName': 'agent fixture', 'sampleRate': 0.5}}}
        self.assertNotIn('diagnostics', adapter.native_configuration('main'))
        with tempfile.TemporaryDirectory() as directory, patch.object(adapter, 'ROOT', Path(directory)):
            runtime = adapter.OpenClawRuntime()
            runtime.name, runtime.home, runtime.inference = 'main', Path(directory), options
            runtime.initialize_configuration()
            path = Path(directory) / 'openclaw.json'
            native = json.loads(path.read_text())
            self.assertEqual(native['diagnostics'], {'enabled': True, 'otel': {
                **options['observability']['otlp'], 'protocol': 'http/protobuf',
                'traces': True, 'metrics': False, 'logs': False}})
            self.assertEqual(native['plugins']['entries']['diagnostics-otel'], {'enabled': True})
            self.assertTrue(adapter.configuration_matches('main', options))
            for section in ['diagnostics', 'plugins']:
                drift = copy.deepcopy(native)
                del drift[section]
                path.write_text(json.dumps(drift))
                before = path.read_bytes()
                self.assertFalse(adapter.configuration_matches('main', options))
                with self.assertRaises(RuntimeError):
                    runtime.initialize_configuration()
                self.assertEqual(path.read_bytes(), before)


@unittest.skipUnless(os.environ.get('NEMOCLAW_TEST_NATIVE_FEATURES') == '1',
                     'requires a disposable network-disabled OpenClaw container with a loopback collector alias')
class NativeTelemetry(unittest.IsolatedAsyncioTestCase):
    async def test_native_gateway_exports_a_trace_to_the_owned_collector(self):
        received = []
        class Collector(BaseHTTPRequestHandler):
            def do_POST(self):
                if self.headers.get('Transfer-Encoding') == 'chunked':
                    chunks = []
                    while True:
                        size = int(self.rfile.readline().split(b';')[0], 16)
                        if size == 0:
                            self.rfile.readline()
                            break
                        chunks.append(self.rfile.read(size))
                        self.rfile.read(2)
                    body = b''.join(chunks)
                else:
                    body = self.rfile.read(int(self.headers['Content-Length']))
                if self.headers.get('Content-Encoding') == 'gzip':
                    body = gzip.decompress(body)
                received.append((self.path, self.headers.get('Content-Type'), body))
                self.send_response(200)
                self.send_header('Content-Type', 'application/x-protobuf')
                self.end_headers()
            def log_message(self, *_):
                pass
        collector = ThreadingHTTPServer(('127.0.0.1', 4318), Collector)
        worker = Thread(target=collector.serve_forever, daemon=True)
        worker.start()
        options = {'api':'openai-completions', 'tuning':{}, 'execution':{'timeoutSeconds':1, 'heartbeatEvery':'0m'},
                   'observability':{'otlp':{'enabled':True,'endpoint':'http://host.openshell.internal:4318',
                                          'serviceName':'nemoclaw-trace-fixture','sampleRate':1}}}
        try:
            with tempfile.TemporaryDirectory(dir='/sandbox') as directory, patch.object(adapter, 'ROOT', Path(directory)):
                runtime = adapter.OpenClawRuntime()
                try:
                    await runtime.start({'config':configuration('main','openclaw',inference=options),
                                         'runtime_context':{'runtime_id':'trace-fixture'}})
                    self.assertTrue(adapter.configuration_matches('main', options))
                    # A timed-out turn still produces a native run span, without contacting a model service.
                    try:
                        await runtime.rpc('agent', {'agentId':'main','sessionKey':'agent:main:trace-fixture',
                            'message':'fixture','idempotencyKey':'trace-once','deliver':False,'timeout':1}, timeout=10)
                    except RuntimeError:
                        pass
                finally:
                    await runtime.stop()
                self.assertTrue(received, (Path(directory) / 'gateway.log').read_text()[-4000:])
                self.assertTrue(all(path == '/v1/traces' for path, _, _ in received))
                self.assertTrue(any(b'nemoclaw-trace-fixture' in body for _, _, body in received))
        finally:
            await asyncio.to_thread(collector.shutdown)
            collector.server_close()
            worker.join()
