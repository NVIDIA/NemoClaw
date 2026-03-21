# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Validate blueprint.yaml profile declarations and base sandbox policy.

Runs as a standalone script in CI (validate-profiles job) and can also be
invoked locally for quick smoke checks:

    python test/validate-blueprint.py
"""

import sys
import yaml

BLUEPRINT_PATH = "nemoclaw-blueprint/blueprint.yaml"
BASE_POLICY_PATH = "nemoclaw-blueprint/policies/openclaw-sandbox.yaml"
REQUIRED_PROFILE_FIELDS = ("provider_type", "endpoint")

errors = []


def check(condition, msg):
    if not condition:
        errors.append(msg)
        print(f"  FAIL  {msg}")
    else:
        print(f"  OK    {msg}")


# ── Blueprint profiles ────────────────────────────────────────────────
bp = yaml.safe_load(open(BLUEPRINT_PATH))
declared = bp.get("profiles", [])
defined = bp.get("components", {}).get("inference", {}).get("profiles", {})

print(f"Declared profiles: {declared}")
print(f"Defined profiles:  {list(defined.keys())}")

for name in declared:
    check(name in defined, f"declared profile '{name}' has a definition")
    if name in defined:
        cfg = defined[name]
        for field in REQUIRED_PROFILE_FIELDS:
            check(field in cfg, f"profile '{name}' has '{field}'")

for name in defined:
    check(name in declared, f"defined profile '{name}' is declared in top-level list")

# ── Base sandbox policy ───────────────────────────────────────────────
policy = yaml.safe_load(open(BASE_POLICY_PATH))
check("version" in policy, "base policy has 'version'")
check("network_policies" in policy, "base policy has 'network_policies'")

# ── Result ────────────────────────────────────────────────────────────
print()
if errors:
    print(f"FAILED — {len(errors)} error(s)")
    sys.exit(1)
else:
    total = len(declared) * (1 + len(REQUIRED_PROFILE_FIELDS)) + len(defined) + 2
    print(f"PASSED — {total} checks OK")
