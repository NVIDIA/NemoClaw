<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Validate a v0 OpenClaw Export with v1

This scenario implements the first checklist item in [NVIDIA/NemoClaw issue #11810](https://github.com/NVIDIA/NemoClaw/issues/11810).
It compares a redacted v0 configuration export with separately authored current intent and validates a new v1 deployment.
It does not run, patch, or inspect the v0 test harness.

The checked-in export is raw output from the public v0 `nemoclaw config export` path aligned by [NVIDIA/NemoClaw issue #11977](https://github.com/NVIDIA/NemoClaw/issues/11977) and merged at revision `b6934c6300c4e1e175757e9281ae3a641d9a5b1f`.
The historical checked-in export uses the obsolete `agents` list and is rejected by the current parser.
The separately authored `v1.yaml` fixture preserves its intent using singular `agent`; deterministic checks verify both rejection and retained intent.
Live verification requires both the raw export and a separately authored current configuration; it does not import the historical export directly.
Updating the fixture is a manual review step: run the public command against a representative supported deployment, inspect the output for credential values, copy the redacted bytes into this repository without reshaping them, and update the separately authored current document in the same change.
The v0 E2E export mechanism is a convenient producer of candidate inputs, not a pipeline dependency of the v1 test.
Source scenario, revision, date, or executable identity may be retained with the fixture as useful audit metadata, but the v1 test does not require or resolve an exact v0 version.

This scenario creates a new v1 deployment.
It does not adopt a v0 deployment or migrate its workspace, conversations, credentials, or runtime state.

## Artifact and Parser Contract

The caller supplies absolute paths to the redacted raw v0 export and a separately authored current v1 configuration.

The runner parses the authored configuration through the ordinary v1 `Document::parse` path.
A test-only comparison replaces the raw export’s single-entry `agents` list with `agent` in memory and checks that its parsed intent equals the authored configuration.
The v1 parser supplies target defaults, including the gateway engine and image, gateway network, and agent image.
Only the separately supplied current document drives deployment; the SDK has no compatibility translator.
This comparison requires one sandbox and one historical agent, and rejects changes to identity, inference, policy, or other portable intent.

The checked-in contract lives under `crates/nemoclaw-e2e/fixtures/openclaw-nvidia-hosted/`:

- `NOTICE.md` records producer revision, refresh date, and artifact handling.
- `v0.yaml` is the unmodified reference manifest with its upstream revision and hash.
- `v0-export.yaml` is the raw representative redacted export from the supported public path.
- `v1.yaml` is the explicitly reauthored current document with the same portable intent.

Run the deterministic checks without Docker or a credential:

```sh
cargo test -p nemoclaw-e2e --test hosted_parity
```

## Live Verification

The live test checks the public deployment operations:

1. Parse the authored v1 YAML and compare it with the raw export's portable intent.
2. Expect the initial plan to create managed gateway storage and the gateway, with OpenShell registration deferred.
3. Expect apply to create those resources plus the provider profile, provider registration, sandbox, and workspace.
4. Expect a subsequent plan to report no changes.
5. Export the configuration, compare it with the input, and expect reapply to report no changes.
6. Expect destroy planning and execution to remove the provider profile, provider registration, sandbox, and gateway while retaining the workspace and gateway storage.

The test reports assertion failures through Cargo and writes no separate report.
Apply checks configuration and readiness without requesting a model response.
Use the [native agent procedure](../../agents.md#run-one-headless-openclaw-request) separately to verify a reply.

## Prerequisites and Ownership

Use an owned native Linux Docker daemon, a fresh deployment UID, available gateway port and subnet, and an unused state-directory path whose parent exists.
Supply the referenced NVIDIA credential through the process environment; never put its value in YAML or command arguments.
The test installs that credential in OpenShell and does not revoke the upstream key.

Preserve the raw export unchanged and author a separate current configuration by replacing its single-entry `agents` list with `agent`.
Both inputs must describe the same owned deployment UID and portable intent.
Keep the fixture's provider name `hosted-nvidia-prod`, sandbox name `assistant`, and agent name `primary`; the expected results name those resources.
Build a matching bundle and make the YAML's immutable gateway and agent images available to the selected Docker daemon.
A GPU is not required because the configuration selects hosted inference.

From the repository root, set absolute paths and run the selected test:

```sh
NEMOCLAW_LIVE_V0_EXPORT=/absolute/private/path/v0-export.yaml \
NEMOCLAW_LIVE_V1_CONFIG=/absolute/private/path/authored-v1.yaml \
NEMOCLAW_LIVE_HOSTED_STATE=/absolute/path/to/new-state \
NEMOCLAW_TEST_BUNDLE=/absolute/path/to/verified-bundle \
  cargo test -p nemoclaw-e2e --test hosted_parity \
  authored_v1_intent_preserves_v0_export_through_hosted_openclaw_lifecycle \
  -- --ignored
```

The test creates the state directory and rejects an existing path.
It does not require a Git revision variable, a clean checkout, an issue acknowledgement, or an ownership-marker file.
Do not run live tests as an ignored-test aggregate.

## Recovery and Cleanup

After a failed apply, keep both inputs, the bundle, and the state directory.
Follow [interrupted-operation recovery](../../usage.md#recover-an-interrupted-operation) with the same v1 YAML and state.
Do not create another state directory for the same deployment UID.

Use [destroy](../../usage.md#destroy) to remove a failed test's owned workloads when appropriate.
Successful test completion already destroys those workloads and retains the workspace and gateway storage.
Retire the upstream NVIDIA key separately when it is no longer needed.
