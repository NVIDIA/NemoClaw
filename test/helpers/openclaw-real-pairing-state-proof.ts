// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

/** Read native OpenClaw's committed approval through the shipped onboarding adapter. */
export function proveRealPairingStateReadable(stateDir: string): void {
  const result = spawnSync(
    "python3",
    [
      "-c",
      `import importlib.util, sys
spec = importlib.util.spec_from_file_location('pairing_state', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
records, _metadata = module.read_openclaw_pairing_state(sys.argv[2])
device_id = records['identity']['deviceId']
paired = records['paired'][device_id]
stored = records['authByDevice'][device_id]['operator']
token = paired['tokens']['operator']
assert token['token'] == stored['token'], 'stored and paired credentials differ'
assert sorted(stored['scopes']) == ['operator.pairing', 'operator.read', 'operator.write']
assert sorted(token['scopes']) == sorted(stored['scopes'])
assert paired['clientId'] == 'cli' and paired['clientMode'] == 'cli'
assert any(pending['deviceId'] == device_id for pending in records['pending'].values())
`,
      path.resolve(import.meta.dirname, "../../scripts/lib/openclaw_pairing_state.py"),
      stateDir,
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (result.status !== 0) {
    throw new Error(`Native OpenClaw pairing state is unreadable: ${result.stderr}`);
  }
}
