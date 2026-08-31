#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Print the external hostname that the loopback-bound Hermes dashboard may
# accept. Status 2 identifies an unset or loopback URL that needs no external
# host. Status 1 identifies an invalid external dashboard URL.
nemoclaw_hermes_dashboard_external_host() {
  local chat_ui_url="${1:-}"
  [ -n "$chat_ui_url" ] || return 2
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
    parsed.scheme.lower() not in {"http", "https"}
    or not parsed.netloc
    or not host
    or parsed.username is not None
    or parsed.password is not None
):
    sys.exit(1)

host = host.lower()
if host.rstrip(".") == "localhost":
    sys.exit(2)
try:
    address = ipaddress.ip_address(host.rstrip("."))
except ValueError:
    pass
else:
    if address.is_loopback:
        sys.exit(2)
    if address.is_unspecified:
        sys.exit(1)

if parsed.scheme.lower() != "https":
    sys.exit(1)

print(host)
PYHOST
}
