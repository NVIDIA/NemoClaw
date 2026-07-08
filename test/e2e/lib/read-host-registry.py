#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Read the NemoClaw host-side sandbox registry and emit provider/model JSON.

SOURCE_OF_TRUTH_REVIEW (Phase 7 / #5343 differing-providers):

- Source boundary: ``~/.nemoclaw/sandboxes.json`` written by every
  ``nemoclaw onboard`` / ``nemoclaw inference-set``. This file is the only
  host-side record of which provider and model each sandbox was configured
  with; the in-sandbox OpenClaw config flattens every managed route to
  ``providerKey="inference"`` via ``patchOpenClawInferenceConfig`` and is
  therefore insufficient to distinguish "sandbox A on NVIDIA Cloud" from
  "sandbox B on Ollama-local" — that is what makes Phase 7's
  differing-providers assertion meaningful.
- Invalid state: the registry file is missing, unreadable, malformed JSON,
  or has no entry for the named sandbox.
- Source-fix constraint: this script never writes to the registry; it only
  reads. Anything else that needs provider/model intent must come through
  this single reader so a schema drift in the host registry surfaces in
  one place.
- Regression test: ``test/ollama-pinned-install.test.ts`` covers the
  shell-side caller; the in-sandbox effective route uses a separate reader
  (``read-openclaw-route.py``) that runs inside the sandbox itself.
- Removal condition: when NemoClaw exposes a stable read-only API for
  per-sandbox effective inference metadata, this reader becomes a wrapper
  around that API and the JSON-on-disk path is dropped.

Exit codes: 0 on success; 2 if the registry file is unreadable or invalid;
3 if the named sandbox is not registered (fail-closed for Phase 7's
two-sandbox contract).
"""

import json
import os
import sys


def main() -> int:
    sandbox_name = sys.argv[1]
    registry_file = os.path.join(
        os.environ.get("HOME", "/tmp"),
        ".nemoclaw",
        "sandboxes.json",
    )
    try:
        with open(registry_file, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError) as exc:
        sys.stderr.write(f"registry-read-failed: {exc}\n")
        return 2

    entries = data.get("sandboxes") or {}
    if sandbox_name not in entries:
        sys.stderr.write(
            f"registry-missing-sandbox: {sandbox_name!r} not registered in {registry_file}\n",
        )
        return 3
    entry = entries.get(sandbox_name) or {}
    provider = str(entry.get("provider") or "").strip()
    model = str(entry.get("model") or "").strip()
    print(json.dumps({"provider": provider, "model": model}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
