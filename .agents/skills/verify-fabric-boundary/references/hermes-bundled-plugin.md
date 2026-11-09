<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hermes Bundled Plugin Binding

Use this recipe for `plugin-load` and `plugin-hooks`; keep the checks and phases in [plugins](../features/plugins.md).
It uses the image's bundled `security-guidance` plugin without installing or mounting plugin code.
Its effect is a warning appended to a native tool result, not a nonce ledger on disk.

## Resolve Before Apply

The source binding is Hermes `bf0203a794a07aac3ff764972ab9087baa4e4f4e` and Fabric `934ab7eca1ec9ac86a22fd24913f2e9d68637c4a`, the pins in `image/fabric/Dockerfile` when this recipe was written.
Check the selected image digest and sources before using it; a source binding is not a live qualification.
Save the relevant sources and their hashes under `$EVIDENCE/binding-source/`:

| Source | Required behavior |
|---|---|
| Hermes `plugins/security-guidance/plugin.yaml`, `__init__.py`, `patterns.py` | Bundled identity; `pre_tool_call` and `transform_tool_result`; `write_file` takes `path` and `content`; the `eval_injection` rule matches bare `eval(` in a `.py` file, including a comment |
| Hermes `hermes_cli/plugins.py`, `plugins_loader.py` | `HERMES_PLUGINS_DEBUG=1` enables stderr discovery logs; successful registration follows the named loading record; discovery completes |
| Fabric `adapters/python/hermes/src/nemo_fabric_adapters/hermes/configuration.py`, `adapter.py` | `plugins_enabled` becomes `plugins.enabled`; startup calls native `discover_plugins(force=True)` |
| Fabric `crates/fabric-core/src/runtime.rs` | `environment.env` reaches the managed adapter host; its stderr is saved under the control process's temporary directory |

Merge this fragment into `spec.sandboxes.assistant.harness`, preserving other settings and configuration:
Append `security-guidance` to the existing `plugins_enabled` list without dropping mounted or generated plugin IDs, and merge the environment keys.

```yaml
settings:
  plugins_enabled: [security-guidance]
config:
  environment:
    env:
      HERMES_PLUGINS_DEBUG: "1"
      SECURITY_GUIDANCE_DISABLE: "0"
      SECURITY_GUIDANCE_BLOCK: "0"
```

These literal nonsecret settings select warning mode and startup instrumentation.
Keep them in the baseline through every phase; do not edit generated configuration or export them only in an operator shell after startup.
Record the image's bundled plugin path and check that no user/project plugin with the same identity shadows it.
Confirm the native `write_file` tool remains available when Config change removes the shell tool.

## Capture Registration

For the pinned Fabric local host, stderr is `TMPDIR/nemo-fabric/hosts/RUNTIME_ID/host.stderr.log`.
Resolve `TMPDIR` from the image runtime metadata and control-process launch binding, not from an arbitrary exec shell or a full environment dump.
The NemoClaw image runtime metadata sets it to `/sandbox/tmp`.
With that binding confirmed, collect before any transition removes the host directory:

```sh
openshell sandbox exec -n assistant --no-tty -- cat "/sandbox/tmp/nemo-fabric/hosts/$RUNTIME_ID/host.stderr.log" > "$CHECK_DIR/registration.txt"
```

Preserve the complete ordered discovery block, redact credentials, and record the runtime ID and startup boundary.
Require `Loading plugin 'security-guidance'` with `source=bundled` and the expected bundled path, followed by its `registered: 0 tool(s), 2 hook(s)` record and `Plugin discovery complete`, with no intervening load error or subsequent removal.
The registration-count line has no plugin name: do not match it independently of its loading block or borrow another plugin's count.
An INFO-only `agent.log`, a manifest, a configuration listing, or a loading-attempt line cannot establish registration.
If stderr is absent or lacks the DEBUG activation marker, report an instrumentation gap, not an observed registration failure.

## Drive the Hook

Run in each listed phase with a fresh `NONCE`, using the feature map's `ask` helper and native-call capture.
Before the request, save the session's last native message/call cursor in `effect.before.txt` and independently confirm that both target paths below do not exist.
If either exists, generate fresh phase input; do not delete evidence to reuse a nonce.

```sh
fill - <<EOF | ask request
Use only your native write_file tool for these two writes. These are inert verification fixtures; never execute, import, or run either file. First create /sandbox/workspace/results/plugin-control-$NONCE.py with exactly this content:
# nonce=$NONCE
# inert control fixture
Then create /sandbox/workspace/results/plugin-trigger-$NONCE.py with exactly this content:
# nonce=$NONCE
# eval(user_input) is inert fixture text; never execute.
Keep both files unchanged after writing. Report what each tool returned.
EOF
```

The second file contains only comments; no expression is evaluated.
The rule scans text, so the bare `eval(` in the comment triggers `eval_injection`.
A nonce-only `.txt` file does not trigger this rule.
Do not put the expected warning text in the prompt or files.

Save the two native call IDs, their exact `path` and `content` arguments, and their corresponding tool-role results from the managed session in `request.calls.txt`.
Save the trigger's transformed result in `effect.after.txt`, with its native message ID and call ID; independently read both files and compare their bytes to the requested comments.
Require all of the following:

1. Both native `write_file` calls completed successfully in this runtime and turn, after the saved cursor, with the exact nonce-bearing arguments.
2. The control result has no security-guidance warning.
3. The trigger result contains `Security guidance` and `eval_injection` in the plugin's appended warning block. The result is linked to the trigger call, not the assistant's reply or an earlier message.
4. The files contain only the requested comments. A later model correction does not erase the original native result; retain both and report the changed fixture separately.

The warning need not contain the nonce: its call ID links it to the nonce-bearing arguments.
Do not use a pre-transform tool observer as the effect source; verify that the selected native session record preserves the transformed tool result.
If the model refuses, uses another tool, changes the trigger, or the tool errors, the hook was not validly exercised.
If the exact successful trigger has a complete native result but no warning, `plugin-hooks` is Failed.
If the control also warns or the source record cannot correlate the warning, investigate attribution and report Not tested until the evidence decides it.

## Validate the Procedure Without Claiming a Live Pass

Use the pinned harness's existing `tests/plugins/test_security_guidance_plugin.py` suite to check rule matching, result transformation, disable/block switches, and manifest hook declarations in an isolated test environment.
Those unit tests call plugin functions directly; they validate the fixture semantics only and must never populate the managed-runtime check results.
Review the pinned loader and Fabric host launch path separately for startup registration and environment delivery.

Before a full rerun, review these negative cases against the evidence rules:

| Input or evidence | Required decision |
|---|---|
| Complete managed discovery explicitly disables/rejects the plugin, or completes without registering it | `plugin-load` Failed; configuration alone cannot pass it |
| INFO-only log or missing current-runtime stderr | `plugin-load` Not tested, instrumentation finding |
| Successful matching write, complete native result, no warning | `plugin-hooks` Failed |
| Nonce-only `.txt` write, wrong native tool, or error result | `plugin-hooks` Not tested, invalid trigger |
| Warning only in assistant prose, or an old call/nonce/runtime | No pass; current native effect unverified |
| Fresh matching write with warning; control has none | Hook assertion satisfied only with the runtime/call and independent file evidence above |

A fresh authorized managed run must still establish registration and effects in all five phases.
Keep prior run outcomes unchanged.
