# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Native interface settings and retained sandbox-local access credentials."""
import os
from pathlib import Path
import re
import secrets
import stat

TOKEN_NAME = 'interface-token'


def dashboard(inference):
    return (inference or {}).get('interfaces', {}).get('dashboard')


def gateway_settings(inference):
    settings = dashboard(inference)
    if settings is None:
        return {'mode': 'local', 'bind': 'loopback', 'port': 18789,
                'auth': {'mode': 'none'}, 'controlUi': {'enabled': False}}
    port = settings.get('port', 18789)
    return {'mode': 'local', 'bind': 'lan' if settings.get('bind') == '0.0.0.0' else 'loopback',
            'port': port, 'auth': {'mode': 'token', 'token': '${NEMOCLAW_INTERFACE_TOKEN}'},
            'controlUi': {'enabled': True, 'allowedOrigins': [f'http://127.0.0.1:{port}', f'http://localhost:{port}']}}


def token(home, create=False):
    path = Path(home) / TOKEN_NAME
    if create:
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, 'w') as output:
                output.write(secrets.token_hex(32))
                output.flush()
                os.fsync(output.fileno())
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd) as source:
        info = os.fstat(source.fileno())
        value = source.read(65)
        if (not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077
                or info.st_uid != os.geteuid() or not re.fullmatch('[a-f0-9]{64}', value)):
            raise RuntimeError('invalid retained interface credential')
    return value


if __name__ == '__main__':
    import subprocess
    import sys
    args = sys.argv[1:]
    if args != ['devices', 'list'] and not (len(args) == 3 and args[:2] == ['devices', 'approve'] and re.fullmatch('[A-Za-z0-9][A-Za-z0-9_-]*', args[2])):
        raise SystemExit('usage: interfaces.py devices list | devices approve REQUEST_ID')
    home = Path('/sandbox/.openclaw')
    env = dict(os.environ, NEMOCLAW_INTERFACE_TOKEN=token(home), OPENCLAW_GATEWAY_TOKEN=token(home),
               OPENCLAW_CONFIG_PATH=str(home / 'openclaw.json'), OPENCLAW_STATE_DIR=str(home), OPENCLAW_HOME='/sandbox')
    raise SystemExit(subprocess.run(['/usr/local/bin/node', '/app/openclaw.mjs', *args], env=env).returncode)
