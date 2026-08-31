#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Print the external hostname that the loopback-bound Hermes dashboard may
# accept. A nonzero result leaves the dashboard on its default loopback-only
# Host policy.
nemoclaw_hermes_dashboard_external_host() {
  local chat_ui_url="${1:-}"
  [ -n "$chat_ui_url" ] || return 1
  python3 - "$chat_ui_url" <<'PYHOST'
import ipaddress
import sys
from urllib.parse import urlparse

try:
    parsed = urlparse(sys.argv[1])
    host = parsed.hostname
    parsed.port
except ValueError:
    sys.exit(1)

if (
    parsed.scheme.lower() != "https"
    or not parsed.netloc
    or not host
    or parsed.username is not None
    or parsed.password is not None
):
    sys.exit(1)

host = host.lower()
if host.rstrip(".") == "localhost":
    sys.exit(1)
try:
    address = ipaddress.ip_address(host.rstrip("."))
except ValueError:
    pass
else:
    if address.is_loopback or address.is_unspecified:
        sys.exit(1)

print(host)
PYHOST
}
