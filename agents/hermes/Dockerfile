# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Hermes sandbox image — Hermes Agent + NemoClaw plugin inside OpenShell
#
# Layers PR-specific code (plugin, config, startup script) on top of the
# pre-built Hermes base image. Mirrors the OpenClaw Dockerfile structure.

ARG BASE_IMAGE=ghcr.io/nvidia/nemoclaw/hermes-sandbox-base@sha256:c588bf76ba1c280f8a366bdfd672193e852de4f509a280662c7070a9b6e2fa48
ARG NEMOCLAW_CORPORATE_CA_B64=
ARG NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=0
# BuildKit supplies this automatic platform argument. The Portable staged
# context pins its accepted x86_64 target because Podman does not supply it.
ARG TARGETARCH

# The reviewed npm graph is audited in CI; image assembly copies only its
# generated runtime artifacts and therefore needs neither npm nor network.
FROM scratch AS mcp-tool-discovery-runtime
COPY tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/mcp-tool-discovery/BUNDLED_PACKAGES.json tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/mcp-tool-discovery/THIRD_PARTY_LICENSES.txt /opt/mcp-tool-discovery-runtime/dist/
COPY tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/mcp-tool-discovery/mcp-tool-discovery.bundle /opt/mcp-tool-discovery-runtime/dist/mcp-tool-discovery.mjs

FROM scratch AS managed-startup-runtime-builder
COPY tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/managed-startup-image-runtime.bundle /out/managed-startup-image-runtime.cjs

# Compile the bootstrap boundary on the target platform. The output is a
# freestanding static ELF; only its reviewed, non-executable Bash body remains
# interpreted at runtime after the native boundary has scrubbed process control.
FROM node:22-trixie@sha256:a566dd560283ae5615c8bb86b58fa8a1b6f3c82b492473a061672416266625da AS managed-bootstrap-entrypoint-builder
ARG TARGETARCH
WORKDIR /opt/nemoclaw-managed-bootstrap-build
COPY scripts/managed-bootstrap-entrypoint.c ./
COPY scripts/managed-bootstrap-trampoline.sh ./
# hadolint ignore=DL4006
RUN set -eu; \
    target_arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$target_arch" in \
        amd64) expected_machine='Advanced Micro Devices X86-64' ;; \
        arm64) expected_machine='AArch64' ;; \
        *) echo "ERROR: unsupported managed bootstrap target architecture: $target_arch" >&2; exit 1 ;; \
    esac; \
    install -d -o root -g root -m 0755 /out/usr/local/bin /out/usr/local/lib/nemoclaw; \
    gcc \
        -std=c11 -O2 -Wall -Wextra -Werror \
        -DNEMOCLAW_MANAGED_BOOTSTRAP_FREESTANDING=1 \
        -ffreestanding -fno-asynchronous-unwind-tables -fno-builtin -fno-ident \
        -fno-pie -fno-stack-protector -fno-unwind-tables \
        -no-pie -nostdlib -static \
        -Wl,--build-id=none -Wl,-z,noexecstack \
        managed-bootstrap-entrypoint.c -o /tmp/nemoclaw-managed-bootstrap; \
    install -o root -g root -m 0755 \
        /tmp/nemoclaw-managed-bootstrap /out/usr/local/bin/nemoclaw-managed-bootstrap; \
    install -o root -g root -m 0444 \
        managed-bootstrap-trampoline.sh \
        /out/usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh; \
    binary=/out/usr/local/bin/nemoclaw-managed-bootstrap; \
    body=/out/usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh; \
    test -f "$binary" && test ! -L "$binary"; \
    test -f "$body" && test ! -L "$body"; \
    test "$(stat -c '%u:%g:%a' "$binary")" = '0:0:755'; \
    test "$(stat -c '%u:%g:%a' "$body")" = '0:0:444'; \
    /bin/bash -n "$body"; \
    test "$(readelf -hW "$binary" | sed -n 's/^[[:space:]]*Class:[[:space:]]*//p')" = 'ELF64'; \
    test "$(readelf -hW "$binary" | sed -n 's/^[[:space:]]*Type:[[:space:]]*//p')" = 'EXEC (Executable file)'; \
    test "$(readelf -hW "$binary" | sed -n 's/^[[:space:]]*Machine:[[:space:]]*//p')" = "$expected_machine"; \
    program_headers="$(readelf -lW "$binary")"; \
    case "$program_headers" in *INTERP*) echo 'ERROR: managed bootstrap ELF has an interpreter' >&2; exit 1 ;; esac; \
    readelf -dW "$binary" | grep -Fq 'There is no dynamic section'; \
    test -z "$(nm --undefined-only "$binary")"; \
    strings "$binary" | grep -Fq '/usr/local/bin/nemoclaw-managed-bootstrap'; \
    strings "$binary" | grep -Fq '/usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh'

FROM scratch AS hermes-npm-patch-payload

COPY scripts/lib/reviewed-npm-archive.mts /scripts/lib/reviewed-npm-archive.mts
COPY scripts/lib/bundled-npm-package.mts /scripts/lib/bundled-npm-package.mts
COPY scripts/patch-bundled-npm-brace-expansion.mts /scripts/patch-bundled-npm-brace-expansion.mts
COPY scripts/lib/patch-bundled-npm-ip-address.mts /scripts/lib/patch-bundled-npm-ip-address.mts
COPY scripts/patch-bundled-npm-tar.mts /scripts/patch-bundled-npm-tar.mts
COPY agents/hermes/runtime-boundaries.patch /scripts/hermes-runtime-boundaries.patch
COPY agents/hermes/dashboard-external-host.patch /scripts/hermes-dashboard-external-host.patch
COPY agents/hermes/secure-dir-skip-chmod.patch /scripts/hermes-secure-dir-skip-chmod.patch

FROM scratch AS hermes-agent-payload

COPY agents/hermes/plugin/__init__.py agents/hermes/plugin/plugin.yaml /opt/nemoclaw-hermes-plugin/
# Channel-owned Google Chat runtime asset, loaded by the plugin beside its own
# __init__.py.
COPY src/lib/messaging/channels/googlechat/runtime/hermes-adapter.py /opt/nemoclaw-hermes-plugin/googlechat_adapter.py
COPY agents/hermes/generate-config.ts /opt/nemoclaw-hermes-config/generate-config.ts
COPY agents/hermes/config/ /opt/nemoclaw-hermes-config/config/
COPY agents/hermes/image-build-probes.py agents/hermes/finalize-image-layout.sh /opt/nemoclaw-hermes-config/
COPY agents/hermes/a2a-neutral.patch agents/hermes/patch-gateway-runtime-metadata.py /opt/nemoclaw-hermes-config/
COPY agents/hermes/patch-gateway-process-identity.py /opt/nemoclaw-hermes-config/patch-gateway-process-identity.py
COPY agents/hermes/patch-cron-execution-runtime.py /opt/nemoclaw-hermes-config/patch-cron-execution-runtime.py
COPY agents/hermes/patch-cron-restore-drain.py /opt/nemoclaw-hermes-config/patch-cron-restore-drain.py
COPY agents/hermes/patch-neutral-platform-env-activation.py /opt/nemoclaw-hermes-config/patch-neutral-platform-env-activation.py
COPY agents/hermes/patch-session-list-preview.py /opt/nemoclaw-hermes-config/patch-session-list-preview.py
COPY agents/hermes/patch-profile-policy-defaults.py /opt/nemoclaw-hermes-config/patch-profile-policy-defaults.py
COPY agents/hermes/hindsight-lazy-integrity.patch /opt/nemoclaw-hermes-config/hindsight-lazy-integrity.patch
COPY agents/hermes/hindsight-client-probe-requirements.txt /opt/nemoclaw-hermes-config/hindsight-client-requirements.txt
ADD --checksum=sha256:66d2759d1921838256a05a3f80ad7e724936f083e35be5abb5e16eed6be6dc54 https://files.pythonhosted.org/packages/1a/99/84ba7273339d0f3dfa57901b846489d2e5c2cd731470167757f1935fffbd/aiohttp_retry-2.9.1-py3-none-any.whl /opt/nemoclaw-hermes-config/hindsight-probe-aiohttp-retry.whl
COPY agents/hermes/managed_policy.py /opt/nemoclaw-hermes-config/managed_policy.py
COPY agents/hermes/host/managed-tool-gateway-matrix.json /opt/nemoclaw-hermes-config/managed-tool-gateway-matrix.json
COPY src/lib/hermes-managed-route.ts /src/lib/hermes-managed-route.ts
COPY src/lib/tool-disclosure.ts /src/lib/tool-disclosure.ts
COPY src/lib/messaging/ /src/lib/messaging/
COPY scripts/lib/openclaw-npm-remediation.mts /scripts/lib/openclaw-npm-remediation.mts

FROM scratch AS hermes-runtime-payload

