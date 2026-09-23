"""Shared revision 2 probe corpus. Synthetic dispatch counts, never live proof."""
import http.client
import json
import threading
import unittest
from fixture_server import CORPUS, make_server


class ProbeFixtureTest(unittest.TestCase):
    def test_probe_corpus(self):
        for case in CORPUS['probeCases']:
            with self.subTest(case=case['name']):
                name = case['name']
                scenario = 'probe_' + name if name in ('expired', 'replaced', 'unavailable', 'stream_lost') else 'ready'
                server = make_server(scenario, heartbeat_seconds=0.02)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                stream = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=2)
                probe = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=2)
                try:
                    if name != 'before_connection':
                        req = CORPUS['cases'][0]['request']
                        stream.request('POST', req['path'], json.dumps(req['body']), req['headers'])
                        response = stream.getresponse()
                        self.assertEqual(response.status, 200)
                        self.assertEqual(json.loads(response.readline())['type'], 'ready')
                    req = case['request']
                    if name == 'second_probe':
                        probe.request('POST', req['path'], json.dumps(req['body']), req['headers'])
                        first = probe.getresponse()
                        self.assertEqual(first.status, 200)
                        first.read()
                    probe.request('POST', req['path'], req.get('rawBody', json.dumps(req['body'])), req['headers'])
                    result = probe.getresponse()
                    self.assertEqual(result.status, case['response']['status'])
                    self.assertEqual(json.loads(result.read()), case['response']['body'])
                    self.assertEqual(server.dispatches, case['nativeDispatches'])
                finally:
                    probe.close()
                    stream.close()
                    server.stopping.set()
                    server.shutdown()
                    server.server_close()
                    thread.join()


if __name__ == '__main__':
    unittest.main()
