#!/usr/bin/env python3
"""A stand-in for Telegram's bot API, for tests: logs every call to LOG (one JSON line each)
and hands out the updates (taps) that the test appends to UPDATES as JSON lines.
  fake-telegram.py PORT_FILE LOG UPDATES"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

port_file, log, updates_file = sys.argv[1:4]
next_message = [100]


def pending(offset):
    try:
        with open(updates_file) as f:
            ups = [json.loads(line) for line in f if line.strip()]
    except FileNotFoundError:
        ups = []
    return [u for u in ups if offset is None or u["update_id"] >= offset]


class Api(BaseHTTPRequestHandler):
    def do_POST(self):
        method = self.path.rsplit('/', 1)[-1]
        params = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
        with open(log, 'a') as f:
            f.write(json.dumps({'method': method, 'token': self.path.split('/')[1][3:], **params}) + '\n')
        if method == 'getUpdates':
            deadline = time.time() + min(params.get('timeout', 0), 1)
            while not (result := pending(params.get('offset'))) and time.time() < deadline:
                time.sleep(0.1)
        elif method == 'sendMessage':
            next_message[0] += 1
            result = {'message_id': next_message[0]}
        elif method == 'getMe':
            result = {'username': 'test_bot'}
        else:
            result = True
        body = json.dumps({'ok': True, 'result': result}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass   # the helper was stopped mid-call

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), Api)
with open(port_file, 'w') as f:
    f.write(str(server.server_address[1]))
server.serve_forever()
