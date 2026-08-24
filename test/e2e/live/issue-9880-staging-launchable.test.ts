// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import {
  ISSUE_9880_STAGING_LAUNCHABLE_CLEANUP_TIMEOUT_MS,
  ISSUE_9880_STAGING_LAUNCHABLE_ONBOARD_TIMEOUT_MS,
  ISSUE_9880_STAGING_LAUNCHABLE_SCENARIO_TIMEOUT_MS,
  ISSUE_9880_STAGING_LAUNCHABLE_TEST_TIMEOUT_MS,
} from "../../../tools/e2e/staging-launchable-timeout-contract.mts";
import { BrevLaunchableFixture } from "../fixtures/brev-launchable.ts";
import { resultText } from "../fixtures/clients/command.ts";
import { expect, test } from "../fixtures/e2e-test.ts";

const MODEL = "meta/llama-3.3-70b-instruct";
const PROMPT = "List 10 REST API endpoints for a blog service, one per line";

test(
  "OpenClaw CLI does not loop on a simple text request on the staging Launchable (#9880)",
  {
    timeout: ISSUE_9880_STAGING_LAUNCHABLE_TEST_TIMEOUT_MS,
    meta: {
      e2eCleanupTimeoutMs: ISSUE_9880_STAGING_LAUNCHABLE_CLEANUP_TIMEOUT_MS,
      e2ePhases: [
        "resolve the latest staging handoff",
        "create and verify the issue workspace",
        "onboard the exact issue model",
        "run bounded fresh OpenClaw CLI sessions",
        "record the issue reproduction result",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, secrets }) => {
    const brevLaunchable = new BrevLaunchableFixture({ artifacts, host, secrets });
    const launchableId = secrets.required("BREV_LAUNCHABLE_ID");
    const inferenceKey = secrets.required("NVIDIA_API_KEY");
    const name = `issue-9880-${randomUUID().slice(0, 8)}`;
    const handoff = await brevLaunchable.resolveLatestStagingHandoff();

    progress.phase("create and verify the issue workspace");
    const ownership = brevLaunchable.ownership(name);
    cleanup.add(`delete Brev workspace ${name}`, () => brevLaunchable.delete(ownership));
    const workspace = await brevLaunchable.create(ownership, launchableId);
    await brevLaunchable.waitForExec(ownership);
    await brevLaunchable.verifyIdentity(ownership, handoff);

    progress.phase("onboard the exact issue model");
    const onboard = await brevLaunchable.execScript(
      ownership,
      `#!/usr/bin/env bash
set -euo pipefail
export NVIDIA_INFERENCE_API_KEY=${shellQuote(inferenceKey)}
export NEMOCLAW_MODEL=${shellQuote(MODEL)}
export NEMOCLAW_PROVIDER=build
export NEMOCLAW_AGENT=openclaw
brev-quickstart issue-9880
nemoclaw issue-9880 exec -- node -e '
const fs = require("fs");
const config = JSON.parse(fs.readFileSync("/sandbox/.openclaw/openclaw.json", "utf8"));
const model = config?.agents?.defaults?.model?.primary;
if (model !== "inference/meta/llama-3.3-70b-instruct") {
  console.error("unexpected managed model: " + String(model));
  process.exit(1);
}
'
`,
      {
        artifactName: "issue-9880-onboard",
        captureLimitBytes: 64 * 1024,
        redactionValues: [inferenceKey],
        timeoutMs: ISSUE_9880_STAGING_LAUNCHABLE_ONBOARD_TIMEOUT_MS,
      },
    );
    expect(onboard.exitCode, resultText(onboard)).toBe(0);

    progress.phase("run bounded fresh OpenClaw CLI sessions");
    const scenario = await brevLaunchable.execScript(ownership, scenarioScript(), {
      artifactName: "issue-9880-openclaw-cli-sessions",
      captureLimitBytes: 64 * 1024,
      timeoutMs: ISSUE_9880_STAGING_LAUNCHABLE_SCENARIO_TIMEOUT_MS,
    });
    const classification = classifyScenario(scenario);
    await artifacts.writeJson("issue-9880-result.json", {
      workspaceId: workspace.id,
      producerRunId: handoff.producerRunId,
      candidateSha: handoff.nemoclawSha,
      model: MODEL,
      prompt: PROMPT,
      classification,
      exitCode: scenario.exitCode,
      timedOut: scenario.timedOut,
    });
    progress.phase("record the issue reproduction result");
    await artifacts.target.complete({
      id: "issue-9880-staging-launchable",
      classification,
    });
    expect(classification, resultText(scenario)).toBe("completed-five-trials");
  },
);

function scenarioScript(): string {
  return `#!/usr/bin/env bash
set -euo pipefail
prompt=${shellQuote(PROMPT)}
for attempt in 1 2 3 4 5; do
  session_id="e2e-issue-9880-$(date +%s)-$$-$attempt"
  output="$(mktemp)"
  set +e
  timeout --signal=TERM --kill-after=10s 90s nemoclaw issue-9880 exec -- \
    openclaw agent --agent main --json --thinking off --session-id "$session_id" -m "$prompt" \
    >"$output" 2>&1
  status=$?
  set -e
  python3 - "$output" "$status" <<'PY'
import json
import re
import sys
from pathlib import Path
path, status_text = sys.argv[1:]
status = int(status_text)
text = Path(path).read_text(encoding="utf-8", errors="replace")
invocations = len(re.findall(r"(?i)(invoking tool|tool[_ -]?call|tool_use)", text))
refusals = len(re.findall(r"(?i)(tool call refused|does not exist|unknown tool|tool not found)", text))
strings = []
try:
    root = json.loads(text)
except json.JSONDecodeError:
    strings.append(text)
else:
    def visit(value):
        if isinstance(value, str): strings.append(value)
        elif isinstance(value, list):
            for item in value: visit(item)
        elif isinstance(value, dict):
            for item in value.values(): visit(item)
    visit(root)
lines = "\n".join(strings).splitlines()
endpoints = {line.strip() for line in lines if re.match(r"^\s*(?:\d+[.)]\s*)?(?:GET|POST|PUT|PATCH|DELETE)\s+/\S+", line)}
if invocations >= 2 and refusals >= 2:
    print("ISSUE_9880_CLASSIFICATION=reproduced-tool-loop")
    raise SystemExit(86)
if status == 124:
    print("ISSUE_9880_CLASSIFICATION=inconclusive-timeout")
    raise SystemExit(87)
if status != 0 or len(endpoints) < 10 or invocations != 0 or refusals != 0:
    print("ISSUE_9880_CLASSIFICATION=unexpected")
    raise SystemExit(2)
PY
  rm -f "$output"
done
printf 'ISSUE_9880_CLASSIFICATION=completed-five-trials\n'
`;
}

function classifyScenario(result: { stdout: string; stderr: string; timedOut: boolean }): string {
  const matches = `${result.stdout}\n${result.stderr}`.match(
    /ISSUE_9880_CLASSIFICATION=([a-z0-9-]+)/gu,
  );
  const classified = matches?.at(-1)?.split("=")[1] ?? "missing-classification";
  return result.timedOut ? "controller-timeout" : classified;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
