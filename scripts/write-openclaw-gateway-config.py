#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Writes/updates OpenClaw gateway and model config (bind, controlUi, trustedProxies, default model).
# Used by nemoclaw-start.sh and by tests. Set OPENCLAW_JSON_PATH to override config path (for tests).

import json
import os
from urllib.parse import urlparse

def main():
    config_path = os.environ.get('OPENCLAW_JSON_PATH')
    if not config_path:
        home = os.environ.get('HOME', '/sandbox')
        config_path = os.path.join(home, '.openclaw', 'openclaw.json')
    os.makedirs(os.path.dirname(config_path), exist_ok=True)

    cfg = {}
    if os.path.exists(config_path):
        try:
            with open(config_path) as f:
                cfg = json.load(f)
        except (json.JSONDecodeError, ValueError):
            cfg = {}

    default_model = os.environ.get('NEMOCLAW_MODEL')
    if default_model:
        cfg.setdefault('agents', {}).setdefault('defaults', {}).setdefault('model', {})['primary'] = default_model

    chat_ui_url = os.environ.get('CHAT_UI_URL', 'http://127.0.0.1:18789')
    parsed = urlparse(chat_ui_url)
    chat_origin = f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme and parsed.netloc else 'http://127.0.0.1:18789'
    local_origin = f'http://127.0.0.1:{os.environ.get("PUBLIC_PORT", "18789")}'
    origins = [local_origin]
    if chat_origin not in origins:
        origins.append(chat_origin)

    gateway = cfg.setdefault('gateway', {})
    gateway['mode'] = 'local'
    gateway['bind'] = os.environ.get('GATEWAY_BIND', 'lan')
    # Sandbox defaults intentionally replace any preexisting controlUi settings.
    gateway['controlUi'] = {
        'allowInsecureAuth': True,
        'dangerouslyDisableDeviceAuth': True,
        'allowedOrigins': origins,
    }
    gateway['trustedProxies'] = ['127.0.0.1', '::1']

    with open(config_path, 'w') as f:
        json.dump(cfg, f, indent=2)
    os.chmod(config_path, 0o600)

if __name__ == '__main__':
    main()
