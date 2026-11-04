<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent: Deep Agents Code

`AGENT=deepagents-code`, harness `nvidia.fabric.langchain.deepagents-code`, image target `deepagents-code`.
The adapter runs LangChain's `dcode` over ACP in the sandbox, and can write a launcher for `dcode`'s terminal UI.

## Proven Pairs

| Target | Inference source | Features | Revision | Date |
|---|---|---|---|---|
| dgx-spark | existing endpoint | deploy-and-answer, export-reapply, exposure-change, [deepagents-code-terminal](../features/deepagents-code-terminal.md) | `7cc29a4a3e` | 2026-11-02 |

## YAML Edits

The target names no Deep Agents Code example; start from the target's `deepagents` example and change it:

```sh
EXAMPLE=examples/gtc-dc/deepagents-dgx-spark.yaml
```

After the skill's and the target's edits:

```sh
python3 - "$RUN_DIR/deployment.yaml" <<'PY'
import sys, yaml
path = sys.argv[1]
doc = yaml.safe_load(open(path))
sandbox = doc["spec"]["sandboxes"]["assistant"]
sandbox["harness"] = {
    "kind": "nvidia.fabric.langchain.deepagents-code",
    "settings": {"approval_mode": "auto", "interfaces": {"terminal": {}}},
}
sandbox["agent"]["inference"]["routes"][0]["overrides"].pop("maxTokens", None)
yaml.safe_dump(doc, open(path, "w"), sort_keys=False)
PY
```

- `approval_mode` is required: `auto` lets `dcode`'s classifier review gated actions during invocations; `yolo` allows them all.
- The adapter accepts only `models` and `models.base_url` from the public Fabric configuration, so the route's `maxTokens` and the harness's `execution.timeoutSeconds` must go: plan accepts them, and apply fails with `validation_failed`.

Check what the image's adapter accepts before adding fields:

```sh
docker image inspect "nc-fabric:deepagents-code" --format '{{index .Config.Labels "io.nemoclaw.fabric.catalog"}}' | jq -c '.adapters[] | select(.descriptor.adapter_id == "nvidia.fabric.langchain.deepagents-code") | .descriptor | {accepts: .config.accepts, settings: (.settings_schema.properties | keys), interfaces: (.settings_schema.properties.interfaces.properties | keys)}'
```

Result: `accepts` lists `models` and `models.base_url`; `settings` includes `approval_mode` and `interfaces`; `interfaces` is `["terminal"]`.

## Readiness

[deploy-and-answer](../features/deploy-and-answer.md)'s request returns the reply in `result.output.response`.

## Extra Features

- [deepagents-code-terminal](../features/deepagents-code-terminal.md): `dcode`'s terminal UI through the `Open` command apply prints.

## Known Gaps

- **No sign-in.** OpenShell's access control is the only authentication: anyone who can run `openshell sandbox exec` in the workspace can open the terminal UI ([docs/interfaces.md](../../../../docs/agents-inference/interfaces.md#who-can-use-an-interface)).
- **Unauthenticated agent server.** While the terminal UI runs, its own agent server listens on loopback in the sandbox without authentication; don't forward or expose it.
- **Late validation.** A public Fabric field the adapter doesn't accept passes plan and fails at apply ([#13319](https://github.com/NVIDIA/NemoClaw/issues/13319)); the plan's "capabilities are unverified" line doesn't say which.
