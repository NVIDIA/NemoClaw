// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { encodeManagedStartupProfile } from "../../../src/lib/onboard/managed-startup/profile.ts";
import {
  createManagedStartupRootApplyRequest,
  serializeManagedStartupRootApplyRequest,
} from "../../../src/lib/onboard/managed-startup/root-apply.ts";
import { createHermesSwitchyardRoutingIntent } from "../../../src/lib/hermes-switchyard-routing.ts";
import { switchyardBindingFixture } from "../../helpers/hermes-switchyard.ts";

const intent = createHermesSwitchyardRoutingIntent({
  efficient: { provider: "nvidia-prod", model: "fixture-efficient" },
  capable: { provider: "openai-api", model: "fixture-capable" },
});

/** Use the same bounded request as the host startup owner, without provider credentials. */
export function hermesCommittedRoutingReplayRequest(): string {
  const profile = managedStartupE2eProfile("hermes", false, false, true);
  return serializeManagedStartupRootApplyRequest(
    createManagedStartupRootApplyRequest({
      agent: "hermes",
      encodedProfile: encodeManagedStartupProfile({
        ...profile,
        agentConfig: {
          agent: "hermes",
          webSearch: { enabled: false, provider: "tavily" },
          switchyardRouting: intent,
          switchyardBindings: switchyardBindingFixture(intent),
        },
      }),
    }),
  );
}

// Full root application commits the profile before corruption. Re-entry must
// reject it before the same launch sequence can invoke the real gateway entrypoint.
export const HERMES_COMMITTED_ROUTING_REPLAY_PROBE = String.raw`
import base64
import hashlib
import json
from pathlib import Path
import socket
import subprocess
import sys

request = base64.b64decode(sys.argv[1]).decode()
runtime = '/usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs'
apply = ['/usr/local/bin/node', runtime, '--apply-root-stdin', '--agent', 'hermes']
subprocess.run(apply, input=request, text=True, check=True, stdout=sys.stderr, timeout=60)
subprocess.run(['/usr/local/bin/node', runtime, '--commit-shared-state-transaction', '--agent', 'hermes'], check=True, stdout=sys.stderr, timeout=30)
root = Path('/usr/local/share/nemoclaw')
target = root / 'hermes-relay-plugins.toml'
target.write_bytes(b'')
paths = [target, root / '.dynamic-plugins.json', root / 'hermes-switchyard-v1.toml']
def snapshot():
    result = []
    for path in paths:
        stat = path.lstat()
        result.append((stat.st_dev, stat.st_ino, stat.st_mode, stat.st_uid, stat.st_gid,
                       stat.st_nlink, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns,
                       hashlib.sha256(path.read_bytes()).hexdigest()))
    return result
before = snapshot()
replay = subprocess.run(['/bin/bash', '-c',
    '/usr/local/bin/node ' + runtime + ' --apply-root-stdin --agent hermes && exec /usr/local/bin/nemoclaw-start'],
    input=request, capture_output=True, text=True, timeout=30)
output = replay.stdout + replay.stderr
ports_closed = []
for port in (18642, 8642):
    with socket.socket() as connection:
        ports_closed.append(connection.connect_ex(('127.0.0.1', port)) != 0)
print(json.dumps({'exitCode': replay.returncode, 'output': output,
                  'gatewayPortsClosed': ports_closed, 'routingStateUnchanged': snapshot() == before}))
`;
