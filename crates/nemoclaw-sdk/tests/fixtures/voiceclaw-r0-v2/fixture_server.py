"""Synthetic R0 wire fixture. Not an agent backend or production server."""
import argparse
import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CORPUS = json.loads(Path(__file__).with_name('fixtures.json').read_text())


def make_server(scenario='ready', port=0, heartbeat_seconds=5):
    case = next(c for c in CORPUS['cases'] if c['name'] == (scenario if not scenario.startswith('probe_') else 'ready'))

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *args):
            pass  # Never log request headers or credentials.

        def json_error(self, status, code):
            payload = json.dumps({'error': {'code': code}}).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(payload)))
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(payload)
            self.close_connection = True

        def probe(self):
            # Authenticate before looking at protected run or target state.
            if self.headers.get('Authorization') != 'Bearer ' + CORPUS['syntheticCredential']:
                return self.json_error(401, 'authentication_failed')
            if scenario == 'probe_expired':
                return self.json_error(401, 'credential_expired')
            if self.headers.get('Content-Type', '').split(';')[0].strip().lower() != 'application/json':
                return self.json_error(415, 'unsupported_media_type')
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if length > 4096:
                    return self.json_error(413, 'request_too_large')
                if length <= 0 or self.headers.get('Transfer-Encoding'):
                    return self.json_error(400, 'invalid_request')
                def unique(pairs):
                    result = {}
                    for key, value in pairs:
                        if key in result:
                            raise ValueError('duplicate key')
                        result[key] = value
                    return result
                body = json.loads(self.rfile.read(length), object_pairs_hook=unique)
            except (ValueError, UnicodeError):
                return self.json_error(400, 'invalid_request')
            if not isinstance(body, dict) or set(body) != {'profile', 'targetRef', 'question'}:
                return self.json_error(400, 'invalid_request')
            if body['profile'] != CORPUS['profile']:
                return self.json_error(409, 'unsupported_profile')
            if body['targetRef'] != CORPUS['targetRef']:
                return self.json_error(403, 'target_not_authorized')
            if body['question'] != CORPUS['probe']['clientRequest']['question']:
                return self.json_error(400, 'invalid_request')
            with self.server.lock:
                if not self.server.active:
                    return self.json_error(409, 'connection_required')
                if self.server.probed:
                    return self.json_error(409, 'probe_already_used')
                if scenario == 'probe_replaced':
                    return self.json_error(409, 'target_replaced')
                if scenario == 'probe_unavailable':
                    return self.json_error(503, 'agent_unavailable')
                self.server.probed = True
                self.server.dispatches += 1
            if scenario == 'probe_stream_lost':
                self.server.stream.shutdown(socket.SHUT_RDWR)
                self.server.stream.close()
                return self.json_error(503, 'connection_lost')
            payload = json.dumps(CORPUS['probe']['success']).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(payload)))
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(payload)
            self.close_connection = True

        def do_POST(self):
            if self.path == '/r0/probe':
                return self.probe()
            expected = case['request']
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 <= length <= 8192:
                    return self.json_error(413, 'request_too_large')
                raw = self.rfile.read(length)
                body = json.loads(raw)
            except (ValueError, UnicodeError):
                return self.json_error(400, 'invalid_request')
            # Exact scenario inputs prevent a fixture from hiding client bugs.
            if (self.path != expected['path'] or body != expected['body']
                    or self.headers.get('Authorization') != expected['headers'].get('Authorization')
                    or self.headers.get('Content-Type', '').split(';')[0].strip().lower()
                    != expected['headers']['Content-Type']
                    or self.headers.get('Accept') != expected['headers']['Accept']):
                return self.json_error(400, 'fixture_request_mismatch')
            response = case['response']
            if response['status'] != 200:
                return self.json_error(response['status'], response['body']['error']['code'])
            with self.server.lock:
                if self.server.active:
                    return self.json_error(409, 'connection_active')
                self.server.active = True
                self.server.stream = self.connection
            self.send_response(200)
            self.send_header('Content-Type', 'application/x-ndjson')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.close_connection = True
            try:
                for record in response['records']:
                    self.wfile.write((json.dumps(record) + '\n').encode())
                    self.wfile.flush()
                while (scenario == 'ready' or scenario.startswith('probe_')) and not self.server.stopping.wait(heartbeat_seconds):
                    self.wfile.write(b'{"type":"heartbeat"}\n')
                    self.wfile.flush()
            except OSError:
                pass
            finally:
                with self.server.lock:
                    self.server.active = False

        def do_GET(self):
            self.json_error(405, 'method_not_allowed')

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.stopping = threading.Event()
    server.lock = threading.Lock()
    server.active = False
    server.probed = False
    server.dispatches = 0
    return server


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scenario', choices=[c['name'] for c in CORPUS['cases']], default='ready')
    parser.add_argument('--port', type=int, default=0)
    args = parser.parse_args()
    server = make_server(args.scenario, args.port)
    print(json.dumps({'endpoint': f'http://127.0.0.1:{server.server_port}/r0/connect',
                      'scenario': args.scenario, 'synthetic': True}), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.stopping.set()
        server.server_close()
