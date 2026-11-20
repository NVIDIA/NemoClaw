<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Telemetry Design

The `nemoclaw` CLI sends one small, flat record when a command that changes a deployment finishes.
This page defines that record: when it is sent, every field with its values and source, and what is never sent.
The [security guide](../../docs/security/security.md) tells users what is sent and how to turn it off.

## Goals

- Send as much as the product questions need, and no more.
- Count unique installs, not only commands.
- Keep CI, QA, and source builds out of reports.
- Keep the record easy to change without breaking readers.

## When a Record Is Sent

The CLI sends one record when one of these commands finishes:

- `apply`
- `destroy`
- `onboard`, only when it writes the configuration

`plan` and `export` send nothing.
There is no separate install or upgrade event; the install ID file carries that information (see [Install ID File](#install-id-file)).

The CLI sends nothing in these cases:

- `NEMOCLAW_DISABLE_TELEMETRY` is exactly `1`.
- One of these CI variables is set: `CI`, `GITHUB_ACTIONS`, `TF_BUILD`, `BUILD_ID`, `TEAMCITY_VERSION`, `CODEBUILD_BUILD_ID`.
- `NEMOCLAW_TELEMETRY_TEST_LABEL` is set but does not match `qa-<run>:<case>:attempt-N`.
- The process runs under the test suite.

Telemetry is on by default and documented; the CLI does not prompt.

The sender makes one POST with a 3 second limit.
It ignores every send error and never changes the command's output or exit code.
It posts only to the fixed collector endpoint or to a loopback address.

## Envelope

| Key | Value | Source |
|---|---|---|
| Event name | `nemoclaw_deployment_finished` | Constant |
| `clientId` | `2247027956751513` | Constant |
| `eventSchemaVer` | `5.0` | Constant |
| `eventSysVer` | `nemoclaw-telemetry/5.0` | Constant |
| `eventProtocol` | `1.6` | Constant |
| `clientVer` | The `version` value | Bundle version stamp |
| `deviceOS` | The `os` value | Command host |
| `cpuArchitecture` | The `arch` value | Command host |
| `deviceId` | The `installId` value if the collector stores it, else the collector's placeholder | Install ID file |
| Other identity keys | The collector's placeholder | Constant |

## Parameters

All parameters are flat and at the top level.
Every parameter is present in every record.

| Field | Type | Values | Source | Purpose |
|---|---|---|---|---|
| `nvidiaSource` | Word | `nemoclaw` | Constant | Separates NemoClaw records from other products on the shared collector |
| `installId` | Word | Random UUID (v4) | Install ID file, created on first run | Counts unique installs |
| `firstRun` | Boolean | `true` / `false` | `true` only when this run created the install ID file | Counts new installs |
| `testLabel` | Word | Empty, or `qa-<run>:<case>:attempt-N` | `NEMOCLAW_TELEMETRY_TEST_LABEL` | Separates QA runs from real use |
| `buildKind` | Word | `release` / `dev` / `other` | Bundle version stamp; a source build is `dev` | Separates source builds from releases |
| `version` | Word | For example `1.0.0-412` | `NEMOCLAW_BUNDLE_VERSION` | Version adoption |
| `previousVersion` | Word | A version, or `none` | Install ID file: the version of the last run if it differs, else `none` | Upgrade paths |
| `operation` | Word | `onboard` / `apply` / `destroy` / `other` | The command | Create, update, and teardown rhythm |
| `outcome` | Word | `succeeded` / `failed` / `cancelled` / `other` | The command result | Whether setup works |
| `effect` | Word | `initial` / `update` / `none` / `teardown` / `authored` / `other` | `OperationResult.changes`; `authored` for `onboard` | Create, update, and teardown rhythm |
| `failureStage` | Word | `none` / `validate` / `initialize` / `plan` / `apply` / `finish` / `destroy` / `other` | Progress events | Where commands fail |
| `durationMs` | Integer | Milliseconds, 0 or more | Progress events | How long commands take |
| `os` | Word | `linux` / `macos` / `windows` / `other` | `std::env::consts::OS` | Support and test matrix |
| `arch` | Word | `x86_64` / `arm64` / `other` | `std::env::consts::ARCH`; `aarch64` is sent as `arm64` | Support and test matrix |
| `hostContext` | Word | `native` / `wsl` / `other` | Kernel release string | Support and test matrix |
| `deploymentSource` | Word | `brev` / `omnistation` / `colossus` / `none` / `other` | Image marker | Where NemoClaw runs |
| `cloud` | Word | `gcp` / `azure` / `aws` / `other` / `unknown` | DMI vendor string | Where NemoClaw runs |
| `hardware` | Word | `dgx-spark` / `dgx-station` / `rtx-spark` / `jetson` / `mac` / `nvidia-gpu` / `other` / `unknown` | DMI product name and devicetree | Which machines run NemoClaw |
| `harnesses` | List of words | Fabric catalog harness IDs, else `other` | Configuration | Agent harness share |
| `models` | List of free text | Model names as written; see [Field Rules](#field-rules) | Configuration, default route of each sandbox | Model family share |
| `inferenceHosts` | List of words | `local` / `build.nvidia.com` / `inference.nvidia.com` / `openai` / `anthropic` / `other` | Configuration endpoint host, matched on the machine | Local or hosted inference, and which provider |
| `computeDriver` | Word | `docker` / `podman` / `kubernetes` / `openshift` / `other` / `unknown` | Configuration | Which runtime runs the sandboxes |
| `sandboxCount` | Integer | 0 or more | Configuration | Deployment size |
| `agentCount` | Integer | 0 or more | Configuration | Deployment size |
| `webSearch` | Word | `brave` / `tavily` / `none` / `other` / `unknown` | Configuration | Optional feature use |
| `mcpConfigured` | Boolean | `true` / `false` | Configuration | Optional feature use |

## Field Rules

- `models`: a name is sent as written, up to 64 characters.
  A name that contains `://` or is longer than 64 characters is sent as `unknown`.
  Only the default route of each sandbox is read.
- `harnesses`: an ID in the bundled Fabric catalog is sent as written; any other ID is sent as `other`.
- `inferenceHosts`: the sender matches the endpoint host on the machine and sends the matched word, never the address.
  An unmatched host is `other`.
- `effect`: `authored` means `onboard` wrote the configuration; the other words come from the OpenTofu change list.
- `deploymentSource` and `cloud` are independent: a Brev machine on GCP sends `brev` and `gcp`.
- For `destroy`, the configuration fields come from the saved document `<state-dir>/intent.json`.
- If the sender cannot read the configuration, for example when `apply` fails at `validate` or `intent.json` is missing on `destroy`, it sends these values:
  - `computeDriver` and `webSearch`: `unknown`
  - `harnesses`, `models`, and `inferenceHosts`: empty lists
  - `sandboxCount` and `agentCount`: `0`
  - `mcpConfigured`: `false`

  Configuration charts must leave out records where `computeDriver` is `unknown`.

## Record Rules

- Every closed list of words has `other`.
  Unknown input never produces free text.
  The only free text in the record is the model name, the test label, and the version.
- A value the sender cannot read is the word `unknown`; there are no per-field status companions.
- Lists hold plain words, sorted, with no duplicates.
  If the collector does not index lists, each list becomes one value, or `mixed` when the record has more than one distinct value.
- Location is not sent; the collector adds coarse location from the sender's IP address.
- Changes are additive only.
  A 5.x minor version adds fields; it never renames a field, removes a field, or changes a field's meaning.
- Messaging and tools are not in 5.0; a later 5.x minor version adds them.
- The record does not cover people who run OpenTofu directly without the `nemoclaw` CLI.

## Never Sent

The record never carries any of these:

- Names: deployment, sandbox, service, agent, user, or host
- File paths
- URLs and endpoint addresses
- IP addresses and resource addresses
- Image names
- Credentials, keys, and tokens
- Prompts
- Error text

## Install ID File

The sender keeps `telemetry.json` in the user configuration folder.
It holds:

- The install ID, a random UUID created on first run and not derived from the machine
- The version of the last run that sent a record

Deleting the file creates a new install ID on the next run.

## OpenShell Telemetry

The OpenShell gateway that NemoClaw manages has its own telemetry, separate from this record.
Passing NemoClaw's off switch to the managed gateway needs an accepted change to the [accepted scope](scope.md) first.

## Classic Schema

NemoClaw Classic sends schema 4.x under the same client ID; this record is schema 5.0.
If the collector cannot keep both schema lines live, these same fields go into the next 4.x schema, and the field list does not change.