COPY --from=mcp-tool-discovery-runtime /opt/mcp-tool-discovery-runtime/dist/ /usr/local/lib/nemoclaw/mcp-tool-discovery-runtime/
COPY nemoclaw-blueprint/ /opt/nemoclaw-blueprint/
COPY scripts/lib/sandbox-init.sh /usr/local/lib/nemoclaw/sandbox-init.sh
COPY scripts/lib/corporate-ca-runtime.sh /usr/local/lib/nemoclaw/corporate-ca-runtime.sh
COPY scripts/lib/entrypoint-env-wrapper.sh /usr/local/lib/nemoclaw/entrypoint-env-wrapper.sh
COPY scripts/lib/gateway-supervisor.sh /usr/local/lib/nemoclaw/gateway-supervisor.sh
COPY scripts/lib/sandbox-rlimits.sh /usr/local/lib/nemoclaw/sandbox-rlimits.sh
COPY agents/hermes/start.sh /usr/local/bin/nemoclaw-start
COPY scripts/managed-startup-hold.sh /usr/local/bin/nemoclaw-managed-startup-hold
COPY --from=managed-bootstrap-entrypoint-builder /out/usr/local/bin/nemoclaw-managed-bootstrap /usr/local/bin/nemoclaw-managed-bootstrap
COPY --from=managed-bootstrap-entrypoint-builder /out/usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh
COPY --from=managed-startup-runtime-builder /out/managed-startup-image-runtime.cjs /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs
COPY scripts/gateway-control.sh /usr/local/bin/nemoclaw-gateway-control
COPY scripts/managed-gateway-control.py /usr/local/lib/nemoclaw/managed-gateway-control.py
COPY agents/hermes/validate-env-secret-boundary.py /usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py
COPY agents/hermes/patch-hermes-sqlite-temp-store.py /usr/local/lib/nemoclaw/patch-hermes-sqlite-temp-store.py
COPY agents/hermes/patch-discord-recovery-permissions.py /usr/local/lib/nemoclaw/patch-hermes-discord-recovery-permissions.py
COPY agents/hermes/managed_policy.py /usr/local/lib/nemoclaw/managed_policy.py
COPY agents/hermes/patch-langfuse-credentials.mts /usr/local/lib/nemoclaw/patch-hermes-langfuse-credentials.mts
COPY agents/hermes/seed-dashboard-config.py /usr/local/lib/nemoclaw/seed-hermes-dashboard-config.py
COPY agents/hermes/runtime-config-guard.py /usr/local/lib/nemoclaw/hermes-runtime-config-guard.py
COPY agents/hermes/finalize-tirith-marker.py /usr/local/lib/nemoclaw/finalize-tirith-marker.py
COPY agents/hermes/build-mcp-digest.py /usr/local/lib/nemoclaw/build-hermes-mcp-digest.py
COPY agents/hermes/mcp-config-transaction.py /usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py
COPY agents/hermes/cron-restore-control.py /usr/local/lib/nemoclaw/hermes-cron-restore-control.py
COPY src/lib/actions/sandbox/openshell-child-visible-credentials.v0.0.106.json /usr/local/lib/nemoclaw/openshell-child-visible-credentials.v0.0.106.json
COPY nemoclaw-blueprint/scripts/*.js /usr/local/lib/nemoclaw/preloads/

FROM scratch AS hermes-wrapper-payload

COPY agents/hermes/hermes-wrapper.py /usr/local/lib/nemoclaw/hermes-wrapper.py
COPY agents/hermes/validate-cli-adapter.py /usr/local/lib/nemoclaw/validate-hermes-cli-adapter.py
COPY agents/hermes/hermes-cli-adapter-v1.json /usr/local/share/nemoclaw/hermes-cli-adapter-v1.json


# Fetch the managed capability wheels outside RUN instructions so
# both the standard build and the protected --network none rebuild install the
# reviewed union from immutable inputs rather than a reusable networked layer.
FROM scratch AS hermes-managed-teams-common-wheels

ADD --checksum=sha256:db16f714ec658b592929c6386a29792e90bb73840732f8ae65a198cda1fea96c https://files.pythonhosted.org/packages/3a/d4/3c4205258642035d160c09f598a302260776dcb6d5bdf659eea7c6066d5e/microsoft_teams_apps-2.0.13.4-py3-none-any.whl /microsoft_teams_apps-2.0.13.4-py3-none-any.whl
ADD --checksum=sha256:0072ffe68863a4c62818a4e631a186f092a4f09dfda74d1d4713415bac5d202d https://files.pythonhosted.org/packages/f4/09/8efc1f9a7ee3ef87d2f394b39355d884e76f35d9871a72530d2a8deab325/microsoft_teams_api-2.0.15-py3-none-any.whl /microsoft_teams_api-2.0.15-py3-none-any.whl
ADD --checksum=sha256:e2b0257d9b8782830df61eb6aa993a1ddc0349daddd845739da45d2a29a0c44b https://files.pythonhosted.org/packages/7d/b8/c4e5df0f6797363ff8a431bcee1a51a7d8b6fe2e5d4cac21a6bd58e9f50f/microsoft_teams_cards-2.0.15-py3-none-any.whl /microsoft_teams_cards-2.0.15-py3-none-any.whl
ADD --checksum=sha256:c61057695b9f1a97de9b6f54f0c66206903f56c22427b0bca31e0fc34da49311 https://files.pythonhosted.org/packages/8d/91/01e6aeddd78639c74489c24785f2cec0f842ba16f3b594db202386bd721d/microsoft_teams_common-2.0.15-py3-none-any.whl /microsoft_teams_common-2.0.15-py3-none-any.whl
ADD --checksum=sha256:dd17e95a7c71bce75e8108113438ba7c4a086b3bcad4f57a8c09b7af3d753c2d https://files.pythonhosted.org/packages/94/b0/d807279f4b55d16d1f120d5ac4344c6e39b56732e2a224d40bded7fd67ad/msal-1.37.0-py3-none-any.whl /msal-1.37.0-py3-none-any.whl
ADD --checksum=sha256:a20c97b37910b6550d5ea50fbcc2d4187defe58cd57070b73863d069419c9440 https://files.pythonhosted.org/packages/77/c1/6e422f34e569cf8e18df68d1939c81c099d2b61e4f7d9621c8a77560799c/pydantic_settings-2.14.2-py3-none-any.whl /pydantic_settings-2.14.2-py3-none-any.whl

# Google Chat needs the google SDKs, which Hermes does not package: its
# pyproject declares no google_chat extra, and `_load_google_modules()`
# imports pubsub, googleapiclient, and grpc all-or-nothing even in REST-pull
# mode. Vendor only what the base venv lacks; uv satisfies the rest from the
# installed distributions.
ADD --checksum=sha256:cdf9c67e7ca2402d86ccbfde5f2503fc83e3cc3f58cc78456ae96cad24a6d2de https://files.pythonhosted.org/packages/bc/c1/a8a92ae1bc4b1a8f804c776d7d3f0c771b78a62c3ad4df1be41b3fd8c767/google_api_core-2.34.0-py3-none-any.whl /google_api_core-2.34.0-py3-none-any.whl
ADD --checksum=sha256:61eaaac3b8fc8fdf11c08af87abc3d1342d1b37319cc1b57405f86ef7697e717 https://files.pythonhosted.org/packages/b0/34/5a624e49f179aa5b0cb87b2ce8093960299030ff40423bfbde09360eb908/google_api_python_client-2.194.0-py3-none-any.whl /google_api_python_client-2.194.0-py3-none-any.whl
ADD --checksum=sha256:eada68dfd52b3b81191827601e2a0c3fa12540c818534b630ddc5355769c3995 https://files.pythonhosted.org/packages/e8/1d/f6d3ca1ad0725f2e08a1c6915640748a52de2e66596160a4d53b010cccf0/google_auth-2.55.1-py3-none-any.whl /google_auth-2.55.1-py3-none-any.whl
ADD --checksum=sha256:67088a8387dc3f66016a690634f1cb9b7a48a31406f8998e088efc64203e7a12 https://files.pythonhosted.org/packages/68/8a/96410d0c3e02b584d1e7f5d4000b2e1710855650b226cd0601f2b154940a/google_auth_httplib2-0.4.1-py3-none-any.whl /google_auth_httplib2-0.4.1-py3-none-any.whl
ADD --checksum=sha256:7210d691a46d7a66559696899ebe6eb731e63de29b624964b3be4dd2d12d3e19 https://files.pythonhosted.org/packages/93/20/dd0b27d4ad4577c062e77ff968ca3e2d404186cd78c8a2a53a0ef5fe5389/google_cloud_pubsub-2.39.0-py3-none-any.whl /google_cloud_pubsub-2.39.0-py3-none-any.whl
ADD --checksum=sha256:28a1934bcd33b9c9da66ac301a0a4227e3367f095a17d0375cb98f0a09d93b79 https://files.pythonhosted.org/packages/9a/51/186c02b8549b69ccda44429cf6ff5081e4b61a602ddfe6a8020d1be31d1b/googleapis_common_protos-1.75.1-py3-none-any.whl /googleapis_common_protos-1.75.1-py3-none-any.whl
ADD --checksum=sha256:0f5e680b20aa0a9441e68c769da04d94d70fca4e43751a82d8abb8aa6a7181ca https://files.pythonhosted.org/packages/84/ab/be3ad0d46cffe35fd1e7cc3f9947edd6cb3c552229de3be2742f15f7ea47/grpc_google_iam_v1-0.14.5-py3-none-any.whl /grpc_google_iam_v1-0.14.5-py3-none-any.whl
ADD --checksum=sha256:f6a838a7c5fb84ae98833ec0ef81ed438c26e11e54b2ddb8e92ad328c861de69 https://files.pythonhosted.org/packages/d6/00/73204406228cf989bea6b0fd9fe4702fab49a8a152a0c6f90856dadb6ac7/grpcio_status-1.83.0-py3-none-any.whl /grpcio_status-1.83.0-py3-none-any.whl
ADD --checksum=sha256:dc6705cacdf3fb0a2aba7629fa33c90fd93e30035db0c157325826be177e4816 https://files.pythonhosted.org/packages/33/a0/550eec327e5f5c7b732531c489f5307efec41f047b0d703bd4ca1e5ad2db/httplib2-0.32.0-py3-none-any.whl /httplib2-0.32.0-py3-none-any.whl
ADD --checksum=sha256:94b98c893a91b88657eaac1e3ba89618cdb85be6918196705354f34728b2cdef https://files.pythonhosted.org/packages/ca/6f/a04e900f465ff3221ccc395522503e2d10e79fa21f2723c8e177aae1e0d1/opentelemetry_api-1.44.0-py3-none-any.whl /opentelemetry_api-1.44.0-py3-none-any.whl
ADD --checksum=sha256:df081c4c6bcfdb1211e3e86140376792643128a25f8d72d1d27675936e7e96ad https://files.pythonhosted.org/packages/e7/23/ff077e61886ee020a17ce9c8b6fa11c601c8d8345b09ea24f605445df62a/opentelemetry_sdk-1.44.0-py3-none-any.whl /opentelemetry_sdk-1.44.0-py3-none-any.whl
ADD --checksum=sha256:1cacde7b0ad306f84c5ef08c3dbe1bbaf20165bba6f8bff43b670e555a086bcb https://files.pythonhosted.org/packages/a6/0e/49df70d9b81fb5cbae4bbf2a49d865b09bcbcbc4eb53f5851b1027738d78/opentelemetry_semantic_conventions-0.65b0-py3-none-any.whl /opentelemetry_semantic_conventions-0.65b0-py3-none-any.whl
ADD --checksum=sha256:dc76880b8ee951cca002098574376cf71e055f9f16d9ba6570fb8a06f726d281 https://files.pythonhosted.org/packages/61/3a/cfee3c50294f55a2f0f9575052dec2c2a48891ad4b1c2a133b05a87026cd/proto_plus-1.28.3-py3-none-any.whl /proto_plus-1.28.3-py3-none-any.whl
ADD --checksum=sha256:4bc97768d8fe4ad6743c8a19403e314511ed9f6d13205b687e52421c023ac1b9 https://files.pythonhosted.org/packages/19/c7/5f7c636ec43e0c545e28d1f1db71990108306f7bdcb89f069ba97e428e7f/protobuf-7.35.1-py3-none-any.whl /protobuf-7.35.1-py3-none-any.whl
ADD --checksum=sha256:deda9277cfd454080ec40b207fb6df82206a3a2688735233cdcd8d3d565f088b https://files.pythonhosted.org/packages/9a/3b/6163796d69c3977d1e4287bea4a6979161cbbdd170ebb430511e8e1999ce/pyasn1-0.6.4-py3-none-any.whl /pyasn1-0.6.4-py3-none-any.whl
ADD --checksum=sha256:29253a9207ce32b64c3ac6600edc75368f98473906e8fd1043bd6b5b1de2c14a https://files.pythonhosted.org/packages/47/8d/d529b5d697919ba8c11ad626e835d4039be708a35b0d22de83a269a6682c/pyasn1_modules-0.4.2-py3-none-any.whl /pyasn1_modules-0.4.2-py3-none-any.whl
ADD --checksum=sha256:850ba148bd908d7e2411587e247a1e4f0327839c40e2e5e6d05a007ecc69911d https://files.pythonhosted.org/packages/10/bd/c038d7cc38edc1aa5bf91ab8068b63d4308c66c4c8bb3cbba7dfbc049f9c/pyparsing-3.3.2-py3-none-any.whl /pyparsing-3.3.2-py3-none-any.whl
ADD --checksum=sha256:962201ba1c4edcab02e60f9a0d3821e82dfc5d2d6662a21abd533879bdb8a686 https://files.pythonhosted.org/packages/a9/99/3ae339466c9183ea5b8ae87b34c0b897eda475d2aec2307cae60e5cd4f29/uritemplate-4.2.0-py3-none-any.whl /uritemplate-4.2.0-py3-none-any.whl

FROM hermes-managed-teams-common-wheels AS hermes-managed-teams-amd64-wheels

ADD --checksum=sha256:10e481880b307a6a438c1cc7b0a1fa8754247239ef5a2e8fe82bd8a1e76e7682 https://files.pythonhosted.org/packages/68/20/fc1812f20ec75af2d4b5e391e93f15621af3102da46142e26177eb506b32/dependency_injector-4.49.1-cp310-abi3-manylinux1_x86_64.manylinux_2_28_x86_64.manylinux_2_5_x86_64.whl /dependency_injector-4.49.1-cp310-abi3-manylinux1_x86_64.manylinux_2_28_x86_64.manylinux_2_5_x86_64.whl
ADD --checksum=sha256:7bd82671b39065ba18cd536e9cd45b27ff649053f81ddd2c6a966d595067080f https://files.pythonhosted.org/packages/e8/c0/539fe0832f2dd6500a28f5263071623fb34e8d4867aec632ccf81bd21156/grpcio-1.83.0-cp313-cp313-manylinux2014_x86_64.manylinux_2_17_x86_64.whl /grpcio-1.83.0-cp313-cp313-manylinux2014_x86_64.manylinux_2_17_x86_64.whl

FROM hermes-managed-teams-common-wheels AS hermes-managed-teams-arm64-wheels

ADD --checksum=sha256:e05da5bc73a3e026f962a223672002934c0f415064b6e2c3db0b255e46c7b521 https://files.pythonhosted.org/packages/32/ab/b1e1826aacc37d07ba0101230de7b5cbbb5ac6364b78ca3957f0a90d6a51/dependency_injector-4.49.1-cp310-abi3-manylinux2014_aarch64.manylinux_2_17_aarch64.manylinux_2_28_aarch64.whl /dependency_injector-4.49.1-cp310-abi3-manylinux2014_aarch64.manylinux_2_17_aarch64.manylinux_2_28_aarch64.whl
ADD --checksum=sha256:10b3fa0475eb572c9a81a6fe37fa16a9c500c0c91cfc148cac15692b7e3c2867 https://files.pythonhosted.org/packages/b0/e8/d0389e09cd6b4c4d3089b92967ae4e3ffd64795bd349bf2f85cd6656d3da/grpcio-1.83.0-cp313-cp313-manylinux2014_aarch64.manylinux_2_17_aarch64.whl /grpcio-1.83.0-cp313-cp313-manylinux2014_aarch64.manylinux_2_17_aarch64.whl

FROM scratch AS hermes-managed-teams-0-wheels

# Keep the selected wheel stage non-empty for classic Dockerfile builders when
# the managed capability union is disabled. The marker is removed after the
# selected stage is copied into the final image.
COPY --from=hermes-wrapper-payload /usr/local/share/nemoclaw/hermes-cli-adapter-v1.json /.empty

# hadolint ignore=DL3006
FROM hermes-managed-teams-${TARGETARCH}-wheels AS hermes-managed-teams-1-wheels

# Select the empty stage for ordinary custom-plan builds so their dependency
# graph never resolves the managed-image-only PyPI wheel sources above.
# hadolint ignore=DL3006
FROM hermes-managed-teams-${NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION}-wheels AS hermes-managed-teams-wheels

# hadolint ignore=DL3006
FROM ${BASE_IMAGE}

# Keep the stock-image lazy dependency target when a published base image lags
# Dockerfile.base. The final stage also creates and verifies the directory.
ENV HERMES_LAZY_INSTALL_TARGET=/sandbox/.hermes/lazy-packages
ENV HERMES_SKIP_CHMOD=1

# Base64-encoded host corporate-proxy CA bundle (#6210). Empty by default. When
# onboard detects an operator-supplied corporate CA on the host it bakes it
# here; the RUN below decodes it to a root-owned file that the entrypoint
# appends to the OpenShell trust bundle at runtime. The CA is a public
# certificate, not a secret, so baking it into an image layer is acceptable.
ARG NEMOCLAW_CORPORATE_CA_B64
ARG NEMOCLAW_HERMES_RUNTIME_BOUNDARIES_PATCH_SHA256=820563cc3450de582663c8137670001bb9974ac8a5584901880982f6509747b8
ARG NEMOCLAW_HERMES_SECURE_DIR_SOURCE_SHA256=ffae3271120cf53eb8a7f574f76758eac3ea172f9ddc22c1056277e37d8d392c
ARG NEMOCLAW_HERMES_SECURE_DIR_PATCH_SHA256=1c1a898226bc67b123ec72847d4dcda7abbab1e95958c9e019790d9425e15d69
ARG NEMOCLAW_HERMES_SECURE_DIR_OUTPUT_SHA256=130cf4e76d6f4f16b85517cf8d3d81dfe294aff63d6c561b979971c401f78761

# Decode the host corporate-proxy CA (#6210) to a root-owned, read-only file
# when onboard baked one in. No-op when NEMOCLAW_CORPORATE_CA_B64 is empty. The
# ARG is expanded by the shell (not interpolated into source), and its value is
# base64 sanitized host-side, so this is not an injection vector. Must run as
# root, before the USER sandbox drop below.
# hadolint ignore=DL3059,DL4006
RUN if [ -n "${NEMOCLAW_CORPORATE_CA_B64}" ]; then \
      command -v base64 >/dev/null 2>&1 || { echo "[nemoclaw] base64 is required to decode NEMOCLAW_CORPORATE_CA_B64 but is not installed in the build image" >&2; exit 1; }; \
      command -v openssl >/dev/null 2>&1 || { echo "[nemoclaw] openssl is required to validate NEMOCLAW_CORPORATE_CA_B64 but is not installed in the build image (#6210)" >&2; exit 1; }; \
      command -v update-ca-certificates >/dev/null 2>&1 || { echo "[nemoclaw] update-ca-certificates is required to anchor NEMOCLAW_CORPORATE_CA_B64 for the OpenShell proxy" >&2; exit 1; }; \
      case "${NEMOCLAW_CORPORATE_CA_B64}" in *[!A-Za-z0-9+/=]*) echo "[nemoclaw] NEMOCLAW_CORPORATE_CA_B64 is not valid base64; expected a single-line base64-encoded PEM (#6210)" >&2; exit 1 ;; esac; \
      mkdir -p /usr/local/share/nemoclaw /usr/local/share/ca-certificates \
      && { printf '%s' "${NEMOCLAW_CORPORATE_CA_B64}" | base64 --decode > /tmp/nemoclaw-corporate-ca.decoded 2>/dev/null \
           || { echo "[nemoclaw] NEMOCLAW_CORPORATE_CA_B64 is not valid base64; expected a single-line base64-encoded PEM (#6210)" >&2; exit 1; }; } \
      && awk '/-----BEGIN CERTIFICATE-----/{f=1} f{print} /-----END CERTIFICATE-----/{f=0}' /tmp/nemoclaw-corporate-ca.decoded > /usr/local/share/nemoclaw/corporate-ca.pem \
      && rm -f /tmp/nemoclaw-corporate-ca.decoded \
      && { grep -qF -- "-----BEGIN CERTIFICATE-----" /usr/local/share/nemoclaw/corporate-ca.pem || { echo "[nemoclaw] NEMOCLAW_CORPORATE_CA_B64 did not decode to a bundle of valid X.509 certificates (#6210)" >&2; exit 1; }; } \
      && { openssl crl2pkcs7 -nocrl -certfile /usr/local/share/nemoclaw/corporate-ca.pem >/dev/null 2>&1 || { echo "[nemoclaw] NEMOCLAW_CORPORATE_CA_B64 did not decode to a bundle of valid X.509 certificates (#6210)" >&2; exit 1; }; } \
      && node -e 'const fs = require("node:fs"); const { X509Certificate } = require("node:crypto"); const pemPath = process.argv[1]; const anchorDir = process.argv[2]; const pem = fs.readFileSync(pemPath, "utf8"); const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g); if (!blocks?.length) process.exit(1); fs.writeFileSync(pemPath, blocks.map((block) => block.trim()).join("\n") + "\n"); blocks.forEach((block, index) => { if (!new X509Certificate(block).ca) process.exit(1); const name = anchorDir + "/nemoclaw-corporate-ca-" + String(index + 1).padStart(2, "0") + ".crt"; fs.writeFileSync(name, block.trim() + "\n"); });' /usr/local/share/nemoclaw/corporate-ca.pem /usr/local/share/ca-certificates \
      && chown root:root /usr/local/share/nemoclaw/corporate-ca.pem /usr/local/share/ca-certificates/nemoclaw-corporate-ca-*.crt \
      && chmod 0444 /usr/local/share/nemoclaw/corporate-ca.pem /usr/local/share/ca-certificates/nemoclaw-corporate-ca-*.crt \
      && update-ca-certificates \
      && echo "[nemoclaw] baked host corporate-proxy CA into image trust (#6210)"; \
    fi

# Use the decoded CA for Node.js package operations in this final stage only
# when onboarding supplied it. At runtime, nemoclaw-start builds the merged
# OpenShell and corporate bundle.

# Cross-stage root copies are accepted by Docker's legacy builder and create
# one final-image layer while preserving metadata on existing parent paths.
COPY --from=hermes-npm-patch-payload / /

# The immutable selected base owns the reviewed Hindsight and agent-browser
# patches and the root-owned agent-browser runtime. Verify that inherited boundary
# without adding a second network-capable install owner in the final image.
# Apply the dashboard Host guard when the published 0.20.6 base predates that
# source fix, then verify the exact accepted-host contract.
# hadolint ignore=DL4006
RUN grep -Fq 'from tools.lazy_deps import install_specs' /opt/hermes/hermes_cli/memory_setup.py \
    && grep -Fq 'outcome = install_specs(missing, timeout=120)' /opt/hermes/hermes_cli/memory_setup.py \
    && grep -Fqx '  - "hindsight-client==0.6.1"' /opt/hermes/plugins/memory/hindsight/plugin.yaml \
    && grep -Fqx 'AGENT_BROWSER_NPX_SPEC = "agent-browser@0.26.0"' /opt/hermes/tools/browser_tool.py \
    && test "$(readlink /usr/local/bin/agent-browser)" = \
        '/opt/nemoclaw-agent-browser-runtime/node_modules/.bin/agent-browser' \
    && agent_browser_version="$( \
        /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- \
            /usr/local/bin/agent-browser --version \
    )" \
    && test "$agent_browser_version" = 'agent-browser 0.26.0' \
    && if ! grep -Fq 'if external_host and host_only == external_host:' /opt/hermes/hermes_cli/web_server.py; then \
        git -C /opt/hermes apply --check \
            --include=hermes_cli/web_server.py \
            /scripts/hermes-dashboard-external-host.patch; \
        git -C /opt/hermes apply \
            --include=hermes_cli/web_server.py \
            /scripts/hermes-dashboard-external-host.patch; \
    fi \
    && grep -Fqx '_NEMOCLAW_DASHBOARD_EXTERNAL_HOST_ENV = "_NEMOCLAW_HERMES_DASHBOARD_EXTERNAL_HOST"' /opt/hermes/hermes_cli/web_server.py \
    && grep -Fq 'if external_host and host_only == external_host:' /opt/hermes/hermes_cli/web_server.py \
    && rm /scripts/hermes-dashboard-external-host.patch \
    && printf '%s  %s\n' \
        "$NEMOCLAW_HERMES_SECURE_DIR_PATCH_SHA256" /scripts/hermes-secure-dir-skip-chmod.patch \
    | sha256sum -c - \
    || { echo "ERROR: Hermes secure-directory patch identity mismatch" >&2; exit 1; } \
    && secure_dir_source_sha="$(sha256sum /opt/hermes/hermes_cli/config.py | awk '{print $1}')" \
    && if [ "$secure_dir_source_sha" = "$NEMOCLAW_HERMES_SECURE_DIR_SOURCE_SHA256" ]; then \
        git -C /opt/hermes apply --check /scripts/hermes-secure-dir-skip-chmod.patch; \
        git -C /opt/hermes apply /scripts/hermes-secure-dir-skip-chmod.patch; \
    elif [ "$secure_dir_source_sha" != "$NEMOCLAW_HERMES_SECURE_DIR_OUTPUT_SHA256" ]; then \
        echo "ERROR: Hermes secure-directory source identity mismatch" >&2; \
        exit 1; \
    fi \
    && printf '%s  %s\n' \
        "$NEMOCLAW_HERMES_SECURE_DIR_OUTPUT_SHA256" /opt/hermes/hermes_cli/config.py \
    | sha256sum -c - \
    || { echo "ERROR: Hermes secure-directory patched output identity mismatch" >&2; exit 1; } \
    && rm /scripts/hermes-secure-dir-skip-chmod.patch \
    && printf '%s  %s\n' "$NEMOCLAW_HERMES_RUNTIME_BOUNDARIES_PATCH_SHA256" /scripts/hermes-runtime-boundaries.patch | sha256sum -c - \
    && if ! grep -Fq 'def nemoclaw_managed_gateway_plugins_only()' /opt/hermes/hermes_constants.py; then \
        git -C /opt/hermes apply --check \
            --include=hermes_constants.py \
            --include=hermes_cli/env_loader.py \
            --include=hermes_cli/plugins.py \
            --include=plugins/memory/__init__.py \
            --include=plugins/cron_providers/__init__.py \
            --include=providers/__init__.py \
            --include=tools/lazy_deps.py \
            /scripts/hermes-runtime-boundaries.patch; \
        git -C /opt/hermes apply \
            --include=hermes_constants.py \
            --include=hermes_cli/env_loader.py \
            --include=hermes_cli/plugins.py \
            --include=plugins/memory/__init__.py \
            --include=plugins/cron_providers/__init__.py \
            --include=providers/__init__.py \
            --include=tools/lazy_deps.py \
            /scripts/hermes-runtime-boundaries.patch; \
    fi \
    && grep -Fq 'def nemoclaw_managed_gateway_plugins_only()' /opt/hermes/hermes_constants.py \
    && grep -Fq 'nemoclaw_protected_process_control' /opt/hermes/hermes_cli/env_loader.py \
    && grep -Fq 'nemoclaw_sanitized_installer_env' /opt/hermes/tools/lazy_deps.py \
    && grep -Fq 'Managed gateway: user and project plugins disabled' /opt/hermes/hermes_cli/plugins.py \
    && grep -Fq 'nemoclaw_managed_gateway_plugins_only' /opt/hermes/plugins/memory/__init__.py \
    && grep -Fq 'nemoclaw_managed_gateway_plugins_only' /opt/hermes/plugins/cron_providers/__init__.py \
    && grep -Fq 'nemoclaw_managed_gateway_plugins_only' /opt/hermes/providers/__init__.py \
    && rm /scripts/hermes-runtime-boundaries.patch

# The final Hermes image owns the shipped dependency boundary independently of
# base freshness. Reassert the idempotent npm-private node-tar fix from the
# locked cache seed so protected rebuilds remain network-disabled.
COPY tools/mcp-tool-discovery-runtime/npm-cache-seed/tar-7.5.21.tgz /tmp/nemoclaw-bundled-npm-tar.tgz
RUN node --experimental-strip-types /scripts/patch-bundled-npm-tar.mts \
      --npm-root /usr/local/lib/node_modules/npm \
      --archive /tmp/nemoclaw-bundled-npm-tar.tgz

# Reassert the npm-private brace-expansion fix for the final filesystem.
# When onboarding supplied a corporate CA, use it for the registry-backed
# download.
# hadolint ignore=DL3059
RUN if [ -f /usr/local/share/nemoclaw/corporate-ca.pem ]; then \
      export CURL_CA_BUNDLE=/usr/local/share/nemoclaw/corporate-ca.pem; \
      export NODE_EXTRA_CA_CERTS=/usr/local/share/nemoclaw/corporate-ca.pem; \
    fi; \
    node --experimental-strip-types /scripts/patch-bundled-npm-brace-expansion.mts \
      --npm-root /usr/local/lib/node_modules/npm

# Reassert the npm-private ip-address fix for the final filesystem. When
# onboarding supplied a corporate CA, use it for the registry-backed download.
# hadolint ignore=DL3059
RUN if [ -f /usr/local/share/nemoclaw/corporate-ca.pem ]; then \
      export CURL_CA_BUNDLE=/usr/local/share/nemoclaw/corporate-ca.pem; \
      export NODE_EXTRA_CA_CERTS=/usr/local/share/nemoclaw/corporate-ca.pem; \
    fi; \
    node --experimental-strip-types /scripts/lib/patch-bundled-npm-ip-address.mts \
      --npm-root /usr/local/lib/node_modules/npm

# Keep the final image contract explicit even when the published base image
# changes independently of this Dockerfile.
RUN set -eu; \
    hermes_path="$(command -v hermes 2>/dev/null || true)"; \
    if [ "$hermes_path" != "/usr/local/bin/hermes" ]; then \
        echo "ERROR: expected hermes at /usr/local/bin/hermes, got ${hermes_path:-missing}" >&2; \
        exit 1; \
    fi; \
    test -x /usr/local/bin/hermes; \
    /usr/local/bin/hermes --version

RUN chmod -R a+rX /opt/hermes/.venv \
    && test -r /opt/hermes/.venv/pyvenv.cfg \
    && su -s /bin/sh sandbox -c '/opt/hermes/.venv/bin/python3 -c "import urllib.request"'

# Published base images can lag Dockerfile.base while local feature branches
# still layer this final image on top. Invalid state: the selected base has
# Hermes source under /opt/hermes but lacks hermes_cli/web_dist. Prebuild the
# dashboard bundle here too so `hermes dashboard` never tries to run npm from
# the sandbox user account. Remove this fallback after all supported base image
# tags are built from Dockerfile.base with HERMES_WEB_DIST prepopulated.
RUN set -eu; \
    if [ -f /usr/local/share/nemoclaw/corporate-ca.pem ]; then \
        export CURL_CA_BUNDLE=/usr/local/share/nemoclaw/corporate-ca.pem; \
        export NODE_EXTRA_CA_CERTS=/usr/local/share/nemoclaw/corporate-ca.pem; \
    fi; \
    hermes_web_dist=/opt/hermes/hermes_cli/web_dist; \
    hermes_web_dir=/opt/hermes/web; \
    if [ ! -d "$hermes_web_dist" ]; then \
        if [ ! -f "$hermes_web_dir/package.json" ]; then \
            echo "ERROR: Hermes dashboard source missing at $hermes_web_dir" >&2; \
            exit 1; \
        fi; \
        if [ -f "$hermes_web_dir/package-lock.json" ]; then \
            npm ci --prefix "$hermes_web_dir" --prefer-offline --no-audit --no-fund; \
            npm run build --prefix "$hermes_web_dir"; \
            rm -rf "$hermes_web_dir/node_modules"; \
        elif grep -q '"web"' /opt/hermes/package-lock.json; then \
            npm ci --prefix /opt/hermes --prefer-offline --no-audit --no-fund; \
            npm run build --prefix /opt/hermes --workspace web; \
            npm ci --omit=dev --workspaces=false --prefix /opt/hermes \
                --prefer-offline --no-audit --no-fund; \
        else \
            echo "ERROR: Hermes dashboard at $hermes_web_dir is not covered by a pinned lockfile" >&2; \
            exit 1; \
        fi; \
    fi; \
    rm -rf /root/.npm /root/.cache/electron /root/.cache/node-gyp /root/.cache/uv; \
    test -d "$hermes_web_dist"

ENV HERMES_WEB_DIST="/opt/hermes/hermes_cli/web_dist"

# Harden: remove unnecessary build tools and network probes. build-essential
# comes from the base image for npm/node-gyp builds; the final image does not
# compile anything, so strip the installed compiler packages and fail closed if
# command shims survive.
RUN set -eu; \
    dpkg-query -W -f='${Package}\n' >/tmp/hermes-runtime-packages.txt; \
    grep -E '^(build-essential|make|gcc|g\+\+|cpp|gcc-[0-9]+|g\+\+-[0-9]+|cpp-[0-9]+|[[:alnum:]_-]+-linux-gnu-(gcc|g\+\+|cpp)(-[0-9]+)?|netcat-openbsd|netcat-traditional|ncat)$' /tmp/hermes-runtime-packages.txt >/tmp/hermes-runtime-tool-packages.txt || true; \
    if [ -s /tmp/hermes-runtime-tool-packages.txt ]; then xargs -r apt-get purge -y </tmp/hermes-runtime-tool-packages.txt; fi; \
    rm -f /tmp/hermes-runtime-packages.txt /tmp/hermes-runtime-tool-packages.txt; \
    apt-get autoremove --purge -y; \
    rm -rf /var/lib/apt/lists/*; \
    if command -v gcc >/dev/null 2>&1; then echo "ERROR: gcc survived runtime purge" >&2; exit 1; fi; \
    if command -v g++ >/dev/null 2>&1; then echo "ERROR: g++ survived runtime purge" >&2; exit 1; fi; \
    if command -v make >/dev/null 2>&1; then echo "ERROR: make survived runtime purge" >&2; exit 1; fi

# Hermes' WeChat adapter (gateway/platforms/weixin.py:_make_ssl_connector)
# builds aiohttp with ssl.create_default_context(cafile=certifi.where()),
# bypassing SSL_CERT_FILE. Symlink certifi's bundle at SSL_CERT_FILE so
# weixin TLS trusts the OpenShell L7 proxy CA. Done at image build (as
# root, which has write perms on the venv) because at runtime root doesn't
# see SSL_CERT_FILE and the gateway user can't write the venv.
# The target doesn't need to exist at build time — OpenShell mounts it at
# sandbox start; the forward-referencing symlink resolves then.
ARG SSL_CERT_FILE=/etc/openshell-tls/ca-bundle.pem
# hadolint ignore=DL3059
RUN _hermes_certifi=$(/opt/hermes/.venv/bin/python -c 'import certifi; print(certifi.where())') \
    && ln -sf "$SSL_CERT_FILE" "$_hermes_certifi"

# Hermes v2026.4.13+ auto-detects HTTPS_PROXY and skips fallback-IP
# transport when a proxy is present. OpenShell handles REST credential
# placeholder rewriting, hostname-based policy enforcement, and native
# WebSocket credential rewrite at the egress boundary.
ENV HERMES_TELEGRAM_DISABLE_FALLBACK_IPS=1
ENV HERMES_TUI_DIR="/opt/hermes/ui-tui"

COPY --from=hermes-agent-payload / /

# Managed MCP and ACP require their packaged Hermes client surfaces. A
# published base can carry the expected Hermes version while omitting either
# optional dependency group. This is a build-time package/import guard; live
# protocol behavior remains a separate E2E concern.
ARG NEMOCLAW_HERMES_IMAGE_BUILD_PROBES_SHA256=7c74c3f190845fef222e3aac1bd7074d58968447e78221114344545c149595c2
# hadolint ignore=DL3059,DL4006
RUN printf '%s  %s\n' \
        "$NEMOCLAW_HERMES_IMAGE_BUILD_PROBES_SHA256" /opt/nemoclaw-hermes-config/image-build-probes.py \
    | sha256sum -c - \
    || { echo "ERROR: image-build-probes.py hash mismatch (update NEMOCLAW_HERMES_IMAGE_BUILD_PROBES_SHA256)" >&2; exit 1; }; \
    /opt/hermes/.venv/bin/python -I \
        /opt/nemoclaw-hermes-config/image-build-probes.py managed-runtime-capability

# Ensure the NemoClaw plugin for Hermes is readable.
# hadolint ignore=DL3059
RUN chmod -R a+rX /opt/nemoclaw-hermes-plugin/

# Keep the config generator and its source dependencies root-owned and
# read-only.
RUN find /opt/nemoclaw-hermes-config -type d -exec chmod 755 {} + \
    && find /opt/nemoclaw-hermes-config -type f -exec chmod 444 {} + \
    && chmod 444 /src/lib/hermes-managed-route.ts /src/lib/tool-disclosure.ts \
    && chmod 444 /scripts/lib/reviewed-npm-archive.mts /scripts/lib/bundled-npm-package.mts \
        /scripts/lib/openclaw-npm-remediation.mts \
        /scripts/patch-bundled-npm-brace-expansion.mts /scripts/lib/patch-bundled-npm-ip-address.mts \
        /scripts/patch-bundled-npm-tar.mts \
    && chmod -R a+rX /src/lib/messaging

# Hermes 0.20.6 pins the Hindsight version but does not authenticate a
# same-version wheel selected by its lazy installer. Bind that production
# boundary to NVIDIA/NemoClaw's reviewed wheel hashes.
ARG NEMOCLAW_HERMES_HINDSIGHT_LAZY_INTEGRITY_PATCH_SHA256=5c619477c10e0b76cffd7adc214cbccf3beb77e7a1121f394c443502d9e0b736
ARG NEMOCLAW_HERMES_IMAGE_BUILD_PROBES_SHA256=7c74c3f190845fef222e3aac1bd7074d58968447e78221114344545c149595c2
# hadolint ignore=DL4006
RUN printf '%s  %s\n' \
        "$NEMOCLAW_HERMES_HINDSIGHT_LAZY_INTEGRITY_PATCH_SHA256" /opt/nemoclaw-hermes-config/hindsight-lazy-integrity.patch \
    | sha256sum -c - \
    && git -C /opt/hermes apply --check \
        --include=tools/lazy_deps.py \
        /opt/nemoclaw-hermes-config/hindsight-lazy-integrity.patch \
    && git -C /opt/hermes apply \
        --include=tools/lazy_deps.py \
        /opt/nemoclaw-hermes-config/hindsight-lazy-integrity.patch \
    && rm /opt/nemoclaw-hermes-config/hindsight-lazy-integrity.patch

COPY --from=hermes-runtime-payload / /

# Keep the root-owned managed-startup handoff in this image-only layer. The
# following permissions block is replayed on the host by regression tests.
RUN managed_runtime_assertion_failed() { \
      nemoclaw_assertion="$1"; \
      nemoclaw_artifact_path="$2"; \
      if [ -e "$nemoclaw_artifact_path" ] || [ -L "$nemoclaw_artifact_path" ]; then \
        if [ "${3:-}" = dereference ] && [ -e "$nemoclaw_artifact_path" ]; then \
          nemoclaw_metadata="$(stat -L -c 'uid=%u gid=%g type=%F mode=%a' -- "$nemoclaw_artifact_path" 2>/dev/null)" \
            || nemoclaw_metadata='uid=unavailable gid=unavailable type=unavailable mode=unavailable'; \
        else \
          nemoclaw_metadata="$(stat -c 'uid=%u gid=%g type=%F mode=%a' -- "$nemoclaw_artifact_path" 2>/dev/null)" \
            || nemoclaw_metadata='uid=unavailable gid=unavailable type=unavailable mode=unavailable'; \
        fi; \
        if [ -L "$nemoclaw_artifact_path" ]; then nemoclaw_symlink_state='yes'; else nemoclaw_symlink_state='no'; fi; \
      else \
        nemoclaw_metadata='uid=unavailable gid=unavailable type=missing mode=unavailable'; \
        nemoclaw_symlink_state='no'; \
      fi; \
      printf 'ERROR: managed image assertion failed: %s path=%s %s symlink=%s\n' \
        "$nemoclaw_assertion" "$nemoclaw_artifact_path" "$nemoclaw_metadata" "$nemoclaw_symlink_state" >&2; \
      exit 1; \
    }; \
    managed_image_command_failed() { \
      nemoclaw_command_assertion="$1"; \
      nemoclaw_command_status="$2"; \
      printf 'ERROR: managed image assertion failed: %s exit-status=%s\n' \
        "$nemoclaw_command_assertion" "$nemoclaw_command_status" >&2; \
      exit 1; \
    }; \
    if find -P /usr/local/lib/nemoclaw/mcp-tool-discovery-runtime -exec chown -h root:root '{}' + \
      && find -P /usr/local/lib/nemoclaw/mcp-tool-discovery-runtime -type d -exec chmod 0555 '{}' + \
      && find -P /usr/local/lib/nemoclaw/mcp-tool-discovery-runtime -type f -exec chmod 0444 '{}' +; then \
      :; \
    else \
      managed_image_command_failed mcp-tool-discovery-tree-permission-replay "$?"; \
    fi; \
    discovery_contract="$(node /usr/local/lib/nemoclaw/mcp-tool-discovery-runtime/mcp-tool-discovery.mjs)" \
      || managed_image_command_failed mcp-tool-discovery-bundle-execution "$?"; \
    node -e 'const expected = { protocol: 1, ok: false, detail: "tool discovery received invalid runtime arguments" }; const standaloneSecretPatterns = [/(?:nvapi-|nvcf-|gh[pousr]_|sk-proj-|sk-ant-|hf_|glpat-|gsk_|pypi-|tvly-)[A-Za-z0-9_-]{10,}/gu, /github_pat_[A-Za-z0-9_]{30,}/gu, /sk-[A-Za-z0-9_-]{20,}/gu, /(?:xox[bpas]|xapp)-[A-Za-z0-9-]{10,}/gu, /A(?:K|S)IA[A-Z0-9]{16}/gu, /\bbot\d{8,10}:[A-Za-z0-9_-]{35}\b/gu, /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/gu, /\b[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/gu, /lsv2_(?:pt|sk)_[A-Za-z0-9]{10,}(?:_[A-Za-z0-9]+)*/gu, /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{10,}\b/gu, /\b[A-Za-z0-9_=-]{32,}\b/gu]; const redactContextSecrets = (value) => value.replace(/\b(?:Bearer|Basic)\s+\S+/giu, "<REDACTED>").replace(/((?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]{1,128}_(?:KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PASSWD|PASS)|(?:X[-_])?API[-_]KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|PASSWD|PASS)["\x27]?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["\x27]?)[^\s"\x27]+/giu, (_match, prefix) => prefix + "<REDACTED>").replace(/((?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]{1,128}(?:Token|Secret|Credential)|[A-Za-z0-9]{0,128}(?:[Aa]ccess|[Rr]efresh|[Cc]lient|[Bb]earer|[Aa]uth|[Aa][Pp][Ii]|[Pp]rivate|[Ss]igning|[Ss]ession|[Bb]ot|[Aa]pp|[Rr]esolved)Key|[A-Za-z0-9]{1,128}(?:Password|Passwd|Pass))["\x27]?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["\x27]?)[^\s"\x27]+/gu, (_match, prefix) => prefix + "<REDACTED>").replace(/((?:^|[^A-Za-z0-9])KEY["\x27]?(?:[ \t]{0,32}[=:][ \t]{0,32}|[ \t]{1,32})["\x27]?)[^\s"\x27]+/gu, (_match, prefix) => prefix + "<REDACTED>"); const sanitize = (value) => { if (value === undefined) return "<missing>"; if (value === null || typeof value === "boolean" || typeof value === "number") return value; if (typeof value !== "string") return "<" + (Array.isArray(value) ? "array" : typeof value) + ">"; let printable = value.replace(/-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----[\s\S]*/gu, "<REDACTED>").replace(/[^\x20-\x7e]/gu, "?"); for (const pattern of standaloneSecretPatterns) printable = printable.replace(pattern, "<REDACTED>"); printable = redactContextSecrets(printable); return printable.length <= 240 ? printable : printable.slice(0, 237) + "..."; }; let result; let parsed = true; try { result = JSON.parse(process.argv[1]); } catch { parsed = false; } const record = parsed && result !== null && typeof result === "object" && !Array.isArray(result) ? result : undefined; if (record && record.protocol === expected.protocol && record.ok === expected.ok && record.detail === expected.detail) process.exit(0); const actual = record ? { protocol: sanitize(record.protocol), ok: sanitize(record.ok), detail: sanitize(record.detail) } : parsed ? { type: result === null ? "null" : Array.isArray(result) ? "array" : typeof result, value: sanitize(result) } : { type: "invalid-json", preview: sanitize(process.argv[1]) }; console.error("ERROR: managed image assertion failed: mcp-tool-discovery-json-contract actual=%s expected=%s", JSON.stringify(actual), JSON.stringify(expected)); process.exit(1);' "$discovery_contract" \
      || exit 1; \
    discovery_unsafe="$(find -L /usr/local/lib/nemoclaw/mcp-tool-discovery-runtime \( ! -user root -o -perm /022 \) -print -quit)" \
      || managed_image_command_failed mcp-tool-discovery-tree-find-execution "$?"; \
    { test -z "$discovery_unsafe" || managed_runtime_assertion_failed mcp-tool-discovery-tree-safety "$discovery_unsafe" dereference; } \
    && { test -f /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs || managed_runtime_assertion_failed regular-file /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs; } \
    && { test ! -L /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs || managed_runtime_assertion_failed non-symlink /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs; } \
    && { chown root:root /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs 2>/dev/null || managed_runtime_assertion_failed owner-root-root /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs; } \
    && { chmod 0444 /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs 2>/dev/null || managed_runtime_assertion_failed mode-0444 /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs; } \
    && { test "$(stat -c '%u:%g:%a' /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs 2>/dev/null)" = '0:0:444' || managed_runtime_assertion_failed metadata-0:0:444 /usr/local/lib/nemoclaw/managed-startup-image-runtime.cjs; } \
    && test -f /usr/local/bin/nemoclaw-managed-bootstrap \
    && test ! -L /usr/local/bin/nemoclaw-managed-bootstrap \
    && test "$(stat -c '%u:%g:%a' /usr/local/bin/nemoclaw-managed-bootstrap)" = '0:0:755' \
    && test -f /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh \
    && test ! -L /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh \
    && test "$(stat -c '%u:%g:%a' /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh)" = '0:0:444' \
    && install -d -o root -g root -m 0755 /run/nemoclaw /var/lib/nemoclaw

# Ensure sandbox user can read blueprint files copied as root
RUN chmod -R a+rX /opt/nemoclaw-blueprint/

# Apply runtime modes to the startup script and secret-boundary validator. The
# validator is the single source of truth used by start.sh at cold start and by
# its root-owned PID 1 lifecycle handler, so `recover` enforces the same boundary
# as startup.
# Dockerfile.base is the source of truth for rlimit hooks. This Hermes replay
# only repairs stale bases predating the v0.0.69 base layer, which may lack the
# profile hook, bashrc hook, or root-owned helper mode. Remove it once the
# minimum supported Hermes sandbox base tag guarantees those artifacts and
# test/runtime/sandbox/sandbox-rlimit-hooks.test.ts covers that base.
RUN chmod 755 /usr/local/bin/nemoclaw-start /usr/local/bin/nemoclaw-managed-startup-hold /usr/local/bin/nemoclaw-managed-bootstrap /usr/local/lib/nemoclaw/sandbox-init.sh /usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py /usr/local/lib/nemoclaw/patch-hermes-sqlite-temp-store.py /usr/local/lib/nemoclaw/patch-hermes-discord-recovery-permissions.py /usr/local/lib/nemoclaw/seed-hermes-dashboard-config.py /usr/local/lib/nemoclaw/hermes-runtime-config-guard.py /usr/local/lib/nemoclaw/finalize-tirith-marker.py /usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py \
    && chown root:root /usr/local/bin/nemoclaw-gateway-control /usr/local/lib/nemoclaw/gateway-supervisor.sh /usr/local/lib/nemoclaw/managed-gateway-control.py /usr/local/lib/nemoclaw/build-hermes-mcp-digest.py /usr/local/lib/nemoclaw/hermes-cron-restore-control.py /usr/local/lib/nemoclaw/openshell-child-visible-credentials.v0.0.106.json \
    && chmod 700 /usr/local/bin/nemoclaw-gateway-control /usr/local/lib/nemoclaw/hermes-cron-restore-control.py \
    && chmod 500 /usr/local/lib/nemoclaw/managed-gateway-control.py \
    && chmod 444 /usr/local/lib/nemoclaw/corporate-ca-runtime.sh /usr/local/lib/nemoclaw/entrypoint-env-wrapper.sh /usr/local/lib/nemoclaw/gateway-supervisor.sh /usr/local/lib/nemoclaw/build-hermes-mcp-digest.py /usr/local/lib/nemoclaw/managed_policy.py \
    && chmod 444 /usr/local/lib/nemoclaw/patch-hermes-langfuse-credentials.mts \
    && chmod 444 /usr/local/lib/nemoclaw/openshell-child-visible-credentials.v0.0.106.json \
    && /opt/hermes/.venv/bin/python3 -I -c 'import runpy, yaml; assert yaml.safe_load("ready: true")["ready"] is True; runpy.run_path("/usr/local/lib/nemoclaw/hermes-runtime-config-guard.py", run_name="nemoclaw_runtime_config_guard_probe")' \
    && if [ -d /usr/local/lib/nemoclaw/preloads ]; then \
        chown -R 0:0 /usr/local/lib/nemoclaw/preloads \
        && find /usr/local/lib/nemoclaw/preloads -type f -exec chmod 444 {} + \
        && find /usr/local/lib/nemoclaw/preloads -type d -exec chmod 755 {} + \
        ; \
    fi \
    && chmod 444 /usr/local/lib/nemoclaw/sandbox-rlimits.sh \
    && mkdir -p /etc/profile.d \
    && printf '%s\n' \
        '# NemoClaw sandbox resource limits — see sandbox-rlimits.sh (#2173)' \
        '[ -f /usr/local/lib/nemoclaw/sandbox-rlimits.sh ] && . /usr/local/lib/nemoclaw/sandbox-rlimits.sh && harden_resource_limits --quiet && verify_resource_limits --quiet || true' \
        > /etc/profile.d/nemoclaw-rlimits.sh \
    && chmod 444 /etc/profile.d/nemoclaw-rlimits.sh \
    && (chmod 644 /etc/bash.bashrc 2>/dev/null || true) \
    && { printf '%s\n' \
          '# NemoClaw sandbox resource limits — see sandbox-rlimits.sh (#2173)' \
          '[ -f /usr/local/lib/nemoclaw/sandbox-rlimits.sh ] && . /usr/local/lib/nemoclaw/sandbox-rlimits.sh && harden_resource_limits --quiet && verify_resource_limits --quiet || true' \
          ''; \
        if [ -f /etc/bash.bashrc ]; then \
          grep -Ev 'NemoClaw sandbox resource limits|sandbox-rlimits[.]sh' /etc/bash.bashrc || true; \
        fi; \
      } > /etc/bash.bashrc.new \
    && mv /etc/bash.bashrc.new /etc/bash.bashrc \
    && chmod 444 /etc/bash.bashrc

# Build-time assertion: fail immediately if the validator was not installed or
# made executable. Catches COPY path drift or a silent chmod failure.
RUN test -x /usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py \
    || { echo "ERROR: validate-hermes-env-secret-boundary.py missing or not executable" >&2; exit 1; }

# Hermes v0.20.6's operator drain is scoped to one container epoch. NemoClaw's
# rebuild drain must instead survive gateway and container restarts until the
# restored scripts and cron jobs are revalidated. Patch the pinned drain
# predicate to compose an independent root-owned marker, hydrate that predicate
# during GatewayRunner construction, and re-arm only unclaimed one-shots held
# overdue when the authenticated release record opens the gate.
ARG NEMOCLAW_HERMES_CRON_RESTORE_DRAIN_PATCHER_SHA256=d28c55ebad5a10c3086d2cf8360f136002f9a9fca1a9ec129f75365b76ef4a74
ARG NEMOCLAW_HERMES_DRAIN_CONTROL_SOURCE_SHA256=4195245d27b7b067b416b69f4728fcfcdd97c912bdb0954f14402b35601f76cc
ARG NEMOCLAW_HERMES_GATEWAY_RUN_SOURCE_SHA256=8b8def1d9cb8088d4de7dd3d920d31fb0d959f4d6ffffadf6dd8f8320da5e00b
ARG NEMOCLAW_HERMES_CRON_JOBS_SOURCE_SHA256=dd5c7c601e23e5058e93d824b17ff426ed2cc5113c20d431ea4937274be59923
ARG NEMOCLAW_HERMES_DRAIN_CONTROL_PATCHED_SHA256=6d1c20afd6d0030a4d7c0fcc5a82dea1a9d9b912886aff1343597cfe74be1c8a
ARG NEMOCLAW_HERMES_GATEWAY_RUN_DRAIN_PATCHED_SHA256=30a36097a525449bc9d3b721ba3c3047b1c4f2d8a19da8027bb280867c2d6823
ARG NEMOCLAW_HERMES_CRON_JOBS_DRAIN_PATCHED_SHA256=1ff52425b966497831e911eb89e7707238d7a03e1839f8c941ded3eedb3216dd
# hadolint ignore=DL4006
RUN printf '%s  %s\n' \
        "$NEMOCLAW_HERMES_CRON_RESTORE_DRAIN_PATCHER_SHA256" /opt/nemoclaw-hermes-config/patch-cron-restore-drain.py \
        "$NEMOCLAW_HERMES_DRAIN_CONTROL_SOURCE_SHA256" /opt/hermes/gateway/drain_control.py \
        "$NEMOCLAW_HERMES_GATEWAY_RUN_SOURCE_SHA256" /opt/hermes/gateway/run.py \
        "$NEMOCLAW_HERMES_CRON_JOBS_SOURCE_SHA256" /opt/hermes/cron/jobs.py \
    | sha256sum -c - \
    || { echo "ERROR: Hermes cron restore drain source identity mismatch" >&2; exit 1; }
# hadolint ignore=DL4006
RUN /usr/bin/python3 -I \
        /opt/nemoclaw-hermes-config/patch-cron-restore-drain.py \
        --drain-control /opt/hermes/gateway/drain_control.py \
        --gateway-run /opt/hermes/gateway/run.py \
        --cron-jobs /opt/hermes/cron/jobs.py \
    && printf '%s  %s\n' \
        "$NEMOCLAW_HERMES_DRAIN_CONTROL_PATCHED_SHA256" /opt/hermes/gateway/drain_control.py \
        "$NEMOCLAW_HERMES_GATEWAY_RUN_DRAIN_PATCHED_SHA256" /opt/hermes/gateway/run.py \
        "$NEMOCLAW_HERMES_CRON_JOBS_DRAIN_PATCHED_SHA256" /opt/hermes/cron/jobs.py \
    | sha256sum -c -

# Hermes v0.20.6 writes gateway lifecycle metadata directly below HERMES_HOME.
# Managed stop/start recovery needs this metadata in the writable runtime
# boundary. Relocate only Hermes's central PID/lock/status path helpers to the
# existing writable runtime
# directory while preserving Hermes's process-scoped home selection. Direct
# upstream --replace/stop and named-profile consumers remain the documented
# inherited residual; this probe does not claim a complete upstream relocation.
ARG NEMOCLAW_HERMES_GATEWAY_RUNTIME_METADATA_PATCHER_SHA256=d5fc78c39f15ac2da436a48aa5df82af9b2aacb7f19fd7e449ffd154b871de60
# hadolint ignore=DL4006
RUN printf '%s  %s\n' \
        "$NEMOCLAW_HERMES_GATEWAY_RUNTIME_METADATA_PATCHER_SHA256" /opt/nemoclaw-hermes-config/patch-gateway-runtime-metadata.py \
    | sha256sum -c - \
    || { echo "ERROR: patch-gateway-runtime-metadata.py hash mismatch (update NEMOCLAW_HERMES_GATEWAY_RUNTIME_METADATA_PATCHER_SHA256)" >&2; exit 1; }
RUN /usr/bin/python3 -I \
        /opt/nemoclaw-hermes-config/patch-gateway-runtime-metadata.py \
        /opt/hermes/gateway/status.py \
    && HERMES_HOME="$(mktemp -d)" /opt/hermes/.venv/bin/python -I \
        /opt/nemoclaw-hermes-config/image-build-probes.py gateway-runtime-metadata

# NemoClaw installs its wrapper as `hermes` and moves the real entrypoint to
# `hermes.real`, so every managed gateway command line carries that basename.
# Hermes only accepts `hermes`/`hermes.exe` as the entry token, which defeats
# both the PID-file liveness re-check and the process-table fallback, so
# `hermes status` reports a running foreground gateway as stopped (#7804).
ARG NEMOCLAW_HERMES_GATEWAY_PROCESS_IDENTITY_PATCHER_SHA256=1720f557e57c4755b9de47eece2c9c8ad182e1196c40d2783f1768fc5a426681
# hadolint ignore=DL4006
RUN printf '%s  %s\n' \
        "$NEMOCLAW_HERMES_GATEWAY_PROCESS_IDENTITY_PATCHER_SHA256" /opt/nemoclaw-hermes-config/patch-gateway-process-identity.py \
    | sha256sum -c - \
    || { echo "ERROR: patch-gateway-process-identity.py hash mismatch (update NEMOCLAW_HERMES_GATEWAY_PROCESS_IDENTITY_PATCHER_SHA256)" >&2; exit 1; }
RUN /usr/bin/python3 -I \
        /opt/nemoclaw-hermes-config/patch-gateway-process-identity.py \
        /opt/hermes/gateway/status.py \
    && /opt/hermes/.venv/bin/python -I \
        /opt/nemoclaw-hermes-config/image-build-probes.py gateway-process-identity

# Hermes v0.20.6 creates its writable cron execution-history database below
# the directory that contains cron job definitions. Relocate only this audit
# database to the existing cross-UID runtime boundary, and keep
# Hermes' quick snapshot inventory aligned. Full source hashes and shape-constrained
# patching force a fresh review when either pinned upstream module changes.
ARG NEMOCLAW_HERMES_CRON_RUNTIME_PATCHER_SHA256=b8aae8925cacad654d7b09900bd1cc02d776feaec4662c06dde8f4b2f356e22e
ARG NEMOCLAW_HERMES_CRON_EXECUTIONS_SOURCE_SHA256=b4a685a901abdffe2d1232099b3c27391775775a7011d52c90276cb15d3fd75d
ARG NEMOCLAW_HERMES_BACKUP_SOURCE_SHA256=b0838c1f2e120d8f97076c6321297077edc1f150dc6d4b84ba3d13327fcbb156
# hadolint ignore=DL4006
RUN printf '%s  %s\n' \
        "$NEMOCLAW_HERMES_CRON_RUNTIME_PATCHER_SHA256" /opt/nemoclaw-hermes-config/patch-cron-execution-runtime.py \
        "$NEMOCLAW_HERMES_CRON_EXECUTIONS_SOURCE_SHA256" /opt/hermes/cron/executions.py \
        "$NEMOCLAW_HERMES_BACKUP_SOURCE_SHA256" /opt/hermes/hermes_cli/backup.py \
    | sha256sum -c - \
    || { echo "ERROR: Hermes cron execution runtime source identity mismatch" >&2; exit 1; }
RUN /usr/bin/python3 -I \
        /opt/nemoclaw-hermes-config/patch-cron-execution-runtime.py \
        --executions /opt/hermes/cron/executions.py \
        --backup /opt/hermes/hermes_cli/backup.py
RUN set -eu; \
    probe_home="$(mktemp -d)"; \
    trap 'rm -rf "$probe_home"' EXIT; \
    HERMES_HOME="$probe_home" /opt/hermes/.venv/bin/python -I \
        /opt/nemoclaw-hermes-config/image-build-probes.py cron-runtime-source \
    && rm /opt/nemoclaw-hermes-config/patch-gateway-runtime-metadata.py \
        /opt/nemoclaw-hermes-config/patch-gateway-process-identity.py \
        /opt/nemoclaw-hermes-config/patch-cron-execution-runtime.py \
        /opt/nemoclaw-hermes-config/patch-cron-restore-drain.py

# Hermes v0.20.6 computes `sessions list` preview from the first user message.
# Its workspace-aware titled table then hides the preview behind an automatic
# seed title. Patch both pinned source shapes and prove that an automatically
# titled workspace row renders the latest resumed or continued one-shot turn
# while a user-authored title remains authoritative.
ARG NEMOCLAW_HERMES_SESSION_LIST_PREVIEW_PATCHER_SHA256=718315e7c36727ca49ac88a1be44f95e4d495ca737ba70d5bb3d5c509fd9a0e2
# hadolint ignore=DL4006
RUN printf '%s  %s\n' \
        "$NEMOCLAW_HERMES_SESSION_LIST_PREVIEW_PATCHER_SHA256" /opt/nemoclaw-hermes-config/patch-session-list-preview.py \
    | sha256sum -c - \
    || { echo "ERROR: patch-session-list-preview.py hash mismatch (update NEMOCLAW_HERMES_SESSION_LIST_PREVIEW_PATCHER_SHA256)" >&2; exit 1; }; \
    /usr/bin/python3 -I /opt/nemoclaw-hermes-config/patch-session-list-preview.py \
    && grep -q 'ORDER BY m.timestamp DESC, m.id DESC LIMIT 1' /opt/hermes/hermes_state.py \
    && grep -Fq 'if s.get("title_source") in ("derived", "llm")' /opt/hermes/hermes_cli/sessions_cmd.py \
    && HERMES_HOME="$(mktemp -d)" /opt/hermes/.venv/bin/python -I \
        /opt/nemoclaw-hermes-config/image-build-probes.py session-preview \
    && rm /opt/nemoclaw-hermes-config/patch-session-list-preview.py

# Hermes v0.20.6 SessionDB does not set PRAGMA temp_store=MEMORY, so SQLite
# falls back to file-based temp storage for FK constraint processing (for
# example, the ON DELETE CASCADE on session_model_usage -> sessions). The
# OpenShell sandbox execution context used by
# `nemohermes <sandbox> sessions delete <id>` restricts the temp-file creation
# syscalls that SQLite's FK engine relies on, causing every
# `DELETE FROM sessions` with FK enforcement to raise
# `sqlite3.OperationalError: unable to open database file` (#8301). Inserting
# PRAGMA temp_store=MEMORY before PRAGMA foreign_keys=ON ensures FK processing
# uses in-memory storage. Docker execution permits the file-based storage path.
ARG NEMOCLAW_HERMES_SQLITE_TEMP_STORE_PATCHER_SHA256=495afa4b7b960a3df8d46c2380561307773449ca5bfa96ca8f4a49c4147c4b6a
# hadolint ignore=DL4006
RUN printf '%s  %s\n' \
        "$NEMOCLAW_HERMES_SQLITE_TEMP_STORE_PATCHER_SHA256" /usr/local/lib/nemoclaw/patch-hermes-sqlite-temp-store.py \
    | sha256sum -c - \
    || { echo "ERROR: patch-hermes-sqlite-temp-store.py hash mismatch (update NEMOCLAW_HERMES_SQLITE_TEMP_STORE_PATCHER_SHA256)" >&2; exit 1; }
RUN /usr/bin/python3 -I /usr/local/lib/nemoclaw/patch-hermes-sqlite-temp-store.py \
    && grep -q 'PRAGMA temp_store=MEMORY' /opt/hermes/hermes_state.py \
    && HERMES_HOME="$(mktemp -d)" /opt/hermes/.venv/bin/python -I \
        /opt/nemoclaw-hermes-config/image-build-probes.py session-delete

# Hermes v0.20.6 forces the gateway-created Discord recovery ledger to 0600,
# which prevents sandbox-owned online backup and makes a sandbox-restored
# database unwritable by the gateway. The final layout uses a gateway:sandbox
# setgid parent, and this source patch retains group write on the ledger.
# Remove it when upstream supports an equivalent cross-identity mode contract.
ARG NEMOCLAW_HERMES_DISCORD_RECOVERY_PATCHER_SHA256=5e47a50da6290a2cc4604904aa70192c2b5f59c1e66af4f154ab452bc0e23899
# hadolint ignore=DL4006
RUN printf '%s  %s\n' \
        "$NEMOCLAW_HERMES_DISCORD_RECOVERY_PATCHER_SHA256" /usr/local/lib/nemoclaw/patch-hermes-discord-recovery-permissions.py \
    | sha256sum -c - \
    || { echo "ERROR: patch-hermes-discord-recovery-permissions.py hash mismatch (update NEMOCLAW_HERMES_DISCORD_RECOVERY_PATCHER_SHA256)" >&2; exit 1; }
RUN /usr/bin/python3 -I /usr/local/lib/nemoclaw/patch-hermes-discord-recovery-permissions.py \
        /opt/hermes/plugins/platforms/discord/recovery.py \
    && /usr/bin/python3 -I /opt/nemoclaw-hermes-config/image-build-probes.py \
        discord-recovery-source

# Pin the Hermes definitions the Google Chat override binds, so an upgrade fails
# this build instead of silently falling back to the stock adapter.
RUN /usr/bin/python3 -I /opt/nemoclaw-hermes-config/image-build-probes.py \
        googlechat-override-seams

# Hermes v0.20.6's bundled Langfuse plugin rejects OpenShell resolver
# placeholders before the SDK can construct its Basic-auth headers. Accept only
# the OpenShell public and secret placeholders when each placeholder is bound
# to its matching standard Langfuse key. Raw keys keep Hermes' upstream
# pk-lf-/sk-lf- validation, and every authenticated client requires an absolute
# HTTPS base URL. The patcher fails closed when the pinned source shape changes.
ARG NEMOCLAW_HERMES_LANGFUSE_PATCHER_SHA256=c1f490f1a5ee6bbcceec628a5180b309dec66d539f71b8ce2bf2de08ccb5eadd
# hadolint ignore=DL4006
RUN printf '%s  %s\n' \
        "$NEMOCLAW_HERMES_LANGFUSE_PATCHER_SHA256" /usr/local/lib/nemoclaw/patch-hermes-langfuse-credentials.mts \
    | sha256sum -c - \
    || { echo "ERROR: patch-hermes-langfuse-credentials.mts hash mismatch (update NEMOCLAW_HERMES_LANGFUSE_PATCHER_SHA256)" >&2; exit 1; }
RUN node --experimental-strip-types \
        /usr/local/lib/nemoclaw/patch-hermes-langfuse-credentials.mts \
        /opt/hermes/plugins/observability/langfuse/__init__.py \
    && /opt/hermes/.venv/bin/python -I \
        /opt/nemoclaw-hermes-config/image-build-probes.py langfuse-credentials

# Cryptographic integrity gate for the security-critical entrypoints: the
# wrapper, its CLI adapter, the runtime env validator, the descriptor-safe
# Tirith marker finalizer, and cron restore control. Cron restore control is the
# rebuild-time gate that keeps Hermes cron dispatch disabled until the restored
# jobs and scripts are validated. Any content change must be accompanied by an
# updated hash below; otherwise the build fails. This blocks
# silent supply-chain tampering of the build context (an attacker rewriting a
# file has to also rewrite the Dockerfile-committed hash, which reviewers gate).
# Regenerate with `sha256sum agents/hermes/{hermes-wrapper.py,hermes-cli-adapter-v1.json,validate-cli-adapter.py,validate-env-secret-boundary.py,finalize-tirith-marker.py,cron-restore-control.py}`.
ARG NEMOCLAW_HERMES_CLI_ADAPTER_SHA256=3c769f05292b840424a8feec9a9eb441e393a48bf0212bd824b0db8a33a66331
ARG NEMOCLAW_HERMES_WRAPPER_SHA256=b008a27a53c8ddc1189d3ba03490e29e48c5a026f412deeb73b0bc3098923214
ARG NEMOCLAW_HERMES_CLI_ADAPTER_VALIDATOR_SHA256=db4046e79e513eab67b069a8eda20167b8b65529cf26842531d2ad673c670330
ARG NEMOCLAW_HERMES_VALIDATOR_SHA256=6937ddb650532e473b84a5e56fb26573491d1bc20230ba6c2bfd2e6f6d777edb
ARG NEMOCLAW_HERMES_TIRITH_FINALIZER_SHA256=a1e6b1c53ab297569abb87c29d15c294d729e46005bfd022136b4c447a791819
ARG NEMOCLAW_HERMES_CRON_RESTORE_CONTROLLER_SHA256=dbd32832383f174878c08529947f5d81911152e1516b6f960824db3c7f7ac1e9
# hadolint ignore=DL4006
RUN printf '%s  %s\n' \
        "$NEMOCLAW_HERMES_VALIDATOR_SHA256" /usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py \
    | sha256sum -c - \
    || { echo "ERROR: validate-hermes-env-secret-boundary.py hash mismatch (update NEMOCLAW_HERMES_VALIDATOR_SHA256)" >&2; exit 1; }
# hadolint ignore=DL4006
RUN printf '%s  %s\n' \
        "$NEMOCLAW_HERMES_TIRITH_FINALIZER_SHA256" /usr/local/lib/nemoclaw/finalize-tirith-marker.py \
    | sha256sum -c - \
    || { echo "ERROR: finalize-tirith-marker.py hash mismatch (update NEMOCLAW_HERMES_TIRITH_FINALIZER_SHA256)" >&2; exit 1; }
# hadolint ignore=DL4006
RUN printf '%s  %s\n' \
        "$NEMOCLAW_HERMES_CRON_RESTORE_CONTROLLER_SHA256" /usr/local/lib/nemoclaw/hermes-cron-restore-control.py \
    | sha256sum -c - \
    || { echo "ERROR: hermes-cron-restore-control.py hash mismatch (update NEMOCLAW_HERMES_CRON_RESTORE_CONTROLLER_SHA256)" >&2; exit 1; }

# Wrap the hermes CLI so the runtime env secret boundary is enforced for
# `hermes gateway` no matter how it is invoked. The entrypoint guard alone left
# a direct `docker exec ... hermes gateway run` able to start the gateway with
# raw secret-shaped env vars (#4975). Relocate the real binary and install the
# wrapper in its place; the wrapper reuses the same validator and execs the real
# binary for every non-gateway subcommand. Re-assert --version through the
# wrapper so a broken relocation fails the build.
#
# The wrapper's shebang pins `/usr/bin/python3 -I` (isolated mode); fail the
# build if that absolute path is missing or non-executable so a base-image
# upgrade that drops it cannot ship a wrapper that ENOEXECs at runtime.
COPY --from=hermes-wrapper-payload / /

RUN test -x /usr/bin/python3 \
    || { echo "ERROR: /usr/bin/python3 missing or not executable; hermes-wrapper shebang would ENOEXEC" >&2; exit 1; }; \
    /opt/hermes/.venv/bin/python -I \
        /opt/nemoclaw-hermes-config/image-build-probes.py compatibility-retirement
# hadolint ignore=DL4006
RUN printf '%s  %s\n' \
        "$NEMOCLAW_HERMES_WRAPPER_SHA256" /usr/local/lib/nemoclaw/hermes-wrapper.py \
        "$NEMOCLAW_HERMES_CLI_ADAPTER_SHA256" /usr/local/share/nemoclaw/hermes-cli-adapter-v1.json \
        "$NEMOCLAW_HERMES_CLI_ADAPTER_VALIDATOR_SHA256" /usr/local/lib/nemoclaw/validate-hermes-cli-adapter.py \
    | sha256sum -c - \
    || { echo "ERROR: Hermes CLI adapter integrity mismatch" >&2; exit 1; }
# Validate the versioned adapter against Hermes' parser metadata and session-name
# coalescer source before the real binary moves behind the wrapper. The wrapper
# reads the installed coalescer source at runtime. Help probes remain runtime
# evidence for the top-level and chat surfaces.
RUN /opt/hermes/.venv/bin/python -I \
        /usr/local/lib/nemoclaw/validate-hermes-cli-adapter.py \
        --contract /usr/local/share/nemoclaw/hermes-cli-adapter-v1.json \
        --hermes /usr/local/bin/hermes
RUN mv /usr/local/bin/hermes /usr/local/bin/hermes.real \
    && install -m 0755 /usr/local/lib/nemoclaw/hermes-wrapper.py /usr/local/bin/hermes \
    && chmod 755 /usr/local/lib/nemoclaw/validate-hermes-cli-adapter.py \
    && chmod 444 /usr/local/share/nemoclaw/hermes-cli-adapter-v1.json \
    && chmod 755 /usr/local/bin/hermes.real \
    && /usr/local/bin/hermes --version

# Build args for config that varies per deployment.
ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b
# Non-secret managed inference route identifier ("inference" for proxied
# providers, or a provider family such as "openai"). Never a credential.
ARG NEMOCLAW_INFERENCE_PROVIDER_ID=custom
# User-selected upstream provider name (nvidia-prod, hermes-provider, ...).
# Distinct from NEMOCLAW_INFERENCE_PROVIDER_ID, which carries the managed route
# identifier ("inference" for proxied providers) needed at routing/runtime.
ARG NEMOCLAW_UPSTREAM_PROVIDER=custom
ARG NEMOCLAW_INFERENCE_BASE_URL=https://inference.local/v1
ARG NEMOCLAW_INFERENCE_API=openai-completions
ARG NEMOCLAW_TOOL_DISCLOSURE=progressive
# CHAT_UI_URL is a legacy name shared with the OpenClaw build arg. For
# Hermes this URL points at the browser dashboard. The OpenAI-compatible
# API remains exposed separately on port 8642.
ARG CHAT_UI_URL=http://127.0.0.1:18789
ARG NEMOCLAW_MESSAGING_PLAN_B64=
# Release-image mode preinstalls every reviewed optional dependency while
# keeping the generated Hermes platform configuration disabled by default.
ARG NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=0
ARG NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER=root
ARG NEMOCLAW_WEB_SEARCH_ENABLED=0
ARG NEMOCLAW_WEB_SEARCH_PROVIDER=tavily
ARG NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER=0
ARG NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64=W10=
ARG NEMOCLAW_BUILD_ID=default
ARG NEMOCLAW_DARWIN_VM_COMPAT=0
# Total model context window (input + output tokens). Empty by default so
# Hermes auto-detects from the endpoint's /v1/models max_model_len; onboard
# rewrites this ARG (via dockerfile-patch) when it probes a runtime value or
# the user sets NEMOCLAW_CONTEXT_WINDOW, so Hermes' NemotronH metadata default
# cannot override the real window (#6177).
ARG NEMOCLAW_CONTEXT_WINDOW=

# Promote persistent image config to env vars for config generation.
# NEMOCLAW_MESSAGING_PLAN_B64 intentionally remains ARG-only: Docker exposes it
# to build RUN processes without retaining the full plan in the final image env.
ENV NEMOCLAW_MODEL=${NEMOCLAW_MODEL} \
    NEMOCLAW_INFERENCE_PROVIDER_ID=${NEMOCLAW_INFERENCE_PROVIDER_ID} \
    NEMOCLAW_UPSTREAM_PROVIDER=${NEMOCLAW_UPSTREAM_PROVIDER} \
    NEMOCLAW_INFERENCE_BASE_URL=${NEMOCLAW_INFERENCE_BASE_URL} \
    NEMOCLAW_INFERENCE_API=${NEMOCLAW_INFERENCE_API} \
    NEMOCLAW_CONTEXT_WINDOW=${NEMOCLAW_CONTEXT_WINDOW} \
    NEMOCLAW_TOOL_DISCLOSURE=${NEMOCLAW_TOOL_DISCLOSURE} \
    CHAT_UI_URL=${CHAT_UI_URL} \
    NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=${NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION} \
    NEMOCLAW_WEB_SEARCH_ENABLED=${NEMOCLAW_WEB_SEARCH_ENABLED} \
    NEMOCLAW_WEB_SEARCH_PROVIDER=${NEMOCLAW_WEB_SEARCH_PROVIDER} \
    NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER=${NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER} \
    NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64=${NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64}

RUN case "$NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION" in \
        0) ;; \
        1) \
            test -z "$NEMOCLAW_MESSAGING_PLAN_B64" \
                || { echo "ERROR: managed-image capability union requires an empty messaging plan" >&2; exit 1; }; \
            test "$NEMOCLAW_WEB_SEARCH_ENABLED" = "0" \
                || { echo "ERROR: managed-image capability union requires web search disabled in the neutral image" >&2; exit 1; }; \
            test "$NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER" = "0" \
                || { echo "ERROR: managed-image capability union requires tool gateways disabled in the neutral image" >&2; exit 1; } \
            ;; \
        *) echo "ERROR: NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION must be 0 or 1" >&2; exit 1 ;; \
    esac \
    && test "$NEMOCLAW_MANAGED_IMAGE_RUNTIME_USER" = "root"

