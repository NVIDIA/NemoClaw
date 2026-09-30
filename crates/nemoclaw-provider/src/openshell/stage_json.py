# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Stage a bounded JSON file for a subsequent fabric-agent command."""

import os
import sys

payload = sys.stdin.buffer.read(512 * 1024 + 1)
if len(payload) > 512 * 1024:
    raise SystemExit(1)
with os.fdopen(os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as staged:
    staged.write(payload)
