"""Synthetic R0 wire fixture. Not an agent backend or production server."""
import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CORPUS = json.loads(Path(__file__).with_name('fixtures.json').read_text())


def make_server(scenario='ready', port=0, heartbeat_seconds=5):
    case = next(c for c in CORPUS['cases'] if c['name'] == scenario)

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

        def do_POST(self):
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
                while scenario == 'ready' and not self.server.stopping.wait(heartbeat_seconds):
                    self.wfile.write(b'{"type":"heartbeat"}\n')
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass

        def do_GET(self):
            self.json_error(405, 'method_not_allowed')

    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.stopping = threading.Event()
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