# Bake reduced messaging runtime metadata for the entrypoint. Hermes runtime
# config refresh consumes generic manifest-owned aliases from this artifact.
# hadolint ignore=DL3059
RUN node --experimental-strip-types /src/lib/messaging/applier/build/messaging-build-applier.mts --agent hermes --phase runtime-setup \
    && runtime_plan=/usr/local/share/nemoclaw/messaging-runtime-plan.json \
    && { [ ! -f "$runtime_plan" ] || { test ! -L "$runtime_plan" \
    && node -e "const fs=require('fs'); const path=process.argv[1]; const st=fs.statSync(path); if (!st.isFile() || st.uid !== 0 || st.gid !== 0 || (st.mode & 0o022) !== 0) throw new Error('unsafe runtime plan file metadata'); const p=JSON.parse(fs.readFileSync(path,'utf8')); for (const k of ['agentRender','buildSteps','stateUpdates','healthChecks']) if (Object.hasOwn(p,k)) throw new Error('runtime plan contains unreduced key '+k); const runtimeSetup=p.runtimeSetup; const isObject=(v)=>v && typeof v === 'object' && !Array.isArray(v); if (!isObject(runtimeSetup) || !Array.isArray(runtimeSetup.nodePreloads) || !Array.isArray(runtimeSetup.envAliases) || !Array.isArray(runtimeSetup.secretScans) || !runtimeSetup.nodePreloads.every(isObject) || !runtimeSetup.envAliases.every(isObject) || !runtimeSetup.secretScans.every(isObject)) throw new Error('runtime plan missing reduced runtimeSetup shape');" "$runtime_plan"; }; }

