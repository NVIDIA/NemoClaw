// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { describe, it } from "vitest";

import {
  createOnboardProcessWorkspace,
  runOnboardProcess,
  trailingJsonPayload,
  workspaceEnv,
} from "../helpers/onboard-child-process-harness";
import { testTimeoutOptions } from "../helpers/timeouts";

const REPO_ROOT = path.join(import.meta.dirname, "../..");

describe("recovered NVIDIA model onboarding", () => {
  it(
    "replaces a retired model before production validation (#11364)",
    testTimeoutOptions(90_000),
    () => {
      const retiredModel = "minimaxai/minimax-m3";
      const replacement = "nvidia/nemotron-3-super-120b-a12b";
      const workspace = createOnboardProcessWorkspace("nemoclaw-retired-model-", {
        separateHome: true,
      });
      const scriptPath = workspace.path("retired-model.cjs");
      const payloadLogPath = workspace.path("curl-payloads.log");
      const onboardPath = JSON.stringify(path.join(REPO_ROOT, "src", "lib", "onboard.ts"));
      const registryPath = JSON.stringify(
        path.join(REPO_ROOT, "src", "lib", "state", "registry.ts"),
      );

      workspace.writeExecutable("openshell", "#!/usr/bin/env bash\nexit 1\n");
      workspace.writeExecutable(
        "curl",
        `#!/usr/bin/env bash
outfile=""
url=""
printf '%s\\n' "$*" >> "$NEMOCLAW_TEST_CURL_PAYLOADS"
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    --config)
      cat "$2" >> "$NEMOCLAW_TEST_CURL_PAYLOADS"
      shift 2
      ;;
    --data|--data-raw|--data-binary)
      printf '%s\\n' "$2" >> "$NEMOCLAW_TEST_CURL_PAYLOADS"
      shift 2
      ;;
    http://*|https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
if echo "$url" | grep -q '/models'; then
  body='{"data":[{"id":"${replacement}"}]}'
else
  body='{"id":"chatcmpl-retired-model-regression"}'
fi
if [ -n "$outfile" ]; then printf '%s' "$body" > "$outfile"; fi
printf '200'
`,
      );
      fs.writeFileSync(
        scriptPath,
        String.raw`
process.env.NEMOCLAW_NON_INTERACTIVE = "1";
process.env.NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE = "1";
process.env.NEMOCLAW_TEST_NO_SLEEP = "1";
process.env.NVIDIA_INFERENCE_API_KEY = "nvapi-test";
delete process.env.NEMOCLAW_MODEL;
delete process.env.NEMOCLAW_PROVIDER;
delete process.env.VITEST;

const registry = require(${registryPath});
registry.registerSandbox({
  name: "alpha",
  provider: "nvidia-prod",
  model: ${JSON.stringify(retiredModel)},
  endpointUrl: "https://integrate.api.nvidia.com/v1",
  endpointSource: "onboard",
  credentialEnv: "NVIDIA_INFERENCE_API_KEY",
  preferredInferenceApi: "openai-completions",
});
const { setupNim } = require(${onboardPath});

setupNim(null, "alpha", null)
  .then((result) => console.log(JSON.stringify(result)))
  .catch((error) => {
    console.error(error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
  });
`,
      );

      try {
        const result = runOnboardProcess([scriptPath], {
          env: workspaceEnv(workspace, {
            NEMOCLAW_TEST_CURL_PAYLOADS: payloadLogPath,
            NO_COLOR: "1",
            VITEST: "false",
          }),
          timeoutMs: 80_000,
        });
        assert.equal(result.status, 0, result.output);
        const selected = trailingJsonPayload<{ model: string }>(result.stdout);
        assert.notEqual(selected.model, retiredModel);

        assert.ok(fs.existsSync(payloadLogPath), result.output);
        const validationPayloads = fs.readFileSync(payloadLogPath, "utf8");
        assert.match(validationPayloads, new RegExp(selected.model.replaceAll("/", "\\/"), "u"));
        assert.doesNotMatch(
          validationPayloads,
          new RegExp(retiredModel.replaceAll("/", "\\/"), "u"),
        );
        assert.match(result.output, /recovered NVIDIA model .* is retired; using/u);
      } finally {
        workspace.remove();
      }
    },
  );
});
