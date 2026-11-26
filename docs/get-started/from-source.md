<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Onboarding From Source on macOS or WSL2

Build the CLI and Hermes image from a checkout on Apple silicon macOS or in WSL2.
Deploy Hermes with local Docker and NVIDIA Endpoints, then verify that the agent replies `READY`.
The tutorial creates containers and can incur inference charges.
For the release bundle and OpenClaw image, use the [release tutorial](first-deployment.md) instead.

<a name="preparing-the-shell-and-docker-desktop"></a>

## Preparing the Shell and Docker

Run the tutorial in Bash with Git, `curl`, `jq`, and [Rust](https://www.rust-lang.org/tools/install).
On macOS, you also need Apple's Command Line Tools and [Docker Desktop](https://docs.docker.com/desktop/).
On Windows, [prepare Ubuntu and Docker Engine in WSL2](prerequisites.md#preparing-windows-with-wsl2) and install the tools and a C toolchain inside Ubuntu.
Keep the checkout and deployment files on the Linux filesystem in WSL2, such as under `~/src`.
Refer to the [WSL2 qualification limits](prerequisites.md#preparing-windows-with-wsl2) before choosing that path.

1. Open Terminal on macOS or the Ubuntu shell in WSL2.
2. Start `bash` if it is not your current shell. Run the CLI from the shell, not Finder.
3. Start Docker Desktop on macOS or use the local Docker Engine inside Ubuntu.
4. Set the bundle and image platforms for the current shell.

   ```sh
   case "$(uname -s)-$(uname -m)" in
     Darwin-arm64) PLATFORM=darwin_arm64; IMAGE_PLATFORM=linux/arm64 ;;
     Linux-aarch64) PLATFORM=linux_arm64; IMAGE_PLATFORM=linux/arm64 ;;
     Linux-x86_64) PLATFORM=linux_amd64; IMAGE_PLATFORM=linux/amd64 ;;
     *) echo 'This procedure covers Apple silicon and WSL2 on ARM64 or AMD64' >&2; exit 1 ;;
   esac
   ```

5. Verify engine access.

   ```sh
   docker version
   ```

   Expect both a Docker client and server.
6. Check the image store.

   ```sh
   docker info --format '{{json .DriverStatus}}'
   ```

   Expect `io.containerd.snapshotter.v1`. If it is absent, refer to [Checking the Docker Image Store](../build-deploy/build.md#checking-the-docker-image-store) before changing the store.

## Building the Checkout

The checkout's `rust-toolchain.toml` selects the Rust version.
Use the same Bash shell throughout. Stop if a build command fails.

1. Clone the source into a new directory.

   ```sh
   git clone --branch v1 https://github.com/NVIDIA/NemoClaw.git
   ```

2. Change to the repository root.

   ```sh
   cd NemoClaw
   ```

3. Check out the revision you intend to build if it differs from the cloned branch tip.
4. Install the pinned tools.

   ```sh
   cargo ci tools
   ```

   On the first run, compiling the runner before tool installation can take several minutes.
5. Build the bundle from the repository root.

   ```sh
   if [ -z "${PROTOC:-}" ] && [ -x .tools/protoc-36.2/bin/protoc ]; then
     export PROTOC="$PWD/.tools/protoc-36.2/bin/protoc"
   fi
   cargo run --locked -p nemoclaw-build -- bundle
   ```

6. Put the new bundle first on `PATH` for this shell.

   ```sh
   export PATH="$PWD/dist/$PLATFORM/bin:$PATH"
   ```

7. Check which CLI the shell selects.

   ```sh
   type -a nemoclaw
   ```

   The first result must be this checkout's executable, not another installation such as NemoClaw v0.
8. Check the command help.

   ```sh
   nemoclaw --help
   ```

   Expect `onboard`, `plan`, `apply`, and `destroy`. Keep the bundle intact and do not rebuild it during a deployment operation.

## Building the Hermes Image

A new repository name leaves other builds' tags intact.
On macOS, Docker Desktop builds and runs the Linux image in its ARM64 Linux virtual machine.

1. Build Hermes from the same repository root.

   ```sh
   TEST_IMAGE_PREFIX="nc-test-$(date +%Y%m%d%H%M%S)"
   IMAGE_PREFIX="$TEST_IMAGE_PREFIX" cargo images build --platform "$IMAGE_PLATFORM" hermes
   ```

2. Record the image digest for onboarding.

   ```sh
   docker image inspect "$TEST_IMAGE_PREFIX:hermes" --format '{{index .RepoDigests 0}}'
   ```

   Expect `NAME@sha256:DIGEST`. If there is no repository digest, stop and [check the image store](../build-deploy/build.md#checking-the-docker-image-store).
   A tag or image config ID cannot replace the digest.

## Using the Bundled OpenShell CLI

For this managed Docker deployment, use `nemoclaw osh` with the same state directory as apply.
The bundle includes the pinned client. You do not need a separate client or gateway selection.

## Authoring and Applying a Deployment

Use a fresh working directory for the YAML, deployment state, and results.
Keep the credential value out of YAML and shell history. Interactive apply prompts for a missing key with hidden input.
Apply starts containers and installs the credential in OpenShell.

1. Get an API key from [NVIDIA Endpoints](https://build.nvidia.com/settings/api-keys).
2. Create a new private working directory, such as `mkdir -m 700 "$HOME/nemoclaw-hermes"`.
3. Change to the new directory. Run the remaining commands there.
4. Start the questionnaire.

   ```sh
   nemoclaw onboard --output deployment.yaml
   ```

5. Answer the [onboarding questions](onboard.md#starting-onboarding) for Hermes, a new deployment name, a managed Docker gateway, and NVIDIA Endpoints with a model available to your account.
   For the image answer, use the digest you recorded. Tags, creation times, and revision labels help identify images but do not verify provenance.
6. [Review the proposed YAML](onboard.md#reviewing-and-saving-the-yaml). Confirm that it names the image, Docker engine, and model you selected.
   Compatible image metadata does not establish runtime or inference readiness.
7. Save `deployment.yaml` with **Enter** when there are no blocking conflicts.
8. If another deployment uses the default gateway port or subnet, set free values under `spec.gateway.target.docker` before planning. Keep the generated `engine` value.

   ```yaml
   spec:
     gateway:
       target:
         docker:
           port: 17683
           networkCIDR: 10.203.0.0/24
   ```

9. Preview changes with a new state directory.

   ```sh
   nemoclaw plan -o json --progress off --state-dir .local/first/state deployment.yaml
   ```

10. Check the exit status. Stop on an error.
11. Review the planned changes and `complete` field. A successful plan can still be incomplete.
12. Review `deferred` checks separately from `unverified` advisories. A new gateway can defer checks until it is reachable, and the inference key can wait for the apply prompt. Advisories alone do not make the plan incomplete.
13. Resolve unexpected changes or missing prerequisites before applying. If you edit the YAML, generate a new preview.
14. Apply the reviewed YAML. The command saves its result to `apply.json`.

    ```sh
    nemoclaw apply -o json --progress off --state-dir .local/first/state deployment.yaml > apply.json
    ```

15. Check the exit status. On failure, stop and keep the bundle, YAML, and entire state directory for [operation recovery](../build-deploy/usage.md#recovering-an-interrupted-operation).
16. Verify that `apply.json` reports `"outcome": "succeeded"`. Stop if it does not. Apply success does not verify inference.

## Verifying a Reply

Send one prompt from the same shell and working directory.
The request can incur inference charges and affect conversation history.

1. Read the agent name and runtime ID for the default sandbox key `assistant` from `apply.json`. If your saved YAML uses a different sandbox key, substitute it in the lookups and the request.

   ```sh
   AGENT=$(jq -er '.agents.assistant.agent | strings | select(length > 0)' apply.json) &&
     RUNTIME_ID=$(jq -er '.agents.assistant.runtimeId | strings | select(length > 0)' apply.json)
   ```

   If either lookup fails, stop and inspect [runtime diagnostics](../observability/troubleshooting.md#inference-and-agent-readiness).
2. Send the JSON prompt to Hermes on standard input. The command saves a private result without overwriting an earlier one.

   ```sh
   (umask 077; set -C
   nemoclaw osh --state-dir .local/first/state -- sandbox exec -n assistant --no-tty -- fabric-agent-ctl invoke --agent "$AGENT" --runtime-id "$RUNTIME_ID" --input - > reply.json <<'JSON'
   "Reply with exactly READY."
   JSON
   )
   ```

3. Check the exit status. Stop on failure and consult [native diagnostics](../observability/troubleshooting.md#reading-native-service-logs).
4. Check both Fabric statuses. Expect `true`: the outer `status` and the agent's `result.status` must both be `succeeded`.

   ```sh
   jq -e '.status == "succeeded" and .result.status == "succeeded"' reply.json
   ```

   If the check fails, stop and consult [native diagnostics](../observability/troubleshooting.md#reading-native-service-logs).
   Do not replay a request with unknown effects. For a rejected key, refer to [Diagnosing an Authentication Failure](../agents-inference/agents.md#diagnosing-an-authentication-failure).
5. Read the Hermes response.

   ```sh
   jq -er '.result.output.response | strings | select(length > 0)' reply.json
   ```

   Expect `READY`. If it is absent or unexpected, stop and consult [inference and agent readiness](../observability/troubleshooting.md#inference-and-agent-readiness).
   A matching reply verifies this request, not general compatibility.

## Checking an Unchanged Reapply

This optional check is separate from first-reply verification.
Use the same YAML, bundle, and `.local/first/state` directory in the [unchanged reapply procedure](../build-deploy/usage.md#verifying-an-unchanged-reapply).
Expect no resource changes.

## Previewing and Removing the Deployment

Destroy does not prompt. It removes the tutorial's sandbox, workspace, owned provider registrations and profiles, and managed gateway.
You lose sandbox writable files and conversations. Local state, images, and external services remain.

1. Preserve any agent files or conversations you need.
2. Preview removal with the original bundle and state directory.

   ```sh
   nemoclaw plan --destroy -o json --state-dir .local/first/state
   ```

3. Check the preview's exit status. Stop on an error.
4. Verify that the preview reports `"complete": true`. If it is incomplete, stop and follow [destroy troubleshooting](../build-deploy/usage.md#destroying).
5. Review planned removals and any retained resources.
6. Destroy the deployment only if you accept the removals.

   ```sh
   nemoclaw destroy --state-dir .local/first/state
   ```

7. Check the destroy result. On failure, keep the entire state directory for [resuming teardown](../build-deploy/usage.md#destroying).
8. Review [retention and explicit cleanup](../build-deploy/usage.md#removing-retained-resources) before deleting local state.
9. Clear any caller-owned credential variables you no longer need. This does not revoke upstream credentials.