# Apply messaging agent-install hooks as root so Hermes Python packages can update
# /opt/hermes/.venv before the runtime drops to the sandbox user.
WORKDIR /opt/hermes
# Clear inherited Python and uv trust overrides before package installation.
# When the decoded corporate CA exists, use it only for this RUN instruction.
# hadolint ignore=DL3059
RUN unset SSL_CERT_FILE REQUESTS_CA_BUNDLE; \
    if [ -f /usr/local/share/nemoclaw/corporate-ca.pem ]; then \
      export SSL_CERT_FILE=/usr/local/share/nemoclaw/corporate-ca.pem; \
      export REQUESTS_CA_BUNDLE=/usr/local/share/nemoclaw/corporate-ca.pem; \
    fi; \
    node --experimental-strip-types /src/lib/messaging/applier/build/messaging-build-applier.mts --agent hermes --phase agent-install

# Managed images have no serialized messaging plan. Install their complete
# reviewed package union from the selected wheel stage. Portable Podman uses the
# classic Dockerfile parser, which supports cross-stage COPY but not BuildKit's
# RUN --mount or RUN --network options. UV_OFFLINE keeps package resolution
# independent of registry access.
COPY --from=hermes-managed-teams-wheels / /opt/nemoclaw-hermes-teams-wheels/
# hadolint ignore=DL3059
RUN if [ "$NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION" = "1" ]; then \
        UV_OFFLINE=true UV_FIND_LINKS=/opt/nemoclaw-hermes-teams-wheels \
        node --experimental-strip-types /src/lib/messaging/applier/build/messaging-build-applier.mts \
            --agent hermes --phase managed-image-capability-union; \
    fi \
    && /opt/hermes/.venv/bin/python -I -c \
        "from importlib.metadata import version; expected = {'aiohttp': '3.14.3', 'cryptography': '50.0.0'}; actual = {name: version(name) for name in expected}; assert actual == expected, actual" \
    && rm -rf /opt/nemoclaw-hermes-teams-wheels

