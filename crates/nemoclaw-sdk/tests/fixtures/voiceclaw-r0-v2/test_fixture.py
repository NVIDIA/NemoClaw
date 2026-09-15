"""Checks the fixture server against the portable corpus, not production conformance."""
import http.client
import json
import threading
import unittest
from fixture_server import CORPUS, make_server


class FixtureTest(unittest.TestCase):
    def test_all_wire_cases(self):
        for case in CORPUS['cases']:
            with self.subTest(case=case['name']):
                server = make_server(case['name'], heartbeat_seconds=0.02)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                client = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=2)
                try:
                    req = case['request']
                    client.request(req['method'], req['path'], json.dumps(req['body']), req['headers'])
                    response = client.getresponse()
                    expected = case['response']
                    self.assertEqual(response.status, expected['status'])
                    self.assertEqual(response.getheader('Content-Type'), expected['contentType'])
                    self.assertEqual(response.getheader('Cache-Control'), 'no-store')
                    if response.status == 200:
                        for record in expected['records']:
                            self.assertEqual(json.loads(response.readline()), record)
                        if case['name'] == 'ready':
                            self.assertEqual(json.loads(response.readline()), {'type': 'heartbeat'})
                        else:
                            self.assertEqual(response.readline(), b'')
                    else:
                        self.assertEqual(json.loads(response.read()), expected['body'])
                    response.close()
                finally:
                    client.close()
                    server.stopping.set()
                    server.shutdown()
                    server.server_close()
                    thread.join()

    def test_fixture_does_not_accept_wrong_client_request(self):
        server = make_server()
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        client = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=2)
        try:
            client.request('POST', '/r0/connect', '{}', {'Content-Type': 'application/json'})
            response = client.getresponse()
            self.assertEqual(response.status, 400)
            self.assertEqual(json.loads(response.read())['error']['code'], 'fixture_request_mismatch')
        finally:
            client.close()
            server.stopping.set()
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
