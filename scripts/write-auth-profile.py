# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import json
import os

path = os.path.expanduser("~/.openclaw/agents/main/agent/auth-profiles.json")
profile = {
    "nvidia:manual": {
        "type": "api_key",
        "provider": "nvidia",
        "keyRef": {"source": "env", "id": "NVIDIA_API_KEY"},
        "profileId": "nvidia:manual",
    }
}
json.dump(profile, open(path, "w"))
os.chmod(path, 0o600)
print(f"Wrote auth profile to {path}")