WORKDIR /sandbox
RUN test "$(id -u sandbox):$(id -g sandbox):$(pwd)" = "998:999:/sandbox" \
    && rm -rf /sandbox/.cache
USER sandbox

# Set up blueprint for local resolution
RUN mkdir -p /sandbox/.nemoclaw/blueprints/0.1.0 \
    && cp -r /opt/nemoclaw-blueprint/* /sandbox/.nemoclaw/blueprints/0.1.0/

# Run Hermes' upstream repair before NemoClaw writes the generated config.yaml
# and .env that become the startup integrity trust anchor. Doctor-created
# defaults are overwritten by the generator below.
# Generate Hermes config.yaml and .env from build args.
# Config remains mutable (600 sandbox:sandbox). .env holds API key placeholders
# for the OpenShell provider pipeline.
# SECURITY: Uses a separate script file instead of inline code to avoid
# code injection via build-arg interpolation (same concern as OpenClaw C-2).
RUN /opt/hermes/.venv/bin/python -I \
        /opt/nemoclaw-hermes-config/image-build-probes.py prepare-generated-config \
    && if [ "$NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION" = "1" ]; then \
        /opt/hermes/.venv/bin/python -I -c 'import importlib.metadata as m, pathlib, yaml; config=yaml.safe_load(pathlib.Path("/sandbox/.hermes/config.yaml").read_text()); neutral={name: value for name, value in config["platforms"].items() if name != "api_server"}; assert len(neutral) == 32; assert all(value == {"enabled": False} for value in neutral.values()); assert m.version("microsoft-teams-apps") == "2.0.13.4"; assert m.version("aiohttp") == "3.14.3"'; \
    fi \
    && rm -rf /sandbox/.cache

USER root

# Install the generated policy manifest outside the mutable Hermes home. Python
# consumers read this versioned artifact instead of embedding managed defaults.
RUN install -o root -g root -m 0444 \
        /sandbox/.hermes/managed-policy.json \
        /usr/local/share/nemoclaw/hermes-managed-policy.json \
    && rm -f /sandbox/.hermes/managed-policy.json

# Fresh named profiles do not receive config.yaml. Patch the pinned Hermes
# fallback readers from the generated manifest, then validate a real profile.
ARG NEMOCLAW_HERMES_PROFILE_POLICY_PATCHER_SHA256=71388064485328862ea1783d24dc576f0c99a6d22057d2bc0f81af15697c05f6
# hadolint ignore=DL4006
RUN printf '%s  %s\n' \
        "$NEMOCLAW_HERMES_PROFILE_POLICY_PATCHER_SHA256" /opt/nemoclaw-hermes-config/patch-profile-policy-defaults.py \
    | sha256sum -c - \
    || { echo "ERROR: patch-profile-policy-defaults.py hash mismatch (update NEMOCLAW_HERMES_PROFILE_POLICY_PATCHER_SHA256)" >&2; exit 1; }; \
    /usr/bin/python3 -I /opt/nemoclaw-hermes-config/patch-profile-policy-defaults.py \
    && grep -Fqx '    env["npm_config_offline"] = "true"' /opt/hermes/tools/browser_tool.py \
    && rm /opt/nemoclaw-hermes-config/patch-profile-policy-defaults.py \
        /opt/nemoclaw-hermes-config/managed_policy.py
# Hermes v0.20.6 has several built-in environment override paths that can
# re-enable an explicitly disabled platform when ambient credentials exist.
# Apply this after the profile-policy patch above, then bind both its
# output module and this narrow patcher before preserving explicit disables
# across environment processing.
ARG NEMOCLAW_HERMES_NEUTRAL_PLATFORM_PATCHER_SHA256=43b90f768d5a627417d1eef72427abb1cf256e348cd7d1a91bf2afd32fe9894b
ARG NEMOCLAW_HERMES_POST_PROFILE_GATEWAY_CONFIG_SHA256=c0080c4da9b04c4749e92561c1c68a3f4debbc62a502cd47b139180442219621
ARG NEMOCLAW_HERMES_NEUTRAL_PLATFORM_OUTPUT_SHA256=6fd9eac44ddb41d4e6684964b73693a1b830e504eff4f3113c8391461805eec8
# hadolint ignore=DL4006
RUN printf '%s  %s\n' \
        "$NEMOCLAW_HERMES_NEUTRAL_PLATFORM_PATCHER_SHA256" /opt/nemoclaw-hermes-config/patch-neutral-platform-env-activation.py \
        "$NEMOCLAW_HERMES_POST_PROFILE_GATEWAY_CONFIG_SHA256" /opt/hermes/gateway/config.py \
    | sha256sum -c - \
    || { echo "ERROR: Hermes neutral platform environment source identity mismatch" >&2; exit 1; }; \
    /usr/bin/python3 -I \
        /opt/nemoclaw-hermes-config/patch-neutral-platform-env-activation.py \
        /opt/hermes/gateway/config.py \
    && printf '%s  %s\n' \
        "$NEMOCLAW_HERMES_NEUTRAL_PLATFORM_OUTPUT_SHA256" /opt/hermes/gateway/config.py \
    | sha256sum -c -

# A2A has no accepted NVIDIA/NemoClaw product scope. Keep the inbound adapter
# disabled and remove its outbound tools from every Hermes process.
ARG NEMOCLAW_HERMES_A2A_NEUTRAL_PATCH_SHA256=f265d2023472d0cb375d7b302fb5ca88585766ba6943c519a755a987cfe3f7ce
# hadolint ignore=DL4006
RUN printf '%s  %s\n' \
        "$NEMOCLAW_HERMES_A2A_NEUTRAL_PATCH_SHA256" /opt/nemoclaw-hermes-config/a2a-neutral.patch \
    | sha256sum -c - \
    && git -C /opt/hermes apply --check \
        --include=plugins/platforms/a2a/plugin.yaml \
        --include=plugins/platforms/a2a/__init__.py \
        /opt/nemoclaw-hermes-config/a2a-neutral.patch \
    && git -C /opt/hermes apply \
        --include=plugins/platforms/a2a/plugin.yaml \
        --include=plugins/platforms/a2a/__init__.py \
        /opt/nemoclaw-hermes-config/a2a-neutral.patch \
    && ! grep -Fq 'provides_tools:' /opt/hermes/plugins/platforms/a2a/plugin.yaml \
    && ! grep -Fq 'from .tools import register_tools' /opt/hermes/plugins/platforms/a2a/__init__.py \
    && HERMES_HOME=/sandbox/.hermes /opt/hermes/.venv/bin/python -I -c \
        'from hermes_cli.plugins import discover_plugins; from tools.registry import registry; discover_plugins(); assert registry.get_tool_names_for_toolset("a2a") == []; assert not any(name.startswith("a2a_") for name in registry.get_all_tool_names())' \
    && rm /opt/nemoclaw-hermes-config/a2a-neutral.patch

RUN if [ "$NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION" = "1" ]; then \
        A2A_PORT=9900 \
        BUZZ_RELAY_URL=https://nemoclaw-hostile.invalid \
        BUZZ_PRIVATE_KEY=nemoclaw-hostile \
        GOOGLE_CHAT_PROJECT_ID=nemoclaw-hostile \
        GOOGLE_CHAT_SUBSCRIPTION_NAME=projects/nemoclaw-hostile/subscriptions/nemoclaw-hostile \
        GOOGLE_CHAT_SERVICE_ACCOUNT_JSON='{"type":"service_account","project_id":"nemoclaw-hostile"}' \
        WHATSAPP_CLOUD_PHONE_NUMBER_ID=nemoclaw-hostile \
        WHATSAPP_CLOUD_ACCESS_TOKEN=nemoclaw-hostile \
        HERMES_HOME=/sandbox/.hermes /opt/hermes/.venv/bin/python -I \
            /opt/nemoclaw-hermes-config/image-build-probes.py neutral-platform-inertness; \
    fi \
    && rm /opt/nemoclaw-hermes-config/patch-neutral-platform-env-activation.py

RUN set -eu; \
    profile_probe_root="$(mktemp -d)"; \
    trap 'rm -rf "$profile_probe_root"' EXIT; \
    profile_probe_default="$profile_probe_root/.hermes"; \
    HOME="$profile_probe_root" HERMES_HOME="$profile_probe_default" \
        /usr/local/bin/hermes profile create nemoclaw-policy-probe \
        --no-alias --no-skills; \
    profile_probe_home="$profile_probe_default/profiles/nemoclaw-policy-probe"; \
    test -d "$profile_probe_home"; \
    test ! -e "$profile_probe_home/config.yaml"; \
    HOME="$profile_probe_root" HERMES_HOME="$profile_probe_home" \
        /opt/hermes/.venv/bin/python -I \
        /opt/nemoclaw-hermes-config/image-build-probes.py profile-policy

USER sandbox

# Prove that the installed dashboard seeder carries every reviewed policy value
# from the generated default home into a fresh isolated dashboard home. This is
# deliberately exact: a missing leaf or an unexpected session-reset default
# must fail the image build instead of broadening behavior at runtime.
RUN dashboard_probe=/tmp/nemoclaw-dashboard-policy-probe.yaml \
    && rm -f "$dashboard_probe" "$dashboard_probe.nemoclaw.tmp" \
    && /opt/hermes/.venv/bin/python -I \
        /usr/local/lib/nemoclaw/seed-hermes-dashboard-config.py \
        /usr/local/share/nemoclaw/hermes-managed-policy.json \
        /sandbox/.hermes/config.yaml "$dashboard_probe" \
    && /opt/hermes/.venv/bin/python -I \
        /opt/nemoclaw-hermes-config/image-build-probes.py \
        dashboard-policy "$dashboard_probe"

# Install the managed plugin into Hermes' root-owned bundled-plugin tree. The
# separated gateway must never import executable plugin code from the mutable
# Hermes home. Custom images use this same image-owned tree for reviewed
# plugins. /sandbox/.hermes/plugins remains mutable state for Hermes' same-UID
# topology and is ignored by the identity-proven separated gateway.
USER root
# hadolint ignore=DL3059
RUN rm -rf /opt/hermes/plugins/nemoclaw \
    && install -d -o root -g root -m 0755 /opt/hermes/plugins/nemoclaw \
    && cp -a /opt/nemoclaw-hermes-plugin/. /opt/hermes/plugins/nemoclaw/ \
    && chown -R root:root /opt/hermes/plugins/nemoclaw \
    && find /opt/hermes/plugins/nemoclaw -type d -exec chmod 0755 {} + \
    && find /opt/hermes/plugins/nemoclaw -type f -exec chmod 0444 {} +

USER sandbox

# Apply messaging render and post-agent-install build-file hooks after agent/plugin installation.
# hadolint ignore=DL3059
RUN node --experimental-strip-types /src/lib/messaging/applier/build/messaging-build-applier.mts --agent hermes --phase post-agent-install

# Write the default SOUL.md (agent identity) for the sandboxed agent.
# This is the stock Hermes default soul (hermes_cli/default_soul.py,
# DEFAULT_SOUL_MD) shipped verbatim. The OpenShell/NemoClaw environment is
# described separately via HERMES_ENVIRONMENT_HINT (below), which Hermes
# appends to the system prompt's environment-hints block — the correct slot
# for execution-environment facts, keeping the identity slot unmodified.
RUN mkdir -p /sandbox/.hermes/memories \
    && printf '%s' \
    'You are Hermes Agent, an intelligent AI assistant created by Nous Research. You are helpful, knowledgeable, and direct. You assist users with a wide range of tasks including answering questions, writing and editing code, analyzing information, creative work, and executing actions via your tools. You communicate clearly, admit uncertainty when appropriate, and prioritize being genuinely useful over being verbose unless otherwise directed below. Be targeted and efficient in your exploration and investigations.' \
    > /sandbox/.hermes/SOUL.md

# Describe the execution environment via Hermes's dedicated environment-hint
# mechanism (agent/prompt_builder.py:build_environment_hints). This lands in
# the system prompt's environment slot, not the identity slot, and is read once
# at prompt-build time so it stays in the cache-safe portion of the prompt.
ENV HERMES_ENVIRONMENT_HINT="You are running inside an NVIDIA OpenShell sandbox, with inference routed through NemoClaw. Your terminal, file, and web tools execute against the sandbox filesystem and egress through the OpenShell L7 proxy, which enforces network policy and rewrites credentials at the boundary, so you never see raw secrets. Your config and memory live under /sandbox/.hermes and are mutable. Work within the sandbox boundary."

# Set mutable-default permissions (640 files, 3770 config root).
# The sandbox user can write config; the gateway user can read it via
# supplementary sandbox-group membership and create Hermes v0.14 runtime dirs
# without being able to remove sticky-protected config files.
# hadolint ignore=DL3002
USER root

# Flatten stale published base images that still contain the old .hermes-data
# symlink bridge. The base resolver owns published-image provenance and exports
# immutable digests; this final-image boundary owns layout validation so local,
# rebuilt, and caller-selected bases remain supported. Retired OpenClaw state
# must never enter a Hermes final image. OpenShell starts the sandbox as the
# sandbox user, so the .hermes-data migration cannot rely on root privileges
# inside the pod.
ARG NEMOCLAW_HERMES_FINALIZE_IMAGE_LAYOUT_SHA256=775c82aaad35ee9e788b85ed624e837507c1e7ba86e775260b356a03a7d0ac86
# hadolint ignore=DL4006
RUN set -eu; \
    printf '%s  %s\n' \
        "$NEMOCLAW_HERMES_FINALIZE_IMAGE_LAYOUT_SHA256" /opt/nemoclaw-hermes-config/finalize-image-layout.sh \
    | sha256sum -c - \
    || { echo "ERROR: finalize-image-layout.sh hash mismatch (update NEMOCLAW_HERMES_FINALIZE_IMAGE_LAYOUT_SHA256)" >&2; exit 1; }; \
    /bin/bash /opt/nemoclaw-hermes-config/finalize-image-layout.sh /sandbox \
    && rm /opt/nemoclaw-hermes-config/finalize-image-layout.sh \
    && config_dir=/sandbox/.hermes \
    && data_dir=/sandbox/.hermes-data \
    && mkdir -p "$config_dir/memories" \
        "$config_dir/sessions" \
        "$config_dir/skills" \
        "$config_dir/plugins" \
        "$config_dir/cron" \
        "$config_dir/logs" \
        "$config_dir/logs/curator" \
        "$config_dir/skins" \
        "$config_dir/plans" \
        "$config_dir/workspace" \
        "$config_dir/profiles" \
        "$config_dir/cache" \
        "$config_dir/hooks" \
        "$config_dir/image_cache" \
        "$config_dir/audio_cache" \
        "$config_dir/pairing" \
        "$config_dir/platforms" \
        "$config_dir/platforms/whatsapp" \
        "$config_dir/platforms/whatsapp/session" \
        "$config_dir/gateway" \
        "$config_dir/weixin" \
        "$config_dir/weixin/accounts" \
        "$config_dir/runtime" \
        "$config_dir/lazy-packages" \
        "$config_dir/profiles/dashboard-home"; \
    if [ -e "$data_dir" ] || [ -L "$data_dir" ]; then \
        echo "ERROR: legacy data dir still exists after cleanup: $data_dir" >&2; \
        exit 1; \
    fi; \
    data_real="$(readlink -f "$data_dir" 2>/dev/null || printf '%s' "$data_dir")"; \
    find "$config_dir" -type l -print | while IFS= read -r link; do \
        raw_target="$(readlink "$link" 2>/dev/null || true)"; \
        resolved_target="$(readlink -f "$link" 2>/dev/null || true)"; \
        case "$raw_target" in \
            "$data_real"/* | "$data_dir"/*) \
                echo "ERROR: legacy symlink remains after cleanup: $link -> $raw_target" >&2; \
                exit 1; \
                ;; \
        esac; \
        case "$resolved_target" in \
            "$data_real"/* | "$data_dir"/*) \
                echo "ERROR: legacy symlink remains after cleanup: $link -> $resolved_target" >&2; \
                exit 1; \
                ;; \
        esac; \
    done; \
    rm -rf /root/.cache/pip /sandbox/.cache \
    && chown -R sandbox:sandbox /sandbox/.hermes \
    && chown gateway:sandbox \
        /sandbox/.hermes/cron \
        /sandbox/.hermes/gateway \
        /sandbox/.hermes/runtime \
    && chmod 3770 /sandbox/.hermes \
    && chmod 770 \
        /sandbox/.hermes/memories \
        /sandbox/.hermes/sessions \
        /sandbox/.hermes/skills \
        /sandbox/.hermes/plugins \
        /sandbox/.hermes/cron \
        /sandbox/.hermes/logs \
        /sandbox/.hermes/logs/curator \
        /sandbox/.hermes/skins \
        /sandbox/.hermes/plans \
        /sandbox/.hermes/workspace \
        /sandbox/.hermes/profiles \
        /sandbox/.hermes/cache \
        /sandbox/.hermes/hooks \
        /sandbox/.hermes/image_cache \
        /sandbox/.hermes/audio_cache \
        /sandbox/.hermes/pairing \
        /sandbox/.hermes/platforms \
        /sandbox/.hermes/platforms/whatsapp \
        /sandbox/.hermes/platforms/whatsapp/session \
        /sandbox/.hermes/gateway \
        /sandbox/.hermes/weixin \
        /sandbox/.hermes/weixin/accounts \
        /sandbox/.hermes/runtime \
        /sandbox/.hermes/profiles/dashboard-home \
    && chmod 750 /sandbox/.hermes/lazy-packages \
    && chmod 2770 \
        /sandbox/.hermes/logs \
        /sandbox/.hermes/logs/curator \
        /sandbox/.hermes/platforms \
        /sandbox/.hermes/platforms/whatsapp \
        /sandbox/.hermes/platforms/whatsapp/session \
        /sandbox/.hermes/cron \
        /sandbox/.hermes/gateway \
        /sandbox/.hermes/runtime \
    && chmod 640 /sandbox/.hermes/config.yaml \
    && chmod 640 /sandbox/.hermes/.env \
    && find -P /sandbox/.hermes/logs -type f -exec chown sandbox:sandbox {} + \
    && find -P /sandbox/.hermes/logs -type f -exec chmod 660 {} + \
    && for name in state.db state.db-wal state.db-shm gateway.lock gateway_state.json channel_directory.json; do \
        rm -f "/sandbox/.hermes/${name}"; \
        rm -f "/sandbox/.hermes/runtime/${name}"; \
        ln -s "runtime/${name}" "/sandbox/.hermes/${name}"; \
    done \
    && : > /sandbox/.hermes/.hermes_history \
    && chown sandbox:sandbox /sandbox/.hermes/.hermes_history \
    && chmod 660 /sandbox/.hermes/.hermes_history

# Exercise all sandbox-authored plugin roots against the real patched Hermes
# loaders. The root-separated marker makes them inert for gateway while the
# no-marker same-identity probe retains upstream user-plugin behavior. Every
# hostile fixture and marker is removed in this layer.
# hadolint ignore=DL3003
RUN set -eu; \
    marker=/run/nemoclaw/hermes-bundled-plugins-only; \
    user_plugins=/sandbox/.hermes/plugins; \
    project_root=/sandbox/nemoclaw-hostile-project; \
    fake_bundled=/sandbox/nemoclaw-hostile-bundled; \
    rm -rf "$user_plugins" "$project_root" "$fake_bundled"; \
    install -d -o sandbox -g sandbox -m 0770 \
        "$user_plugins/nemoclaw" \
        "$user_plugins/model-providers/nemoclaw-hostile" \
        "$user_plugins/nemoclaw-hostile-memory" \
        "$user_plugins/nemoclaw-hostile-cron" \
        "$project_root/.hermes/plugins/nemoclaw" \
        "$fake_bundled/nemoclaw"; \
    printf '%s\n' \
        'from pathlib import Path' \
        'Path("/tmp/nemoclaw-hostile-user-plugin").write_text("executed")' \
        'def register(ctx): pass' \
        > "$user_plugins/nemoclaw/__init__.py"; \
    printf '%s\n' 'name: nemoclaw' 'version: 0.0.0' > "$user_plugins/nemoclaw/plugin.yaml"; \
    printf '%s\n' \
        'from pathlib import Path' \
        'Path("/tmp/nemoclaw-hostile-model-provider").write_text("executed")' \
        > "$user_plugins/model-providers/nemoclaw-hostile/__init__.py"; \
    printf '%s\n' \
        'from pathlib import Path' \
        'Path("/tmp/nemoclaw-hostile-memory-provider").write_text("executed")' \
        '# MemoryProvider' \
        > "$user_plugins/nemoclaw-hostile-memory/__init__.py"; \
    printf '%s\n' \
        'from pathlib import Path' \
        'Path("/tmp/nemoclaw-hostile-cron-provider").write_text("executed")' \
        '# CronScheduler' \
        > "$user_plugins/nemoclaw-hostile-cron/__init__.py"; \
    printf '%s\n' \
        'from pathlib import Path' \
        'Path("/tmp/nemoclaw-hostile-project-plugin").write_text("executed")' \
        'def register(ctx): pass' \
        > "$project_root/.hermes/plugins/nemoclaw/__init__.py"; \
    printf '%s\n' 'name: nemoclaw' 'version: 0.0.0' > "$project_root/.hermes/plugins/nemoclaw/plugin.yaml"; \
    printf '%s\n' \
        'from pathlib import Path' \
        'Path("/tmp/nemoclaw-hostile-bundled-plugin").write_text("executed")' \
        'def register(ctx): pass' \
        > "$fake_bundled/nemoclaw/__init__.py"; \
    printf '%s\n' 'name: nemoclaw' 'version: 0.0.0' > "$fake_bundled/nemoclaw/plugin.yaml"; \
    chown -R sandbox:sandbox "$user_plugins" "$project_root" "$fake_bundled"; \
    if /usr/bin/setpriv --reuid=gateway --regid=gateway --init-groups -- \
        /opt/hermes/.venv/bin/python -I -c \
        'from hermes_constants import nemoclaw_managed_gateway_plugins_only; nemoclaw_managed_gateway_plugins_only()' 2>/dev/null; then \
        echo "ERROR: gateway accepted a missing managed plugin marker" >&2; exit 1; \
    fi; \
    printf 'unsafe\n' > "$marker"; \
    chown root:root "$marker"; \
    chmod 0644 "$marker"; \
    if /usr/bin/setpriv --reuid=gateway --regid=gateway --init-groups -- \
        /opt/hermes/.venv/bin/python -I -c \
        'from hermes_constants import nemoclaw_managed_gateway_plugins_only; nemoclaw_managed_gateway_plugins_only()' 2>/dev/null; then \
        echo "ERROR: gateway accepted an unsafe managed plugin marker" >&2; exit 1; \
    fi; \
    printf '1\n' > "$marker"; \
    chown root:root "$marker"; \
    chmod 0444 "$marker"; \
    cd /opt/hermes; \
    HERMES_HOME=/sandbox/.hermes \
        HERMES_BUNDLED_PLUGINS="$fake_bundled" \
        HERMES_ENABLE_PROJECT_PLUGINS=0 \
        /usr/bin/setpriv --reuid=gateway --regid=gateway --init-groups -- \
        /opt/hermes/.venv/bin/python -I -c \
        "from pathlib import Path; from hermes_cli.plugins import discover_plugins, get_plugin_manager; from plugins.memory import _get_user_plugins_dir as memory_user_dir; from plugins.cron_providers import _get_user_plugins_dir as cron_user_dir; from providers import _user_plugins_dir as model_user_dir; discover_plugins(); plugin = get_plugin_manager()._plugins['nemoclaw']; assert plugin.enabled is True and plugin.error is None; assert plugin.manifest.source == 'bundled'; assert Path(plugin.manifest.path).resolve() == Path('/opt/hermes/plugins/nemoclaw').resolve(); assert memory_user_dir() is None; assert cron_user_dir() is None; assert model_user_dir() is None"; \
    cd "$project_root"; \
    HERMES_HOME=/sandbox/.hermes \
        HERMES_BUNDLED_PLUGINS="$fake_bundled" \
        HERMES_ENABLE_PROJECT_PLUGINS=1 \
        /usr/bin/setpriv --reuid=gateway --regid=gateway --init-groups -- \
        /opt/hermes/.venv/bin/python -I -c \
        "from hermes_cli.plugins import discover_plugins; discover_plugins()"; \
    test ! -e /tmp/nemoclaw-hostile-user-plugin; \
    test ! -e /tmp/nemoclaw-hostile-model-provider; \
    test ! -e /tmp/nemoclaw-hostile-memory-provider; \
    test ! -e /tmp/nemoclaw-hostile-cron-provider; \
    test ! -e /tmp/nemoclaw-hostile-project-plugin; \
    test ! -e /tmp/nemoclaw-hostile-bundled-plugin; \
    rm -f "$marker"; \
    cd /opt/hermes; \
    HERMES_HOME=/sandbox/.hermes \
        HERMES_BUNDLED_PLUGINS=/opt/hermes/plugins \
        HERMES_ENABLE_PROJECT_PLUGINS=0 \
        /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- \
        /opt/hermes/.venv/bin/python -I -c \
        "from hermes_cli.plugins import discover_plugins; discover_plugins()"; \
    test "$(stat -c '%U:%G' /tmp/nemoclaw-hostile-user-plugin)" = 'sandbox:sandbox'; \
    rm -rf "$user_plugins" "$project_root" "$fake_bundled"; \
    rm -f /tmp/nemoclaw-hostile-user-plugin; \
    install -d -o sandbox -g sandbox -m 0770 "$user_plugins"; \
    rm -f /sandbox/.hermes/runtime/state.db \
        /sandbox/.hermes/runtime/state.db-wal \
        /sandbox/.hermes/runtime/state.db-shm

# Exercise the reviewed runtime installer without shipping Hindsight in the
# image. Root-separated startup gives the gateway a private, ephemeral target
# below root-owned /run/nemoclaw; the sandbox-owned durable target remains for
# interactive sandbox commands and is never activated by the gateway. The
# hostile module and executable .pth fixture below prove that separation at the
# real Hermes bootstrap boundary. Remove both probe installs before publishing
# the image so selecting Hindsight still owns the runtime retrieval event.
#
# uv creates the Hermes virtual environment without pip. Seed pip from Python's
# bundled ensurepip payload while this layer is still root, then verify the
# sandbox can read but cannot modify the virtual environment used by the
# installer. The build-only probe wheel has no upstream payload;
# Dockerfile.base separately verifies the checksum-pinned official Hindsight
# artifacts without distributing them.
RUN /opt/hermes/.venv/bin/python -I -m ensurepip --upgrade --default-pip \
    && /opt/hermes/.venv/bin/python -I -m pip --version \
    && chmod 644 /opt/hermes/.venv/.lock \
    && test "$(stat -c '%U:%G %a' /opt/hermes/.venv/.lock)" = "root:root 644" \
    && test "$(stat -c '%U:%G %a' /opt/hermes/.venv/bin/pip)" = "root:root 755" \
    && venv_violation="$(find -P /opt/hermes/.venv ! -type l \( ! -user root -o ! -group root -o -perm /022 \) -print -quit)" \
    && test -z "$venv_violation" \
    && venv_link_owner_violation="$(find -P /opt/hermes/.venv -type l \( ! -user root -o ! -group root \) -print -quit)" \
    && test -z "$venv_link_owner_violation" \
    && venv_links_file="$(mktemp)" \
    && find -P /opt/hermes/.venv -type l -printf '%P -> %l\n' > "$venv_links_file" \
    && LC_ALL=C sort -o "$venv_links_file" "$venv_links_file" \
    && venv_links="$(cat "$venv_links_file")" \
    && rm -f "$venv_links_file" \
    && expected_venv_links="$(printf '%s\n' \
        'bin/python -> /usr/bin/python3.13' \
        'bin/python3 -> python' \
        'bin/python3.13 -> python' \
        "lib/python3.13/site-packages/certifi/cacert.pem -> $SSL_CERT_FILE" \
        'lib64 -> lib')" \
    && { test "$venv_links" = "$expected_venv_links" \
        || { echo "ERROR: Hermes virtual environment link inventory mismatch" >&2; exit 1; }; } \
    && test "$(readlink -e /opt/hermes/.venv/bin/python)" = "/usr/bin/python3.13" \
    && test "$(readlink -e /opt/hermes/.venv/bin/python3)" = "/usr/bin/python3.13" \
    && test "$(readlink -e /opt/hermes/.venv/bin/python3.13)" = "/usr/bin/python3.13" \
    && test "$(readlink -e /opt/hermes/.venv/lib64)" = "/opt/hermes/.venv/lib" \
    && test "$(stat -Lc '%U:%G %a %F' /opt/hermes/.venv/bin/python)" = "root:root 755 regular file" \
    && test "$(stat -Lc '%U:%G %a %F' /opt/hermes/.venv/bin/python3)" = "root:root 755 regular file" \
    && test "$(stat -Lc '%U:%G %a %F' /opt/hermes/.venv/bin/python3.13)" = "root:root 755 regular file" \
    && test "$(stat -Lc '%U:%G %a %F' /opt/hermes/.venv/lib64)" = "root:root 755 directory" \
    && /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- \
        sh -eu -c '\
            /opt/hermes/.venv/bin/python -I -m pip --version >/dev/null; \
            if printf "" >> /opt/hermes/.venv/.lock 2>/dev/null; then exit 1; fi; \
            if printf "" >> /opt/hermes/.venv/bin/pip 2>/dev/null; then exit 1; fi; \
            if printf "" >> /opt/hermes/.venv/lib/python3.13/site-packages/pip/__init__.py 2>/dev/null; then exit 1; fi; \
            if printf "" >> /opt/hermes/.venv/bin/python 2>/dev/null; then exit 1; fi; \
            if printf "" > /opt/hermes/.venv/lib64/.nemoclaw-sandbox-write-probe 2>/dev/null; then exit 1; fi; \
            if ln -sf /usr/bin/false /opt/hermes/.venv/bin/python 2>/dev/null; then exit 1; fi; \
            exit 0' \
    && test ! -e /opt/hermes/.venv/lib/.nemoclaw-sandbox-write-probe \
    && install -d -o root -g root -m 0755 /tmp/nemoclaw-hindsight-probe \
    && cp /opt/nemoclaw-hermes-config/hindsight-probe-aiohttp-retry.whl \
        /tmp/nemoclaw-hindsight-probe/aiohttp_retry-2.9.1-py3-none-any.whl \
    && rm /opt/nemoclaw-hermes-config/hindsight-probe-aiohttp-retry.whl \
    && /opt/hermes/.venv/bin/python -I -c \
        "import zipfile; entries = {'nemoclaw_lazy_probe/__init__.py': 'NEMOCLAW_BUILD_PROBE_FIXTURE = True\n', 'nemoclaw_lazy_probe-1.0.0.dist-info/METADATA': 'Metadata-Version: 2.4\nName: nemoclaw-lazy-probe\nVersion: 1.0.0\nSummary: NemoClaw offline lazy-installer build probe\n\n', 'nemoclaw_lazy_probe-1.0.0.dist-info/WHEEL': 'Wheel-Version: 1.0\nGenerator: NemoClaw build probe\nRoot-Is-Purelib: true\nTag: py3-none-any\n', 'nemoclaw_lazy_probe-1.0.0.dist-info/RECORD': 'nemoclaw_lazy_probe/__init__.py,,\nnemoclaw_lazy_probe-1.0.0.dist-info/METADATA,,\nnemoclaw_lazy_probe-1.0.0.dist-info/WHEEL,,\nnemoclaw_lazy_probe-1.0.0.dist-info/RECORD,,\n'}; wheel = zipfile.ZipFile('/tmp/nemoclaw-hindsight-probe/nemoclaw_lazy_probe-1.0.0-py3-none-any.whl', 'w', compression=zipfile.ZIP_DEFLATED); [wheel.writestr(name, data) for name, data in entries.items()]; wheel.close()" \
    && chown root:root /tmp/nemoclaw-hindsight-probe/nemoclaw_lazy_probe-1.0.0-py3-none-any.whl \
    && chmod 0444 /tmp/nemoclaw-hindsight-probe/nemoclaw_lazy_probe-1.0.0-py3-none-any.whl \
    && install -d -o root -g root -m 0755 /run/nemoclaw \
    && printf '1\n' > /run/nemoclaw/hermes-bundled-plugins-only \
    && chown root:root /run/nemoclaw/hermes-bundled-plugins-only \
    && chmod 0444 /run/nemoclaw/hermes-bundled-plugins-only \
    && rm -rf /run/nemoclaw/hermes-gateway-lazy-packages \
    && install -d -o gateway -g gateway -m 0700 /run/nemoclaw/hermes-gateway-lazy-packages \
    && test "$(stat -c '%U:%G %a' /run/nemoclaw/hermes-gateway-lazy-packages)" = "gateway:gateway 700" \
    && rm -rf /sandbox/.hermes/lazy-packages \
    && install -d -o sandbox -g sandbox -m 0750 /sandbox/.hermes/lazy-packages/nemoclaw_lazy_probe \
    && printf '%s\n' 'NEMOCLAW_SANDBOX_TAMPER_FIXTURE = True' > /sandbox/.hermes/lazy-packages/nemoclaw_lazy_probe/__init__.py \
    && printf '%s\n' "import pathlib; pathlib.Path('/tmp/nemoclaw-sandbox-lazy-pth-executed').write_text('unsafe')" > /sandbox/.hermes/lazy-packages/nemoclaw_sandbox_tamper.pth \
    && chown -R sandbox:sandbox /sandbox/.hermes/lazy-packages \
    && chmod 0750 /sandbox/.hermes/lazy-packages /sandbox/.hermes/lazy-packages/nemoclaw_lazy_probe \
    && chmod 0640 /sandbox/.hermes/lazy-packages/nemoclaw_lazy_probe/__init__.py /sandbox/.hermes/lazy-packages/nemoclaw_sandbox_tamper.pth \
    && HOME=/sandbox \
        PIP_FIND_LINKS=/tmp/nemoclaw-hindsight-probe \
        PIP_NO_INDEX=1 \
        UV_CACHE_DIR=/run/nemoclaw/hermes-gateway-lazy-packages/.uv-cache \
        UV_FIND_LINKS=/tmp/nemoclaw-hindsight-probe \
        UV_NO_CACHE=1 \
        UV_OFFLINE=1 \
        HERMES_HOME=/sandbox/.hermes \
        HERMES_LAZY_INSTALL_TARGET=/run/nemoclaw/hermes-gateway-lazy-packages \
        /usr/bin/setpriv --reuid=gateway --regid=gateway --init-groups -- \
        /opt/hermes/.venv/bin/python -I -c \
        "from tools import lazy_deps; result = lazy_deps._venv_pip_install(('/tmp/nemoclaw-hindsight-probe/nemoclaw_lazy_probe-1.0.0-py3-none-any.whl',)); assert result.success, result.stderr or result.stdout" \
    && rm -rf /tmp/nemoclaw-hindsight-probe \
    && /usr/bin/setpriv --reuid=gateway --regid=gateway --init-groups -- \
        env HERMES_LAZY_INSTALL_TARGET=/run/nemoclaw/hermes-gateway-lazy-packages \
        /opt/hermes/.venv/bin/python -I -c \
        "import hermes_bootstrap, nemoclaw_lazy_probe, importlib.metadata as m, pathlib, sys; gateway_target = pathlib.Path('/run/nemoclaw/hermes-gateway-lazy-packages').resolve(); sandbox_target = pathlib.Path('/sandbox/.hermes/lazy-packages').resolve(); assert m.version('nemoclaw-lazy-probe') == '1.0.0'; assert nemoclaw_lazy_probe.NEMOCLAW_BUILD_PROBE_FIXTURE is True; assert pathlib.Path(nemoclaw_lazy_probe.__file__).resolve().is_relative_to(gateway_target); assert str(sandbox_target) not in sys.path; assert not pathlib.Path('/tmp/nemoclaw-sandbox-lazy-pth-executed').exists()" \
    && test ! -e /tmp/nemoclaw-sandbox-lazy-pth-executed \
    && test "$(stat -c '%U:%G' /run/nemoclaw/hermes-gateway-lazy-packages/nemoclaw_lazy_probe/__init__.py)" = "gateway:gateway" \
    && /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- \
        sh -eu -c 'test ! -r /run/nemoclaw/hermes-gateway-lazy-packages/nemoclaw_lazy_probe/__init__.py; if printf unsafe > /run/nemoclaw/hermes-gateway-lazy-packages/.nemoclaw-sandbox-write-probe 2>/dev/null; then exit 1; fi' \
    && test ! -e /run/nemoclaw/hermes-gateway-lazy-packages/.nemoclaw-sandbox-write-probe \
    && rm -rf /run/nemoclaw/hermes-gateway-lazy-packages \
    && rm -f /run/nemoclaw/hermes-bundled-plugins-only \
    && rm -rf /sandbox/.hermes/lazy-packages \
    && install -d -o sandbox -g sandbox -m 0750 /sandbox/.hermes/lazy-packages \
    && chmod u=rwx,g=rx,o=,g-s /sandbox/.hermes/lazy-packages \
    && test "$(stat -c '%U:%G %a' /sandbox/.hermes/lazy-packages)" = "sandbox:sandbox 750" \
    && rm -rf /sandbox/.cache \
    && chown sandbox:sandbox /sandbox/.hermes \
    && chmod 3770 /sandbox/.hermes \
    && test "$(stat -c '%U:%G %a' /sandbox/.hermes)" = "sandbox:sandbox 3770"

# Prove the session, cron, and Discord ledger contracts across the real image identities.
# Gateway creates state.db in the writable runtime boundary. When the filesystem
# supports WAL, SQLite also creates WAL/SHM sidecars; otherwise Hermes explicitly
# falls back to DELETE mode. The patched SessionDB normalizes only the fixed files
# SQLite selected to 0660, so sandbox can list and append the session in either
# mode. The scheduler and Discord adapter then exercise their separate ledgers
# across both identities. Keep the sequences in one RUN to stay below Docker's
# layer cap.
RUN test "$(stat -c '%U:%G %a' /sandbox/.hermes/runtime)" = "gateway:sandbox 2770" \
    && test "$(readlink /sandbox/.hermes/state.db)" = "runtime/state.db" \
    && test ! -e /sandbox/.hermes/runtime/state.db \
    && umask 0007 \
    && HERMES_HOME=/sandbox/.hermes /usr/bin/setpriv --reuid=gateway --regid=gateway --init-groups -- /opt/hermes/.venv/bin/python -I \
        /opt/nemoclaw-hermes-config/image-build-probes.py session-state-create \
    && test "$(stat -c '%U:%G %a' /sandbox/.hermes/runtime/state.db)" = "gateway:sandbox 660" \
    && rm -f /sandbox/.hermes/runtime/state.db-wal /sandbox/.hermes/runtime/state.db-shm \
    && umask 0007 \
    && HERMES_HOME=/sandbox/.hermes /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- /opt/hermes/.venv/bin/python -I \
        /opt/nemoclaw-hermes-config/image-build-probes.py session-state-reopen \
    && test "$(stat -c '%U:%G %a' /sandbox/.hermes/runtime/state.db)" = "gateway:sandbox 660" \
    && rm -f /sandbox/.hermes/runtime/state.db \
        /sandbox/.hermes/runtime/state.db-wal \
        /sandbox/.hermes/runtime/state.db-shm \
    && test ! -e /sandbox/.hermes/runtime/state.db \
    && test ! -L /sandbox/.hermes/runtime/state.db \
    && test ! -e /sandbox/.hermes/cron/executions.db \
    && HERMES_HOME=/sandbox/.hermes /usr/bin/setpriv --reuid=gateway --regid=gateway --init-groups -- /opt/hermes/.venv/bin/python -I \
        /opt/nemoclaw-hermes-config/image-build-probes.py secure-directory-modes \
    && test "$(stat -c '%U:%G %a' /sandbox/.hermes)" = "sandbox:sandbox 3770" \
    && test "$(stat -c '%U:%G %a' /sandbox/.hermes/runtime)" = "gateway:sandbox 2770" \
    && umask 0007 \
    && HERMES_HOME=/sandbox/.hermes /usr/bin/setpriv --reuid=gateway --regid=gateway --init-groups -- /opt/hermes/.venv/bin/python -I \
        /opt/nemoclaw-hermes-config/image-build-probes.py cron-create \
    && test "$(stat -c '%U:%G %a' /sandbox/.hermes/runtime/cron-executions.db)" = "gateway:sandbox 640" \
    && umask 0007 \
    && HERMES_HOME=/sandbox/.hermes /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- /opt/hermes/.venv/bin/python -I \
        /opt/nemoclaw-hermes-config/image-build-probes.py cron-backup \
    && test "$(stat -c '%U:%G %a' /sandbox/.hermes/runtime/cron-executions.db)" = "sandbox:sandbox 660" \
    && umask 0007 \
    && HERMES_HOME=/sandbox/.hermes /usr/bin/setpriv --reuid=gateway --regid=gateway --init-groups -- /opt/hermes/.venv/bin/python -I \
        /opt/nemoclaw-hermes-config/image-build-probes.py cron-reopen \
    && test "$(stat -c '%U:%G %a' /sandbox/.hermes/runtime/cron-executions.db)" = "sandbox:sandbox 660" \
    && rm -f /sandbox/.hermes/runtime/cron-executions.db \
        /sandbox/.hermes/runtime/cron-executions.db-wal \
        /sandbox/.hermes/runtime/cron-executions.db-shm \
    && test "$(stat -c '%U:%G %a' /sandbox/.hermes/gateway)" = "gateway:sandbox 2770" \
    && umask 0007 \
    && HERMES_HOME=/sandbox/.hermes /usr/bin/setpriv --reuid=gateway --regid=gateway --init-groups -- /opt/hermes/.venv/bin/python -I \
        /opt/nemoclaw-hermes-config/image-build-probes.py discord-create \
    && test "$(stat -c '%U:%G %a' /sandbox/.hermes/gateway/discord_message_recovery.db)" = "gateway:sandbox 660" \
    && umask 0007 \
    && HERMES_HOME=/sandbox/.hermes /usr/bin/setpriv --reuid=sandbox --regid=sandbox --init-groups -- /opt/hermes/.venv/bin/python -I \
        /opt/nemoclaw-hermes-config/image-build-probes.py discord-backup \
    && test "$(stat -c '%U:%G %a' /sandbox/.hermes/gateway/discord_message_recovery.db)" = "sandbox:sandbox 660" \
    && umask 0007 \
    && HERMES_HOME=/sandbox/.hermes /usr/bin/setpriv --reuid=gateway --regid=gateway --init-groups -- /opt/hermes/.venv/bin/python -I \
        /opt/nemoclaw-hermes-config/image-build-probes.py discord-reopen \
    && test "$(stat -c '%U:%G %a' /sandbox/.hermes/gateway/discord_message_recovery.db)" = "sandbox:sandbox 660" \
    && rm -f /sandbox/.hermes/gateway/discord_message_recovery.db \
        /sandbox/.hermes/gateway/discord_message_recovery.db-wal \
        /sandbox/.hermes/gateway/discord_message_recovery.db-shm \
    && rm -f /opt/nemoclaw-hermes-config/image-build-probes.py

# Pin config hash at build time for integrity verification at startup. Invoke
# the installed runtime guard's `_canonical_mcp_servers_digest` directly so
# image sealing and runtime verification cannot drift onto different JSON
# canonicalization contracts.
RUN mkdir -p /etc/nemoclaw \
    && sha256sum /sandbox/.hermes/config.yaml /sandbox/.hermes/.env \
    > /etc/nemoclaw/hermes.config-hash \
    && mcp_digest="$(/opt/hermes/.venv/bin/python -I /usr/local/lib/nemoclaw/build-hermes-mcp-digest.py --guard /usr/local/lib/nemoclaw/hermes-runtime-config-guard.py --config /sandbox/.hermes/config.yaml)" \
    && printf '# nemoclaw-hermes-mcp-state-v1 intended=%s applied=%s\n' "$mcp_digest" "$mcp_digest" \
    >> /etc/nemoclaw/hermes.config-hash \
    && chown root:root /etc/nemoclaw/hermes.config-hash \
    && chmod 444 /etc/nemoclaw/hermes.config-hash

# Publish the mutable in-tree compatibility hash used by runtime checks.
RUN cp /etc/nemoclaw/hermes.config-hash /sandbox/.hermes/.config-hash \
    && chmod 640 /sandbox/.hermes/.config-hash \
    && chown sandbox:sandbox /sandbox/.hermes/.config-hash

# Keep the shared NemoClaw state root consistent across every shipped agent.
# The root-owned sticky directory protects the managed-startup transaction
# receipt while leaving the named plugin state directories sandbox-writable.
RUN chown root:root /sandbox/.nemoclaw \
    && chmod 1755 /sandbox/.nemoclaw \
    && chown -R root:root /sandbox/.nemoclaw/blueprints \
    && chmod -R 755 /sandbox/.nemoclaw/blueprints \
    && mkdir -p /sandbox/.nemoclaw/state /sandbox/.nemoclaw/migration /sandbox/.nemoclaw/snapshots /sandbox/.nemoclaw/staging \
    && chown sandbox:sandbox /sandbox/.nemoclaw/state /sandbox/.nemoclaw/migration /sandbox/.nemoclaw/snapshots /sandbox/.nemoclaw/staging \
    && printf '%s' '{}' > /sandbox/.nemoclaw/config.json \
    && chown sandbox:sandbox /sandbox/.nemoclaw/config.json

# OpenShell's macOS VM backend currently remaps extracted rootfs ownership to
# the host uid/gid before startup. Hermes uses /sandbox as a read_write path, so
# that repair walks the trusted rc files too; keep this Darwin-only so Linux
# Docker-driver sandboxes retain the tighter default permissions.
RUN if [ "$NEMOCLAW_DARWIN_VM_COMPAT" = "1" ]; then \
        chmod -R a+rwX /sandbox/.hermes; \
        find /sandbox/.hermes -type d -exec chmod a+rwx {} +; \
        find /sandbox/.hermes/lazy-packages -type d -exec chmod 750 {} +; \
        find /sandbox/.hermes/lazy-packages -type f -exec chmod 640 {} +; \
        for p in /sandbox/.nemoclaw/state /sandbox/.nemoclaw/migration /sandbox/.nemoclaw/snapshots /sandbox/.nemoclaw/staging; do \
            chmod a+rwx "$p"; \
        done; \
        chmod a+rw /sandbox/.nemoclaw/config.json; \
        chmod a+rw /sandbox/.bashrc /sandbox/.profile; \
    fi


# These executables are git-tracked 0755 but check out group-writable (0775)
# under umask 002, and COPY carries that source mode into the image. Normalize
# before the check_metadata gate below asserts root:root 755. A RUN chmod is
# builder-independent; COPY --chmod requires BuildKit.
RUN chmod 755 \
        /usr/local/lib/nemoclaw/hermes-wrapper.py \
        /usr/local/lib/nemoclaw/validate-hermes-cli-adapter.py \
    && chmod 444 /usr/local/share/nemoclaw/hermes-cli-adapter-v1.json

RUN check_metadata() { \
        path="$1"; \
        expected="$2"; \
        actual="$(stat -c '%U:%G %a' "$path")"; \
        [ "$actual" = "$expected" ] \
            || { echo "ERROR: $path metadata is $actual, expected $expected" >&2; return 1; }; \
    }; \
    check_absent() { \
        path="$1"; \
        { [ ! -e "$path" ] && [ ! -L "$path" ]; } \
            || { echo "ERROR: build-only Hermes path leaked into the final image: $path" >&2; return 1; }; \
    }; \
    check_absent /opt/hermes/tests \
    && check_absent /opt/nemoclaw-hermes-config/image-build-probes.py \
    && check_absent /opt/nemoclaw-hermes-config/finalize-image-layout.sh \
    && check_absent /opt/nemoclaw-hermes-config/patch-gateway-runtime-metadata.py \
    && check_absent /opt/nemoclaw-hermes-config/patch-gateway-process-identity.py \
    && check_absent /opt/nemoclaw-hermes-config/patch-cron-execution-runtime.py \
    && check_absent /opt/nemoclaw-hermes-config/patch-cron-restore-drain.py \
    && check_absent /opt/nemoclaw-hermes-config/patch-session-list-preview.py \
    && check_absent /opt/nemoclaw-hermes-config/patch-profile-policy-defaults.py \
    && check_absent /opt/nemoclaw-hermes-config/patch-neutral-platform-env-activation.py \
    && check_absent /opt/nemoclaw-hermes-config/hindsight-lazy-integrity.patch \
    && check_absent /opt/nemoclaw-hermes-config/hindsight-probe-aiohttp-retry.whl \
    && check_absent /opt/nemoclaw-hermes-config/managed_policy.py \
    && check_absent /usr/local/lib/nemoclaw/patch-hermes-session-list-preview.py \
    && check_absent /usr/local/lib/nemoclaw/patch-hermes-profile-policy-defaults.py \
    && check_absent /root/.npm \
    && check_absent /root/.cache/electron \
    && check_absent /root/.cache/node-gyp \
    && check_absent /root/.cache/uv \
    && check_absent /sandbox/.cache \
    && check_absent /run/nemoclaw/hermes-gateway-lazy-packages \
    && check_absent /run/nemoclaw/hermes-bundled-plugins-only \
    && check_absent /tmp/nemoclaw-sandbox-lazy-pth-executed \
    && check_absent /sandbox/.hermes/managed-policy.json \
    && check_absent /sandbox/.hermes/runtime/state.db \
    && check_absent /sandbox/.hermes/runtime/state.db-wal \
    && check_absent /sandbox/.hermes/runtime/state.db-shm \
    && check_absent /sandbox/.nemoclaw/hermes-cron-restore-drain.json \
    && check_absent /sandbox/.nemoclaw/hermes-cron-restore-release-recovery.json \
    && check_metadata /sandbox/.nemoclaw 'root:root 1755' \
    && check_metadata /opt/hermes/plugins/nemoclaw 'root:root 755' \
    && check_metadata /opt/hermes/plugins/nemoclaw/__init__.py 'root:root 444' \
    && check_metadata /scripts/lib/bundled-npm-package.mts 'root:root 444' \
    && check_metadata /scripts/patch-bundled-npm-brace-expansion.mts 'root:root 444' \
    && check_metadata /scripts/lib/patch-bundled-npm-ip-address.mts 'root:root 444' \
    && check_metadata /scripts/patch-bundled-npm-tar.mts 'root:root 444' \
    && check_metadata /opt/nemoclaw-hermes-config/generate-config.ts 'root:root 444' \
    && check_metadata /opt/nemoclaw-hermes-config/hindsight-client-requirements.txt 'root:root 444' \
    && check_metadata /usr/local/lib/nemoclaw/validate-hermes-env-secret-boundary.py 'root:root 755' \
    && check_metadata /usr/local/lib/nemoclaw/patch-hermes-discord-recovery-permissions.py 'root:root 755' \
    && check_metadata /usr/local/lib/nemoclaw/managed_policy.py 'root:root 444' \
    && check_metadata /usr/local/share/nemoclaw/hermes-managed-policy.json 'root:root 444' \
    && test ! -L /usr/local/bin/nemoclaw-managed-bootstrap \
    && check_metadata /usr/local/bin/nemoclaw-managed-bootstrap 'root:root 755' \
    && test ! -L /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh \
    && check_metadata /usr/local/lib/nemoclaw/managed-bootstrap-trampoline.sh 'root:root 444' \
    && check_metadata /usr/local/bin/nemoclaw-gateway-control 'root:root 700' \
    && check_metadata /usr/local/lib/nemoclaw/hermes-cron-restore-control.py 'root:root 700' \
    && check_metadata /usr/local/lib/nemoclaw/preloads/sandbox-safety-net.js 'root:root 444' \
    && check_metadata /usr/local/lib/nemoclaw/hermes-wrapper.py 'root:root 755' \
    && check_metadata /usr/local/lib/nemoclaw/validate-hermes-cli-adapter.py 'root:root 755' \
    && check_metadata /usr/local/share/nemoclaw/hermes-cli-adapter-v1.json 'root:root 444'

# Verify the immutable security package inventory in the completed image.
# hadolint ignore=DL4006
RUN set -eu; \
    security_inventory=/usr/local/share/nemoclaw/security-packages.txt; \
    arch="$(dpkg --print-architecture)"; \
    test -f "$security_inventory"; \
    test ! -L "$security_inventory"; \
    test "$(stat -c '%u:%g:%a' "$security_inventory")" = "0:0:444"; \
    printf '%s\n' \
        "architecture=$arch" \
        "libexpat1=2.8.3-1" \
        "libonig5=6.9.9-1+b1" \
        "libjq1=1.8.2-1" \
        "jq=1.8.2-1" \
        "vim-common=2:9.2.0858-1" \
        "vim-tiny=2:9.2.0858-1" \
        "libssh2-1t64=1.11.1-1+deb13u1+nemoclaw2" \
        "libssl3t64=3.5.7-1~deb13u2" \
        "nemoclaw-python3.13-htmlparser-fix=3.13.5-2+deb13u4+nemoclaw1" \
        "perl-base=5.44.0-1nemoclaw1" \
        "perl=5.44.0-1nemoclaw1" \
        | cmp -s - "$security_inventory"; \
    test "$(dpkg-query -W -f='${Version}' libexpat1)" = "2.8.3-1"; \
    test "$(dpkg-query -W -f='${Version}' libonig5)" = "6.9.9-1+b1"; \
    test "$(dpkg-query -W -f='${Version}' libjq1)" = "1.8.2-1"; \
    test "$(dpkg-query -W -f='${Version}' jq)" = "1.8.2-1"; \
    test "$(dpkg-query -W -f='${Version}' vim-common)" = "2:9.2.0858-1"; \
    test "$(dpkg-query -W -f='${Version}' vim-tiny)" = "2:9.2.0858-1"; \
    test "$(dpkg-query -W -f='${Version}' libssh2-1t64)" = "1.11.1-1+deb13u1+nemoclaw2"; \
    test "$(dpkg-query -W -f='${Version}' libssl3t64)" = "3.5.7-1~deb13u2"; \
    test "$(dpkg-query -W -f='${Version}' nemoclaw-python3.13-htmlparser-fix)" = "3.13.5-2+deb13u4+nemoclaw1"; \
    test "$(dpkg-query -W -f='${Version}' perl-base)" = "5.44.0-1nemoclaw1"; \
    test "$(dpkg-query -W -f='${Version}' perl)" = "5.44.0-1nemoclaw1"; \
    test "$(perl -e 'print $^V')" = "v5.44.0"; \
    ldd /usr/bin/jq | grep -Eq 'libonig[.]so[.]5'; \
    test "$(jq --version)" = "jq-1.8.2"; \
    printf '%s\n' '{"sandbox":"healthy"}' | jq -e '.sandbox == "healthy"' >/dev/null; \
    python3 -c "import pyexpat; assert pyexpat.EXPAT_VERSION == 'expat_2.8.3', pyexpat.EXPAT_VERSION"; \
    printf '%s  %s\n' \
        "4ff43a8578bda2f14686c67911b64c18e869841973722b1c623b5727491bdaf7" \
        /usr/lib/python3.13/html/parser.py \
        | sha256sum -c -; \
    python3 -c "import sys; from pathlib import Path; import html.parser; Path(html.parser.__file__).resolve() == Path('/usr/lib/python3.13/html/parser.py').resolve() or sys.exit('html.parser loaded from an unexpected path'); from html.parser import HTMLParser; p=HTMLParser(); [p.feed('') for _ in range(20000)]; p._pending == [] or sys.exit('empty feeds accumulated pending entries'); p.feed('<!--'); [p.feed('a' * 64) for _ in range(20000)]; p.feed('-->'); p.close(); p.rawdata == '' or sys.exit('incremental parsing retained raw data')"; \
    python3 -c "import ctypes, sys; lib=ctypes.CDLL('libssh2.so.1'); lib.libssh2_version.restype=ctypes.c_char_p; lib.libssh2_version(0) == b'1.11.1' or sys.exit('unexpected libssh2 runtime version')"; \
    vim.tiny --version | head -n 1 | grep -Eq '^VIM - Vi IMproved 9[.]2 '; \
    vim.tiny --version | grep -Fx 'Included patches: 1-858'; \
    test -z "$(dpkg --audit)"
# End completed-image security package verification.

# start.sh handles privilege separation: runs as root initially, then drops
# to the 'gateway' user via setpriv for the agent process. See start.sh.
ENTRYPOINT ["/usr/local/bin/nemoclaw-start"]
CMD ["/bin/bash"]
