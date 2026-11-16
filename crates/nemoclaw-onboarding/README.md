<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Onboarding

`nemoclaw onboard` asks questions in a terminal and writes a new deployment YAML file.
It never plans or applies, creates no deployment state, and keeps no credential values: the file names the environment variables that hold them.

## Run Onboarding

With the [build prerequisites](../../docs/build-deploy/build.md) installed, run from the repository root:

```sh
cargo run -p nemoclaw-cli -- onboard examples/onboarding/openclaw.yaml --output my-deployment.yaml
```

A built CLI takes the same arguments, as `nemoclaw onboard`.

- **Template:** its values become the suggested answers for a new deployment with a fresh `metadata.uid`; onboarding never edits an existing deployment.
  Any single-sandbox example works as a template; templates with several sandboxes do not.
- **Harnesses:** onboarding offers OpenClaw and Hermes.
  A template that names another harness keeps it as the suggested answer, and the menu adds it for that run.
- **No template:** the suggestions describe a managed Docker gateway running OpenClaw with NVIDIA Endpoints inference.
- **Name:** you choose the agent first; without a name in the template, the deployment's name is suggested from the agent, such as `hermes`.
- **Settings onboarding decides:** it doesn't ask for the inference API of a named vendor such as NVIDIA Endpoints, the engine socket when one engine answered for the chosen runtime, the network tier, or optional agent and model settings.
  The review lists the fields left at their defaults above the YAML, which leaves them out so `plan` fills them.
- **Output:** defaults to `deployment.yaml` and must be a new file; onboarding never overwrites one.

Each screen lists its keys.
After you choose a harness, **Ctrl+D** accepts the remaining suggested settings and opens the review; when the target checks below cannot confirm those suggestions, it says why and you answer the rest yourself.
**Esc** exits without saving.

The standalone example runs the same questionnaire without reading the target:

```sh
cargo run -p nemoclaw-onboarding -- examples/onboarding/openclaw.yaml --output my-deployment.yaml
```

## Target Checks

While you answer, `nemoclaw onboard` reads, without changing anything:

- the Docker and Podman engines that answer on this machine, to suggest a runtime and target the gateway at its engine;
- the selected agent image, to check that it provides the chosen harness;
- the selected route's model catalog, to suggest models;
- for a managed gateway, the engine's prerequisites.

It needs no bundle, runs no OpenTofu, and neither pulls images nor starts containers.
For an external gateway, set `spec.gateway.engine` in the template to an engine that holds the agent image; without it, the image stays unverified.

A confirmed conflict, such as an image without the chosen harness, blocks saving until you change the answer.
A read that fails or cannot run leaves the target unverified, and you can still save.
None of this establishes that the deployment will run; plan and apply make their own checks.
The [provider reference](../../docs/references/provider.md#engine-and-fabric-discovery) defines what is read.

## After Onboarding

1. Review the saved YAML; the template's comments and formatting are not kept.
2. Set the environment variables the YAML references, for example `export NVIDIA_API_KEY=...`. An interactive `nemoclaw plan` prompts for missing values; `--non-interactive` fails instead. Review reports an unset variable and, for a hosted provider, the page that issues its key.
3. Plan and apply with a [verified native bundle and the CLI on `PATH`](../../docs/build-deploy/build.md#build-a-native-bundle), following the [deployment guide](../../docs/build-deploy/usage.md):

   ```sh
   nemoclaw plan my-deployment.yaml
   nemoclaw apply my-deployment.yaml
   ```

   Saving prints these two commands with the saved path, quoted for the shell, and notes that apply pulls images and starts containers.

## Design and Backlog

The [authoring domain model](../../internal-docs/design/authoring-domain.md) and [onboarding journeys](../../internal-docs/design/onboarding-journeys.md) define how questions are resolved, when **Ctrl+D** can accept suggestions, and what review requires before saving.
Journeys onboarding does not offer yet are recorded in [`unsupported_onboarding_journeys.rs`](../nemoclaw-authoring/tests/unsupported_onboarding_journeys.rs).
