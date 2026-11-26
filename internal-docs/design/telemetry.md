<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Telemetry Design

The `nemoclaw` CLI sends one flat record when a command that changes a deployment or its configuration finishes.
This page defines that record: when it is sent, every field with its values and source, and what is never sent.
[Usage telemetry](../../docs/security/security.md#usage-telemetry) tells users what is sent and how to turn it off.

## Goals

The record has these goals:

- Send only the fields that the product questions in [Parameters](#parameters) need.
- Count unique installs, not only commands.
- Send nothing from CI, and label QA runs and source builds so that reports can exclude them.
- Let the record change without breaking the queries and charts that read it.

## When a Record Is Sent

The CLI sends one record when one of these commands finishes:

- `apply`
- `destroy`
- `onboard`, only when it writes the configuration

`plan` and `export` send nothing.
No separate install or upgrade event exists.
The `firstRun` and `previousVersion` fields, which come from the [install ID file](#install-id-file), carry that information.

The CLI sends nothing in these cases:

- `NEMOCLAW_DISABLE_TELEMETRY` is set.
- One of these CI variables is set: `CI`, `GITHUB_ACTIONS`, `TF_BUILD`, `BUILD_ID`, `TEAMCITY_VERSION`, `CODEBUILD_BUILD_ID`.
- `NEMOCLAW_TELEMETRY_TEST_LABEL` is set but is not a valid test label (refer to [Field Rules](#field-rules)).
- The sender is a unit-test build (`cfg(test)`).
  Tests that run the built CLI set `NEMOCLAW_DISABLE_TELEMETRY=1` or a loopback endpoint through the shared test helper, and a guard test proves that the test suite posts nowhere else.

`NEMOCLAW_DISABLE_TELEMETRY` and the CI variables count as set when they are present, not empty, and not `false` or `0` in any letter case.
For example, `NEMOCLAW_DISABLE_TELEMETRY=1`, `NEMOCLAW_DISABLE_TELEMETRY=yes`, `NEMOCLAW_DISABLE_TELEMETRY=TRUE`, `CI=true`, and `BUILD_ID=8812` stop the record; `NEMOCLAW_DISABLE_TELEMETRY=false` and `CI=0` do not.
Someone who sets the off switch wants telemetry off, so any other value, including a typo, turns it off.

Telemetry is on by default, and the CLI does not prompt for consent.

The sender makes one HTTP POST request with a 3-second timeout.
It ignores every send error and never changes the command's output or exit code.
It never retries, and in particular never retries after an HTTP 400, because the collector can store a record and still answer 400.
It posts only to the fixed collector endpoint, `https://events.telemetry.data.nvidia.com/v1.1/events/json`, which is a constant in the sender and the same endpoint NemoClaw v0 uses.
For tests, `NEMOCLAW_TELEMETRY_ENDPOINT` can point the sender at a local receiver.
The sender honors it only when it is `http://127.0.0.1:<port>` or `http://[::1]:<port>` and ignores any other value.

## Envelope

Each record has these envelope keys:

| Key | Value | Source |
|---|---|---|
| Event name | `nemoclaw_deployment_finished` | Constant |
| `clientId` | `2247027956751513` | Constant |
| `eventSchemaVer` | `5.0` | Constant |
| `eventSysVer` | `nemoclaw-telemetry/5.0` | Constant |
| `eventProtocol` | `1.6` | Constant |
| `clientVer` | The `version` value | Bundle version stamp |
| `clientVariant` | `Release` | Constant |
| `deviceOS` | The `os` value in the collector's spelling: `linux` is `Linux`, `macos` is `MacOS`, `windows` is `Windows`, and `other` is `undefined` | Command host |
| `cpuArchitecture` | The `arch` value | Command host |
| `deviceId` | Always `undefined`; the collector refuses device details for this anonymous record, and `installId` carries the install ID | Constant |
| Other identity keys | The collector's placeholder; the TEST signup, [#14676](https://github.com/NVIDIA/NemoClaw/issues/14676), records the collector's list of these keys | Constant |

## Parameters

All parameters are top-level keys.
Every parameter is present in every record.
The Purpose column names the product question that each field answers.

| Field | Type | Values | Source | Purpose |
|---|---|---|---|---|
| `nvidiaSource` | String | `nemoclaw` | Constant | Which product sent the record? |
| `installId` | String | Lowercase random UUID (v4), or `unknown` | Install ID file; refer to [Install ID File](#install-id-file) | How many unique installs are there? |
| `firstRun` | Boolean | `true` or `false` | `true` only when this run created the install ID file | How many new installs are there? |
| `testLabel` | String | Empty, or `qa-<run>:<case>:attempt-<n>` | `NEMOCLAW_TELEMETRY_TEST_LABEL` | Is the record from a QA run rather than other use? |
| `buildKind` | String | `release`, `dev`, or `other` | Bundle version stamp; a build from a commit that is not exactly a release tag, or that has local changes, is stamped and sent as `dev` | Is the record from a release or a source build? |
| `version` | String | For example, `1.0.0-412`; up to 128 characters | Bundle version stamp (`NEMOCLAW_BUNDLE_VERSION` at build time) | Which versions are in use? |
| `previousVersion` | String | A version, `none`, or `unknown`; up to 128 characters; refer to [Field Rules](#field-rules) | Install ID file: the version of the last run that sent a record if it differs from `version`, otherwise `none` | Which upgrade paths do users take? |
| `operation` | String | `onboard`, `apply`, `destroy`, or `other` | The command | Which commands run, and how often? |
| `outcome` | String | `succeeded`, `failed`, `cancelled`, or `other` | The command result | Do commands succeed? |
| `effect` | String | `initial`, `update`, `none`, `teardown`, `authored`, or `other` | `OperationResult.changes`; `authored` for `onboard` | Does a run create, update, or tear down a deployment? |
| `failureStage` | String | `none`, `validate`, `initialize`, `plan`, `apply`, `finish`, `destroy`, or `other` | The last progress event before the failure; refer to [Field Rules](#field-rules) | Where do commands fail? |
| `durationMs` | Integer | Milliseconds, 0 or more | Progress events | How long do commands take? |
| `os` | String | `linux`, `macos`, `windows`, or `other` | `std::env::consts::OS` | Which operating systems must be supported and tested? |
| `arch` | String | `x86_64`, `arm64`, or `other` | `std::env::consts::ARCH`; `aarch64` is sent as `arm64` | Which chip architectures must be supported and tested? |
| `hostContext` | String | `native`, `wsl`, `other`, or `unknown` | Kernel release string; `unknown` when it cannot be read | Does NemoClaw run natively or under WSL? |
| `deploymentSource` | String | `brev`, `omnistation`, `colossus`, `none`, or `other` | Image marker; refer to [Deployment Source Marker](#deployment-source-marker) | Which NVIDIA platform image does NemoClaw run on? |
| `cloud` | String | `gcp`, `azure`, `aws`, `none`, `other`, or `unknown` | DMI vendor string; refer to [Field Rules](#field-rules) | Which cloud does NemoClaw run on? |
| `hardware` | String | `dgx-spark`, `dgx-station`, `rtx-spark`, `jetson`, `mac`, `nvidia-gpu`, `other`, or `unknown` | DMI product name and devicetree | Which machines run NemoClaw? |
| `harnesses` | List of strings | Fabric catalog harness IDs, else `other`; each up to 64 characters | Configuration | Which agent harnesses are used? |
| `models` | List of strings | Model names as written, or `unknown`; refer to [Field Rules](#field-rules) | Configuration, default route of each sandbox | Which model families are used? |
| `inferenceHosts` | List of strings | `local`, `build.nvidia.com`, `inference.nvidia.com`, `openai`, `anthropic`, or `other` | Configuration endpoint host, matched on the machine | Is inference local or hosted, and from which provider? |
| `computeDriver` | String | `docker`, `podman`, `kubernetes`, `openshift`, `other`, or `unknown` | Configuration | Which runtime runs the sandboxes? |
| `sandboxCount` | Integer | 0 or more | Configuration | How large are deployments? |
| `agentCount` | Integer | 0 or more | Configuration | How large are deployments? |
| `webSearch` | String | `brave`, `tavily`, `none`, `other`, or `unknown` | Configuration | Which optional features are used? |
| `mcpConfigured` | Boolean | `true` or `false` | Configuration | Which optional features are used? |

## Field Rules

- For `models`, the sender sends each name as written, up to 64 characters.
  A name that could hold a path or an address is sent as `unknown`: one that contains `://`, `\`, or `@`, starts with `/`, `~`, or `.`, or whose part before the first `/` is an IP address or a `host:port`, or one longer than 64 characters.
  For example, `/home/alice/llama-3-8b` and `10.0.0.5:8000/llama` are `unknown`, and `meta/llama-3.1-8b-instruct` and `llama3.1:8b` are sent as written.
  Only the default route of each sandbox is read.
- For `previousVersion`, a stored version that does not look like a version (digits and dots, with an optional part after `-` or `+` made of letters, digits, `.`, `-`, and `+`) is sent as `unknown`.
- For `testLabel`, a valid label matches `^qa-[a-z0-9][a-z0-9-]{0,31}:[a-z0-9][a-z0-9-]{0,39}:attempt-[1-9][0-9]{0,2}$`, the same rule NemoClaw v0 uses.
  `<run>` is 1 to 32 characters and `<case>` is 1 to 40, each made of lowercase letters, digits, and `-`.
  `<n>` is 1 to 999.
  For example, `qa-1120a:onboard-hermes:attempt-2` is valid, and a label that holds a path is not.
- For `harnesses`, the sender sends an ID in the bundled Fabric catalog as written and sends any other ID as `other`.
  An ID is up to 64 characters.
- Harness IDs have no format rule beyond their length.
- For `inferenceHosts`, the sender matches the endpoint host on the machine and sends the matched word, never the address.
  An unmatched host is `other`.
- For `effect`, the sender reads the OpenTofu actions in `OperationResult.changes` (`create`, `update`, `delete`, `read`, or `no-op`).
  A replace shows as `delete` and `create`.
  The sender maps them to one word:

  | Command | Changes | `effect` |
  |---|---|---|
  | `apply` | Every change is `no-op` or `read` | `none` |
  | `apply` | Every change is `create` only | `initial` |
  | `apply` | Any other set of changes | `update` |
  | `destroy` | Any | `teardown` |
  | `onboard` | Not read, because `onboard` wrote the configuration | `authored` |
  | `apply` or `destroy` that fails or is cancelled | None returned | `other` |
- For `failureStage`, the sender uses the last progress event that the command emitted before it failed:

  | Last event | `failureStage` |
  |---|---|
  | None | `validate` |
  | `Validating` (OpenTofu `init` is running) | `initialize` |
  | `Planning` | `plan` |
  | `Applying` | `apply` |
  | `Readiness` | `finish` |
  | `Destroying` | `destroy` |

  A command that succeeds sends `none`.
  `onboard` always sends `none`, because it sends a record only after it writes the configuration.
- For `cloud`, `none` means the machine is not in a cloud, `other` means a cloud that is not on the list, and `unknown` means the vendor string cannot be read.
- `deploymentSource` and `cloud` are independent.
  For example, a Brev machine on GCP sends `brev` and `gcp`.
- For `destroy`, the configuration fields come from the saved document `<state-dir>/intent.json`.
- If the sender cannot read the configuration, for example when `apply` fails at `validate` or `intent.json` is missing on `destroy`, it sends these values:
  - `computeDriver` and `webSearch`: `unknown`
  - `harnesses`, `models`, and `inferenceHosts`: empty lists
  - `sandboxCount` and `agentCount`: `0`
  - `mcpConfigured`: `false`

  Configuration charts must leave out records where `computeDriver` is `unknown`.

## Deployment Source Marker

`deploymentSource` reads a marker that the machine image sets.
NemoClaw does not detect the platform itself.

| Value | Meaning |
|---|---|
| `brev`, `omnistation`, `colossus` | The marker holds that value |
| `none` | No marker is present, or the marker cannot be read or is malformed |
| `other` | The marker holds a well-formed value that is not on the list |

A host without a valid marker is never counted as Brev.
The image owners must set the marker.
For Brev, the owners of the [brevdev/nemoclaw-image](https://github.com/brevdev/nemoclaw-image) repository set it.

The marker is the file `/etc/nemoclaw/deployment-source`.
It holds one word on one line, such as `brev`.
A well-formed word is up to 32 lowercase letters, digits, and `-`, starting with a letter.

## Record Rules

- Every closed list of words has `other`.
  Unknown input never produces free text.
  The only free text in the record is the model names, the test label, the version, and the previous version.
- A value the sender cannot read is sent as `unknown`.
  No field has a separate status field.
  These are the exceptions: `os` and `arch` are fixed at build time and send `other` for an unlisted value, `deploymentSource` sends `none`, and an unread configuration sends the values in [Field Rules](#field-rules).
- For `harnesses`, `models`, and `inferenceHosts`, the sender first replaces each value as the field rules say (with `other` or `unknown`), then removes duplicates, then sorts the list.
  The collector does not enforce unique list items, so the sender must.
  The collector stores each list item as a separate value, so each value can be counted.
  An empty list stays empty; the collector then stores no value for that field.
- Changes are additive only.
  A 5.x minor version can add fields.
  It never renames a field, removes a field, or changes a field's meaning.
- Version 5.0 has no messaging or tool fields.
  A later 5.x minor version is planned to add them.
- The record does not cover people who run OpenTofu directly without the `nemoclaw` CLI.

## Never Sent

The record never carries any of these:

- Deployment, sandbox, service, agent, user, or host names
- File paths
- URLs and endpoint addresses
- IP addresses and resource addresses
- Image names
- Credentials, keys, and tokens
- Prompts
- Error text

## Install ID File

The sender keeps `telemetry.json` in a `nemoclaw` directory under the user configuration directory of the operating system:

| OS | Directory |
|---|---|
| Linux | `$XDG_CONFIG_HOME/nemoclaw`, or `~/.config/nemoclaw` when `XDG_CONFIG_HOME` is not set |
| macOS | `~/Library/Application Support/nemoclaw` |
| Windows | `%APPDATA%\nemoclaw` |

The file is per user, not per deployment, so it is never in the `--state-dir` directory.
The file holds these values:

- The install ID, a random UUID created on first run and not derived from the machine
- The version of the last run that sent a record

Deleting the file creates a new install ID on the next run.

If the file is missing or invalid and the directory is writable, the sender writes a fresh lowercase UUID (v4) and sends `firstRun: true`.
If the file cannot be written, the sender sends `installId: unknown` and `firstRun: false`.
Unique-install counts leave out `unknown`.

## OpenShell Telemetry

The OpenShell gateway that NemoClaw manages has its own telemetry, separate from this record.
When NemoClaw manages the gateway, the gateway's telemetry follows NemoClaw's: it is off when `NEMOCLAW_DISABLE_TELEMETRY` or one of the CI variables above is set, by the same rule as for the record, and on otherwise.
NemoClaw sets `OPENSHELL_TELEMETRY_ENABLED` for Docker and Podman, and `server.telemetryEnabled` on Kubernetes.
NemoClaw decides the setting when it plans the deployment and records it with the gateway, so the provider never reads the caller's environment for it.
A plan run with the other switch value replaces a Docker or Podman gateway, keeping its storage, and upgrades a Kubernetes gateway's release; it never reports the gateway as drifted.
A gateway recorded before NemoClaw set it keeps whatever setting its container has until such a plan replaces it.
NemoClaw leaves an external gateway's telemetry alone.
The OpenShell library inside the CLI is built without telemetry.

## NemoClaw v0 Schema

NemoClaw v0 sends schema 4.x under the same client ID.
This record is schema 5.0.
The two schemas run side by side under that client ID.
