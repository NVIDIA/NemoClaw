<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Super VL Station default candidate

This change enables the harness-independent Super VL NVFP4 recipe as the default for new single-DGX-Station installs.
The preset is experimental because its pinned runtime is a public nightly, not a stable release.
Explicit Ultra and DeepSeek selections remain available. Paired Stations retain Ultra, and Spark is unchanged.
Existing running installations are not automatically migrated.

The preceding inactive Cobalt work is recorded in issue #12492.
The [October 15 scope decision](https://github.com/NVIDIA/NemoClaw/issues/12492#issuecomment-6197737817)
accepts publication of this activation candidate, with qualification and independent activation review still required.
The subsequent maintainer request authorizes preparing the single-Station default change, owned by Prekshi Vyas.
That request does not establish passing qualification or independent merge approval.

The public, ungated HF artifact is pinned to launch revision `82d93699acd3be9e4617c53360fe5b3f5dbeb1b3`.
Its manifest lists 114 files (75,063,319,581 bytes). All 88 weight hashes and all model code, tokenizer, and configuration files
match the October 14 snapshot. Only the model card, repository attributes, and two added illustrations differ.
All 114 launch files were independently SHA-256 verified in the native Station model cache.
The runtime is the model-card-listed public ARM64 vLLM nightly at digest
`sha256:fd33bec1578f312a01547cc6b9691a5154c3e8bcfb76d2b35acb657bfc4eee8f`.
It contains vLLM commit `3f1bcfd82bb2e93fcd364fc7a5491718453a77e2`, including fixes #59627 and #60797.
This is a nightly, not a stable release or a custom NemoClaw image. Candidate-bound onboarding qualification and independent review remain required before merging this default change.
Keep credentials, private endpoints and raw private test records outside this repository.

## Prepared integration

The recipe requires NVFP4 weights with three-token MTP speculative decoding, a 49,152-token context, and one concurrent sequence.
It uses 85% GPU memory utilization, 8,192 batched tokens, and 32 GiB shared memory.
KV cache uses BF16. Mamba state uses float16, FlashInfer, stochastic rounding, and five Philox rounds.
Weight quantization comes from the released artifact metadata; a dtype flag does not convert BF16 weights to NVFP4.
The recipe enables thinking and parameter-strict JSON tools through the Hermes tool parser and the configured reasoning parser.
The model includes a reviewed-code manifest tied to its immutable revision.
The host-local launcher verifies every metadata file before importing model code, then copies verified bytes into a private snapshot.
It rejects changed or extra metadata, escaping symlinks, and configuration references to unlisted code.
Only this guarded path enables `--trust-remote-code`; recipes cannot supply that flag directly.
The loader uses offline mode and a fresh Python module cache. Weight files remain linked to the read-only model cache.
The launcher waits for the server, forwards termination signals, and removes its temporary snapshot after server exit or startup failure.
This verifies code identity, not code safety: maintainers must review the Python files and their runtime dependencies before changing the manifest.
The exception supports fixed, authenticated host-local serving only. It rejects recipe environment overrides and alternate model-loading arguments.
An offline Station probe passed guarded configuration, tokenizer, processor loading, and image preprocessing on the pinned nightly
with Transformers 5.19.0. Native processor loading without the guard failed on a read-only video-processor property.
That probe did not start inference or qualify the managed lifecycle.
Remove this exception when the approved runtime supports the checkpoint without custom model code, and repeat the loading tests.
Media is limited to eight inline images; video is disabled. No local-media directory is exposed.
The media-domain allowlist uses a reserved invalid domain. Do not replace it with unrestricted URL fetching.
The existing host-local materializer owns installation, fixed arguments, bearer authentication, and catalog receipts.
Existing lifecycle code owns recovery. The reviewed-code launcher adds no credential mechanism.
Native installer tests verify that the selected recipe retains its read-only model-cache mount,
32 GiB shared-memory setting, platform GPU selection, authentication, and receipt provenance.

Development tests on October 14 used the final HF snapshot and the guarded command with a private patched runtime.
They passed 32 structured-tool cases, 38 endpoint checks, long-context retrieval with observed prefix-cache hits,
and a full-tool OpenClaw file/image flow with restart and rebuild. The media extension passed five of six checks:
local-file access was denied, but the error status was 500 instead of the expected 400.
That run used a custom-endpoint client harness, not native installation of this preset.
It does not qualify the release image or the subsequent native installer repair.

On October 15, the normal npm package installed the pinned public nightly and launch snapshot through the native host-local installer.
The on-disk preset stayed disabled; the test used an explicit, in-memory experimental selection.
Native receipt recovery, authentication, read-only cache mounting, and 32 GiB shared memory passed.
On that server, all 32 structured-tool cases and 38 endpoint checks passed, as did a 46,075-input-token retrieval test.
Native container restart and cold reinstall passed recovery, authentication, and 16 tool cases each.
The reinstall test explicitly stopped the owned model first; it does not establish hot replacement while GPU memory is occupied.
Repeated retrieval passed with 43,520 prefix-cache hit tokens observed in server metrics.
The initial install attempt had stopped at the memory guard because verification-file cache occupied GPU NUMA memory.
Releasing only the test-owned files' cache pages allowed the unchanged recipe to install; no unrelated workload was stopped.
The six-case media extension still failed one assertion: local-file access was denied with HTTP 500 instead of HTTP 400.
The eight-image limit, video denial, remote-domain denial, and four/eight-image ordering checks passed.
This is not an all-green qualification. These direct endpoint tests do not qualify a new OpenClaw run or full CLI onboarding.
The exact npm archive, model manifest, image, template, command, dependency inventory, and test scripts are bound in the private evidence ledger.
These Station results predate the launcher cleanup repair. Local process tests cover server exit, signal forwarding, and snapshot removal;
the subsequent run below tested the repaired launcher.

The October 15 run on commit `cb8f90438e362659b4a14f4b2ad9f66769c74b4d` passed native installation,
authentication, receipt recovery, restart, and cold reinstall on the pinned public image.
Source-checkout CLI onboarding completed all eight stages. OpenClaw 2026.9.2 used the actual `main` agent,
full tools, Tool Search disabled, high thinking, a 49,152-token context, an 8,192-token output budget,
and `parallel_tool_calls: false`. Five turns exercised 20 tool calls, image ordering, exact file bytes
with zero/one/two trailing newlines, restart, and rebuild. The original workspace instructions were preserved.
Two successful mutating turns recorded `replayInvalid: true`; that metadata is not evidence of safe replay.
The packaged CLI's fallback sandbox build failed because required build files were absent from the npm archive.
The source-checkout pass does not resolve that packaging failure. The local-media HTTP status mismatch also remains.
This historical evidence is identified by `super-vl-station-20261015-cb8f90438`; it does not qualify the new default-selection path.
The default candidate must verify native onboarding and generated agent settings without relying on manual configuration from that run.

The recipe adds no agent configuration, workspace instructions, or harness-specific setup.
Tool and reasoning parsers are model-server settings; they do not select or configure an agent harness.

## Runtime and request requirements

NemoClaw packages the reviewed JSON chat template as a literal `--chat-template` value in the recipe and compiled catalog.
The existing command builder quotes it as one argument; vLLM loads it through its native literal-template support.
No image-bundled template path, extra mount, template download, or startup installation is required.
The template SHA-256 is `ec468fff5625ccc22545b51c06f013b403c14c097dc971d74871651a0f821c76`.
The recipe and catalog receipt digests bind its contents. Other serving arguments retain their existing text restrictions.
The template must preserve string arguments, including trailing newlines, and support reasoning followed by JSON tool calls.
The runtime must correctly transition from reasoning to constrained tool output for both streaming and non-streaming requests.
This remains a runtime dependency; an unpatched image is not qualified by these declarations.
Pin the runtime image containing the required fixes and the catalog containing the template. Do not install patches at startup.

The server defaults `enable_thinking` to `true`. Clients that override `chat_template_kwargs` must preserve that value.
Clients must send `parallel_tool_calls: false` for the serial-tool contract.
This request field uses native response filtering; it is not a server flag and does not prevent generation of additional calls.
No additional serial-tool grammar patch is required by this contract.
Clients must budget prompt and output within 49,152 tokens, with at most 8,192 requested output tokens.
That output limit is a client requirement, not a server-enforced limit or the batched-token setting.
This recipe does not configure clients or certify that every harness sends these fields.

Integration tests compile these documents and materialize the serving command through existing consumers.
They prove that qualified single-Station discovery selects the experimental preset by default,
explicit model choices remain respected, and missing hardware qualifications or disabled presets are rejected.
The old Cobalt identifier is retired. Installer tests cover native receipt wiring, reboot resume, and paired-Station selection.
These tests do not prove runtime flag compatibility, model quality, prompt fit, harness compatibility, or hardware performance.
The model capabilities describe the candidate contract, not completed release qualification.

## Release activation

Complete these gates before merging this default candidate:

1. Record the released NVFP4/MTP model identity, immutable revision, file manifest, template hash, and complete runtime image digest.
2. Replace the release bindings and validate all serving options and template contents against the pinned runtime and target hardware.
   Verify the reviewed-code launcher against the release image. Earlier unguarded tests do not qualify this release command.
3. Qualify chat, images, context fit, and streaming/non-streaming tools, including serial responses and trailing-newline preservation with thinking enabled.
   Include authentication, restart, rebuild, cleanup, recovery, and the staged media restrictions.
4. Record the harness and configuration used for each live test; do not imply untested harnesses are qualified.
5. Qualify the new automatic selection through native onboarding, including generated agent configuration and packaged sandbox delivery.
   The existing clean-host Station smoke requires a dedicated host; do not run its destructive cleanup on a workstation with unrelated sandboxes.
6. Independently review this single-Station default change separately from the already-merged staging integration.

The model is publicly released. Draft publication does not establish activation readiness.
Do not treat this local/default candidate or historical hardware results as proof that the promotion has shipped.
