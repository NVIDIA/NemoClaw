// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  readYaml,
  type Workflow,
  type WorkflowJob,
  type WorkflowStep,
} from "../../helpers/e2e-workflow-contract";

function workflow(): Workflow {
  return readYaml(".github/workflows/e2e.yaml") as Workflow;
}

function job(name: string): WorkflowJob {
  const value = workflow().jobs[name];
  expect(value, `missing workflow job '${name}'`).toBeDefined();
  return value!;
}

function step(owner: WorkflowJob, name: string): WorkflowStep {
  const value = owner.steps?.find((entry) => entry.name === name);
  expect(value, `missing workflow step '${name}'`).toBeDefined();
  return value!;
}

function expectRequiredPodmanPackages(run: string): void {
  for (const requiredPackage of [
    "acl",
    "apparmor",
    "conmon",
    "golang-github-containers-common",
    "runc",
    "slirp4netns",
    "uidmap",
  ]) {
    expect(run).toContain(requiredPackage);
  }
}

describe("native runtime qualification producer workflow", () => {
  it("keeps candidate execution out of the authenticated controller", () => {
    const generate = job("generate-matrix");
    const checkout = step(generate, "Check out E2E candidate");

    expect(checkout?.if).toContain("inputs.jobs != 'native-runtime-qualification-producer'");
    expect(step(generate, "Validate manual PR checkout").if).toContain(
      "inputs.jobs != 'native-runtime-qualification-producer'",
    );
    expect(step(generate, "Authorize E2E credentials").if).toContain(
      "inputs.jobs != 'native-runtime-qualification-producer'",
    );
    expect(step(generate, "Prepare E2E workspace").if).toContain(
      "inputs.jobs != 'native-runtime-qualification-producer'",
    );
    expect(step(generate, "Package exact-commit CLI").if).toContain(
      "inputs.jobs != 'native-runtime-qualification-producer'",
    );
    expect(step(generate, "Generate E2E target matrix").run).toContain(
      'selected_jobs=["native-runtime-qualification-producer"]',
    );
  });

  it("compiles the matrix only from authenticated source and repository-owned runner policy", () => {
    const plan = job("native-runtime-qualification-producer-plan");
    const authenticate = step(plan, "Authenticate the candidate and dispatch artifact");
    const compile = step(plan, "Compile the trusted qualification producer matrix");

    expect(plan.if).toBe(
      "${{ github.event_name == 'workflow_dispatch' && github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && inputs.checkout_sha != '' && inputs.jobs == 'native-runtime-qualification-producer' && inputs.targets == '' }}",
    );
    expect(plan.permissions).toEqual({
      actions: "read",
      contents: "read",
      "pull-requests": "read",
    });
    expect(authenticate.run).toContain('"$CANDIDATE_REPOSITORY" == "NVIDIA/NemoClaw"');
    expect(authenticate.run).toContain('"$BASE_SHA" == "$WORKFLOW_SHA"');
    expect(authenticate.run).toContain('"$CANDIDATE_SHA" != "$WORKFLOW_SHA"');
    expect(authenticate.run).not.toContain('"$WORKFLOW_SHA" == "$CANDIDATE_SHA"');
    expect(authenticate.run).toContain(".head.sha == $candidateSha");
    expect(authenticate.run).toContain(".base.sha == $baseSha");
    expect(authenticate.run).toContain(".total_count == 1");
    expect(authenticate.run).toContain(".size_in_bytes <= 1048576");
    expect(authenticate.run).toContain("sha256sum .candidate-source/scripts/install.sh");
    expect(compile.env?.NATIVE_RUNTIME_ARM64_GPU_RUNNER_LABEL).toBe(
      "${{ vars.NATIVE_RUNTIME_ARM64_GPU_RUNNER_LABEL }}",
    );
    expect(compile.run).toContain("native-runtime-qualification-producer-plan.mts --ci-output");
    expect(JSON.stringify(plan)).not.toContain("linux-arm64-gpu-dgx-spark-gb10-protected-1");
    const producerCheckout = step(plan, "Check out the trusted qualification producer");
    expect(producerCheckout.with?.["sparse-checkout"]).toContain(
      "src/lib/onboard/runtime-provider/native-qualification-authority.ts",
    );
  });

  it("keeps secret-bearing GPU preparation downstream of the trusted-main plan", () => {
    const producer = job("native-runtime-qualification-producer");
    const gpuResources = step(producer, "Prepare GPU resources with the NVIDIA API key");

    expect(producer.needs).toContain("native-runtime-qualification-producer-plan");
    expect(gpuResources.env?.NVIDIA_API_KEY).toBe("${{ secrets.NVIDIA_API_KEY }}");
  });

  it("builds one pinned Podman 6 toolchain for each qualified architecture", () => {
    const toolchain = job("native-runtime-qualification-podman-toolchain");
    const podmanSource = step(toolchain, "Check out the pinned Podman source");
    const netavarkSource = step(toolchain, "Check out the pinned Netavark source");
    const aardvarkSource = step(toolchain, "Check out the pinned Aardvark DNS source");
    const setupGo = step(toolchain, "Set up pinned Go for the Podman build");
    const setupRust = step(toolchain, "Set up pinned Rust for the network helper builds");
    const buildDependencies = step(
      toolchain,
      "Install build dependencies from the signed runner OS repository",
    );
    const build = step(toolchain, "Build and package the pinned native toolchain");
    const upload = step(toolchain, "Upload the pinned native Podman toolchain");

    expect(toolchain.name).toBe(
      "Build pinned native Podman toolchain / ${{ matrix.architecture }}",
    );
    expect(toolchain.needs).toEqual([
      "generate-matrix",
      "native-runtime-qualification-producer-plan",
    ]);
    expect(toolchain["runs-on"]).toBe("${{ matrix.runner }}");
    expect(toolchain.permissions).toEqual({ contents: "read" });
    expect(toolchain.strategy).toMatchObject({
      "fail-fast": false,
      matrix: {
        include: [
          { architecture: "amd64", runner: "ubuntu-24.04" },
          { architecture: "arm64", runner: "ubuntu-24.04-arm" },
        ],
      },
    });
    expect(podmanSource.with).toMatchObject({
      repository: "podman-container-tools/podman",
      ref: "cade97a52ebdf9dbf9e81de8009015776837a074",
      path: ".podman-source",
      "fetch-depth": 1,
      "persist-credentials": false,
    });
    expect(netavarkSource.with).toMatchObject({
      repository: "containers/netavark",
      ref: "8e91ad1d947ed325327b638f0cb906bea1f7d0ab",
      path: ".netavark-source",
      "fetch-depth": 1,
      "persist-credentials": false,
    });
    expect(aardvarkSource.with).toMatchObject({
      repository: "containers/aardvark-dns",
      ref: "cd7417681229219059939bdd9f0b3bd9ac9abb08",
      path: ".aardvark-source",
      "fetch-depth": 1,
      "persist-credentials": false,
    });
    expect(setupGo.uses).toBe("actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e");
    expect(setupGo.with).toEqual({ "go-version": "1.25.9", cache: false });
    expect(setupRust.uses).toBe(
      "actions-rust-lang/setup-rust-toolchain@166cdcfd11aee3cb47222f9ddb555ce30ddb9659",
    );
    expect(setupRust.with).toEqual({ toolchain: "1.88.0", cache: false, rustflags: "" });
    expect(buildDependencies.run).not.toContain("libsubid-dev");
    expect(buildDependencies.run).not.toContain("libgpgme-dev");
    expect(buildDependencies.run).not.toContain("libassuan-dev");
    expect(buildDependencies.run).not.toContain("libgpg-error-dev");
    expect(buildDependencies.run).toContain("curl");
    expect(build.run).toContain("podman rootlessport PREFIX=/usr/local");
    expect(build.run).toContain("EXTRA_BUILDTAGS=containers_image_openpgp");
    expect(build.run).not.toContain("quadlet");
    expect(build.run).toContain("make --directory=.netavark-source --jobs=2 build");
    expect(build.run).toContain("make --directory=.aardvark-source --jobs=2 build");
    expect(build.run).toContain("https://passt.top/passt");
    expect(build.run).toContain("/usr/bin/curl");
    expect(build.env?.PASTA_SOURCE_ARCHIVE_SHA256).toBe(
      "54fc6a3b39b0fcb13182078662886a629032852e186e47a371fd9d7fd20d3958",
    );
    expect(build.env?.PASTA_SOURCE_SHA).toBe("f8df3f1b228fe19a74a269334fdfe6cc7d0605ce");
    expect(build.env?.PASTA_VERSION).toBe("2026_07_28.f8df3f1");
    expect(build.run).toContain('sha256sum "$pasta_source_archive"');
    expect(build.run).toContain("--no-same-owner --no-same-permissions");
    expect(build.run).toContain("[[ ! -e .passt-source/passt && ! -L .passt-source/passt ]]");
    expect(build.run).not.toMatch(/\bgit\s+fetch\b/u);
    expect(build.run).toContain(
      'make --directory=.passt-source --jobs=2 VERSION="$PASTA_VERSION" passt',
    );
    expect(build.run).toContain(
      'install -D -m 0755 .passt-source/passt "$TOOLCHAIN_DIRECTORY/bin/pasta"',
    );
    expect(build.run).toContain("pasta_version_output=");
    expect(build.run).toContain("pasta_version_output%%$'\\n'*");
    expect(build.run).toContain('"pasta $PASTA_VERSION"');
    expect(build.run).toContain("Pinned qualification pasta version is invalid");
    expect(build.run).toMatch(/sha256sum[\s\S]+bin\/pasta[\s\S]+manifest\.json/u);
    expect(build.run).toContain("sha256sum");
    expect(build.run).toContain("Pinned Podman build has an unresolved runtime dependency");
    expect(build.run).toContain("Pinned Podman build must not require an optional host ABI");
    expect(build.run).toContain('grep -E "libgpgme|libsubid"');
    expect(build.run).toMatch(/sha256sum[\s\S]+manifest\.json/u);
    expect(build.run).toContain('"nemoclaw-native-podman-toolchain-v1"');
    expect(upload.with).toMatchObject({
      name: "native-runtime-podman-toolchain-${{ matrix.architecture }}",
      path: "${{ runner.temp }}/native-runtime-podman-toolchain/",
    });
    expect(upload.if).toBe("success()");
    expect(upload.uses).toBe(
      "NVIDIA/NemoClaw/.github/actions/upload-e2e-artifacts@7768e15eb90d3ee2d33432f481dfe8747e4f6d57",
    );
  });

  it("runs each candidate case in an isolated account and emits one bounded evidence artifact", () => {
    const producer = job("native-runtime-qualification-producer");
    const harness = step(producer, "Check out the trusted qualification harness");
    const podmanHost = step(producer, "Require a reviewed Ubuntu runtime host");
    const podmanDownload = step(producer, "Download the pinned native Podman toolchain");
    const podman = step(
      producer,
      "Install the pinned native Podman toolchain and rootless prerequisites",
    );
    const boundary = step(
      producer,
      "Prepare the credential-free execution account and disable Docker",
    );
    const dependencies = step(
      producer,
      "Install locked candidate test dependencies without scripts",
    );
    const gpuResources = step(producer, "Prepare GPU resources with the NVIDIA API key");
    const installer = step(producer, "Run the authenticated installer qualification");
    const execute = step(producer, "Execute the candidate qualification case without credentials");
    const validate = step(producer, "Validate receipts and emit bounded evidence");
    const upload = step(producer, "Upload the qualification case evidence");
    const cleanup = step(producer, "Remove qualification resources");
    const credentialFreeSource = JSON.stringify({
      ...producer,
      steps: producer.steps?.filter(
        (entry) => entry.name !== "Prepare GPU resources with the NVIDIA API key",
      ),
    });
    const boundaryRun = boundary.run ?? "";
    const executeRun = execute.run ?? "";
    const gpuResourcesRun = gpuResources.run ?? "";

    expect(producer.name).toBe("${{ matrix.jobName }}");
    expect(producer.needs).toEqual([
      "generate-matrix",
      "native-runtime-qualification-podman-toolchain",
      "native-runtime-qualification-producer-plan",
    ]);
    expect(producer["runs-on"]).toBe("${{ matrix.runner }}");
    expect(producer.permissions).toEqual({ contents: "read" });
    expect(producer.strategy).toMatchObject({ "fail-fast": false });
    expect(harness.with?.["sparse-checkout"]).toContain(
      "tools/e2e/native-runtime-qualification-producer-plan.mts",
    );
    expect(harness.with?.["sparse-checkout"]).toContain(
      "test/e2e/registry/native-runtime-qualification.ts",
    );
    expect(credentialFreeSource).not.toMatch(
      /NVIDIA_API_KEY|NVIDIA_INFERENCE_API_KEY|DOCKERHUB_TOKEN/u,
    );
    expect(gpuResources.env?.NVIDIA_API_KEY).toBe("${{ secrets.NVIDIA_API_KEY }}");
    expect(gpuResources.run).toContain("NVIDIA_API_KEY repository secret");
    expect(gpuResources.run).toContain("login nvcr.io --username '$oauthtoken' --password-stdin");
    expect(gpuResources.run).not.toContain("logout --all");
    expect(gpuResources.run).toContain('sudo unlink "$registry_auth_file"');
    expect(gpuResources.run).toContain("$(sudo stat -c '%u:%g:%h' -- \"$registry_auth_file\")");
    expect(gpuResources.run).toContain('sudo chmod 0600 -- "$registry_auth_file"');
    expect(gpuResources.env?.ACCOUNT_GID).toBe("${{ steps.boundary.outputs.gid }}");
    expect(gpuResources.env?.ACCOUNT_UID).toBe("${{ steps.boundary.outputs.uid }}");
    expect(gpuResources.run).toContain("${uid}:${gid}:600:1");
    expect(gpuResourcesRun.indexOf('sudo chmod 0600 -- "$registry_auth_file"')).toBeGreaterThan(
      gpuResourcesRun.indexOf("login nvcr.io --username '$oauthtoken' --password-stdin"),
    );
    expect(gpuResourcesRun.indexOf('sudo chmod 0600 -- "$registry_auth_file"')).toBeLessThan(
      gpuResourcesRun.indexOf('"$PODMAN_EXECUTABLE" pull "$image"'),
    );
    expect(gpuResources.run).toContain("unset NVIDIA_API_KEY");
    expect(gpuResources.run).toContain("7ae557604adf67be50417f59c2c2f167def9a775");
    expect(gpuResources.run).toContain("sudo stat -c '%u:%g:%a:%h:%s' -- \"$target\"");
    expect(gpuResources.run).toContain("sudo stat -c '%u:%g:%h:%s' -- \"$target\"");
    expect(gpuResources.run).toContain('sudo chmod 0600 -- "$target"');
    expect(gpuResourcesRun.indexOf('sudo chmod 0600 -- "$target"')).toBeGreaterThan(
      gpuResourcesRun.indexOf("sudo stat -c '%u:%g:%h:%s'"),
    );
    expect(gpuResourcesRun.indexOf('sudo chmod 0600 -- "$target"')).toBeLessThan(
      gpuResourcesRun.indexOf("sudo stat -c '%u:%g:%a:%h:%s'"),
    );
    expect(gpuResources.run).toContain('sudo git hash-object --no-filters -- "$target"');
    expect(gpuResources.run).toContain('sudo sha256sum -- "$target"');
    expect(gpuResources.run).toContain("model-free-nim@sha256:");
    expect(gpuResources.run).toContain("nvcr.io/nvidia/vllm@sha256:");
    expect(gpuResources.run).toContain("runner-contract.json");
    expect(gpuResources.run).toContain(
      'install -d --owner=root --group=root --mode=0711 "$resource_directory"',
    );
    expect(gpuResources.run).toContain('chmod 0555 "$resource_directory"');
    expect(podmanHost.run).toContain('[[ "${ID:-}" == "ubuntu" ]]');
    expect(podmanHost.run).toContain('"${VERSION_ID:-}" == "24.04"');
    expect(podmanHost.run).toContain('"${VERSION_ID:-}" == "26.04"');
    expect(podmanHost.run).toContain("Ubuntu release is not reviewed");
    expect(podmanDownload.with).toMatchObject({
      name: "native-runtime-podman-toolchain-${{ matrix.case.architecture }}",
      path: "${{ runner.temp }}/native-runtime-podman-toolchain",
    });
    expect(podman.run).toContain("/usr/bin/apt-get install");
    expectRequiredPodmanPackages(podman.run ?? "");
    expect(podman.run).not.toMatch(/\s+passt(?:\s|$)/u);
    expect(podman.run).not.toContain("fuse-overlayfs");
    expect(podman.run).toContain("find -P");
    expect(podman.run).toContain("sha256sum --check --strict SHA256SUMS");
    expect(podman.run).toContain("./bin/pasta");
    expect(podman.run).toContain('"nemoclaw-native-podman-toolchain-v1"');
    expect(podman.run).toContain("Downloaded native Podman toolchain contains unexpected files");
    expect(podman.run).toContain("Native Podman toolchain target must not be a symlink");
    expect(podman.run).toContain('dpkg --compare-versions "$conmon_version" ge 2.1.7');
    expect(podman.run).toContain('dpkg --compare-versions "$runc_version" ge 1.1.11');
    expect(podman.run).toContain('"netavark 2.1.0"');
    expect(podman.run).toContain('"aardvark-dns 2.1.0"');
    expect(podman.run).toContain('"2026_07_28.f8df3f1"');
    expect(podman.run).toContain(
      '"54fc6a3b39b0fcb13182078662886a629032852e186e47a371fd9d7fd20d3958"',
    );
    expect(podman.run).toContain('"f8df3f1b228fe19a74a269334fdfe6cc7d0605ce"');
    expect(podman.run).toContain('[[ "$version" == "podman version 6.1.0" ]]');
    expect(podman.run).not.toContain("CANDIDATE_DIRECTORY");
    expect(boundary.run).toContain("mask --runtime docker.service docker.socket");
    expect(boundary.run).toContain("useradd --create-home --shell /usr/sbin/nologin --user-group");
    expect(boundary.run).toContain('getent passwd "$account"');
    expect(boundary.run).toContain('getent group "$account"');
    expect(boundary.run).toContain('grep -q "^${account}:" /etc/subuid /etc/subgid');
    expect(boundary.run).toContain(
      "Qualification account, group, or subordinate-ID authorization already exists",
    );
    expect(boundary.run).toContain('ownership_marker="/run/nemoclaw-native-runtime-owner-');
    expect(boundary.run).toContain("0:0:400");
    expect(boundary.run).toContain("Qualification account ownership marker is invalid");
    expect(boundary.run).toContain("rollback_unmarked_account");
    expect(boundary.run).toContain(
      "Partially created qualification account could not be rolled back",
    );
    expect(boundary.run).toContain("ensure_subordinate_range /etc/subuid --add-subuids");
    expect(boundary.run).toContain("ensure_subordinate_range /etc/subgid --add-subgids");
    expect(boundary.run).toContain("has no free subordinate-ID range for rootless Podman");
    expect(boundary.run).toContain('runtime_directory_unit="user-runtime-dir@${uid}.service"');
    expect(boundary.run).toContain("Qualification runtime directory is missing or invalid");
    expect(boundary.run).toContain('user_manager_unit="user@${uid}.service"');
    expect(boundary.run).toContain('systemctl start "$user_manager_unit"');
    expect(boundary.run).toContain("/usr/bin/systemctl --user start dbus.socket");
    expect(boundary.run).toContain("/usr/bin/systemctl --user is-active --quiet dbus.socket");
    expect(boundary.run).toContain("Qualification systemd user bus socket unit is not active");
    expect(boundary.run).toContain('sudo -u "$execution_account" /usr/bin/test -S "$bus"');
    expect(boundary.run).toContain('sudo /usr/bin/test ! -L "$bus"');
    expect(boundary.run).toContain("sudo stat -c '%u' -- \"$bus\"");
    expect(boundary.run).toContain("Qualification systemd user bus $context");
    expect(boundary.run).toContain(
      'trusted_user_unit_path="/usr/lib/systemd/user:/lib/systemd/user"',
    );
    expect(boundary.run).toContain('Environment="SYSTEMD_UNIT_PATH=%s"');
    expect(boundary.run).toContain("/usr/bin/systemctl --user show-environment");
    expect(boundary.run).toContain('sudo -u "$account" env -i');
    expect(boundary.run).toContain('CONTAINERS_CONF="$containers_config"');
    expect(boundary.run).toContain('CONTAINERS_STORAGE_CONF="$storage_config"');
    expect(boundary.run).toContain('firewall_driver = "nftables"');
    expect(boundary.run).toContain(
      "Qualification containers configuration is not root-owned and read-only",
    );
    expect(boundary.run).toContain("rootless_storage_path");
    expect(boundary.run).toContain("${home}/.local/share/containers/storage");
    expect(boundary.run).not.toContain('mount_program = "/usr/bin/fuse-overlayfs"');
    expect(boundary.run).toContain('.store.graphDriverName == "overlay"');
    expect(boundary.run).toContain('["overlay.mount_program"].Executable?');
    expect(boundary.run).toContain("Qualification requires native rootless overlay storage");
    expect(boundary.run).toContain("0:0:444");
    expect(boundary.run).toContain("/sys/module/apparmor/parameters/enabled");
    expect(boundary.run).toContain(
      "profile ${apparmor_profile_name} ${podman_executable} flags=(unconfined)",
    );
    expect(boundary.run).toContain(
      "profile ${pasta_apparmor_profile_name} ${pasta_executable} flags=(unconfined)",
    );
    expect(boundary.run).toContain("Run-owned qualification pasta executable digest changed");
    expect(boundary.run).toContain('"$TOOLCHAIN_DIRECTORY/bin/pasta" "$pasta_executable"');
    expect(boundary.run).not.toContain("/usr/bin/pasta");
    expect(boundary.run).toContain(
      'PATH="$guard_dir:$helper_directory:/usr/local/bin:/usr/bin:/bin"',
    );
    expect(boundary.env?.TOOLCHAIN_DIRECTORY).toBe(
      "${{ runner.temp }}/native-runtime-podman-toolchain",
    );
    expect(boundary.run).toContain(
      'podman_executable="/nemoclaw-native-runtime-podman-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${uid}"',
    );
    expect(boundary.run).toContain("sudo install --owner=root --group=root --mode=0555");
    expect(boundary.run).toContain("0:0:555");
    expect(boundary.run).toContain('"$podman_executable" info --format json');
    expect(boundary.run).toContain("userns,");
    expect(boundary.run).toContain('apparmor_parser -r "$apparmor_profile"');
    expect(boundary.run).not.toContain("apparmor_restrict_unprivileged_userns=");
    expect(boundary.run).toContain("Credential-free rootless Podman readiness failed");
    expect(boundary.run).toContain('install -d -m 0755 "$guard_dir"');
    expect(boundary.run).toContain('chmod 0555 "$guard_dir/docker"');
    expect(boundary.run).toContain('setfacl --modify "u:${account}:--x"');
    expect(boundary.run).not.toContain("chmod o+x");
    expect(boundaryRun.indexOf("useradd --create-home")).toBeLessThan(
      boundaryRun.indexOf("printf 'account=%s"),
    );
    expect(boundaryRun.indexOf("Qualification account ownership marker is invalid")).toBeLessThan(
      boundaryRun.indexOf("printf 'account=%s"),
    );
    expect(boundaryRun.indexOf("printf 'account=%s")).toBeGreaterThan(
      boundaryRun.indexOf("useradd --create-home"),
    );
    expect(dependencies.run).toContain('sudo -u "$ACCOUNT" env -i');
    expect(dependencies.run).toContain('cd "$1"');
    expect(dependencies.run).toContain("package.json package-lock.json");
    expect(dependencies.run).toContain('! -L "$file" && -O "$file"');
    expect(dependencies.run).toContain("npm --prefix");
    expect(dependencies.run).toContain("ci --ignore-scripts");
    expect(installer.run).toContain('sudo -u "$ACCOUNT" env -i');
    expect(installer.env?.ACCOUNT_GID).toBe("${{ steps.boundary.outputs.gid }}");
    expect(installer.env?.ACCOUNT_UID).toBe("${{ steps.boundary.outputs.uid }}");
    expect(installer.env?.RUNTIME_DIRECTORY_UNIT).toBe(
      "${{ steps.boundary.outputs.runtime_directory_unit }}",
    );
    expect(installer.run).toContain('sudo chown "$ACCOUNT_UID:$ACCOUNT_GID"');
    expect(installer.run).toContain("/usr/bin/systemctl --user start dbus.socket");
    expect(installer.run).toContain("Qualification systemd user bus socket unit did not restart");
    expect(installer.run).toContain('sudo -u "$ACCOUNT" /usr/bin/test -S "$RUNTIME_DIRECTORY/bus"');
    expect(installer.run).toContain('sudo /usr/bin/test ! -L "$RUNTIME_DIRECTORY/bus"');
    expect(installer.run).toContain("sudo stat -c '%u' -- \"$RUNTIME_DIRECTORY/bus\"");
    expect(installer.run).toContain(
      "Qualification systemd user bus is invalid or inaccessible after installer isolation",
    );
    expect(installer.env?.TRUSTED_USER_UNIT_PATH).toBe("/usr/lib/systemd/user:/lib/systemd/user");
    expect(installer.run).toContain("/usr/bin/systemctl --user show-environment");
    expect(installer.env?.CONTAINERS_CONFIG).toBe(
      "${{ steps.boundary.outputs.containers_config }}",
    );
    expect(installer.run).toContain('CONTAINERS_CONF="$CONTAINERS_CONFIG"');
    expect(installer.run).toContain('CONTAINERS_STORAGE_CONF="$STORAGE_CONFIG"');
    expect(installer.run).toContain('XDG_RUNTIME_DIR="$RUNTIME_DIRECTORY"');
    expect(installer.run).toContain("run-native-runtime-installer-qualification.sh");
    expect(installer.run).not.toContain("chown -R");
    expect(installer.run).toContain('sudo test -d "$INSTALLER_RECEIPT_PARENT/receipts"');
    expect(installer.run).toContain('sudo test ! -L "$INSTALLER_RECEIPT_PARENT/receipts"');
    expect(execute.run).toContain('sudo -u "$ACCOUNT" env -i');
    expect(execute.env?.ACCOUNT_GID).toBe("${{ steps.boundary.outputs.gid }}");
    expect(execute.env?.ACCOUNT_UID).toBe("${{ steps.boundary.outputs.uid }}");
    expect(execute.env?.RUNTIME_DIRECTORY_UNIT).toBe(
      "${{ steps.boundary.outputs.runtime_directory_unit }}",
    );
    expect(execute.run).toContain('sudo chown "$ACCOUNT_UID:$ACCOUNT_GID"');
    expect(execute.run).toContain(
      'live_test="test/e2e/live/native-runtime-qualification-case.test.ts"',
    );
    expect(execute.run).toContain('cd "$CANDIDATE_DIRECTORY"');
    expect(executeRun.indexOf('cd "$CANDIDATE_DIRECTORY"')).toBeLessThan(
      executeRun.indexOf('sudo -u "$ACCOUNT" env -i'),
    );
    expect(execute.run).toContain("native-runtime-qualification-case.test.ts");
    expect(execute.run).not.toContain("GITHUB_TOKEN");
    expect(execute.run).not.toContain("GH_TOKEN");
    expect(execute.run).not.toContain("chown -R");
    expect(execute.env?.NODE_DIRECTORY).toBe("${{ steps.boundary.outputs.node_dir }}");
    expect(execute.env?.CONTAINERS_CONFIG).toBe("${{ steps.boundary.outputs.containers_config }}");
    expect(execute.env?.PODMAN_EXECUTABLE).toBe("${{ steps.boundary.outputs.podman_executable }}");
    expect(execute.env?.STORAGE_CONFIG).toBe("${{ steps.boundary.outputs.storage_config }}");
    expect(execute.env?.RUNNER_CONTRACT).toBe("${{ steps.gpu_resources.outputs.runner_contract }}");
    expect(execute.run).toContain('CONTAINERS_STORAGE_CONF="$STORAGE_CONFIG"');
    expect(execute.run).toContain('CONTAINERS_CONF="$CONTAINERS_CONFIG"');
    expect(execute.run).toContain(
      'NEMOCLAW_NATIVE_RUNTIME_QUALIFICATION_PODMAN_EXECUTABLE="$PODMAN_EXECUTABLE"',
    );
    expect(execute.run).toContain(
      'PATH="$GUARD_DIRECTORY:$HELPER_DIRECTORY:$NODE_DIRECTORY:/usr/local/bin:/usr/bin:/bin"',
    );
    expect(validate.env?.NODE_DIRECTORY).toBe("${{ steps.boundary.outputs.node_dir }}");
    expect(validate.run).not.toContain('chown -R -h "$(id -u):$(id -g)"');
    expect(validate.run).toContain("sudo --preserve-env=");
    expect(validate.run).toContain('"$NODE_DIRECTORY/node"');
    expect(validate.run).toContain("native-runtime-qualification-producer-evidence.mts");
    expect(upload.with).toMatchObject({
      name: "${{ matrix.artifactName }}",
      path: "${{ runner.temp }}/native-runtime-evidence/",
    });
    expect(cleanup.if).toBe("always()");
    expect(cleanup.env?.ACCOUNT_CREATED).toBe("${{ steps.boundary.outputs.account_created }}");
    expect(cleanup.run).toContain('reported_account="${ACCOUNT:-}"');
    expect(cleanup.run).not.toContain("ACCOUNT:-nemoclawq");
    expect(cleanup.run).toContain(
      "Qualification account ownership marker cleanup target is invalid",
    );
    expect(cleanup.run).toContain('ownership="$(sudo cat "$ownership_marker")"');
    expect(cleanup.run).toContain("pkill -KILL -u");
    expect(cleanup.run).not.toContain("rm -rf");
    expect(cleanup.run).not.toContain("find ");
    expect(cleanup.run).toContain('systemctl stop "$user_manager_unit" "$runtime_directory_unit"');
    expect(cleanup.run).toContain('sudo unlink "$user_manager_dropin"');
    expect(cleanup.run).toContain('sudo rmdir "$user_manager_dropin_directory"');
    expect(cleanup.run).toContain("sudo systemctl daemon-reload");
    expect(cleanup.run).toContain(
      "Qualification systemd user lifecycle remained active during cleanup",
    );
    expect(cleanup.run).toContain('apparmor_parser -R "$apparmor_profile"');
    expect(cleanup.run).toContain('apparmor_parser -R "$pasta_apparmor_profile"');
    expect(cleanup.run).toContain('sudo rm -f -- "$apparmor_profile"');
    expect(cleanup.run).toContain('sudo unlink "$storage_config_directory/containers.conf"');
    expect(cleanup.run).toContain('sudo rm -f -- "$storage_config_directory/storage.conf"');
    expect(cleanup.run).toContain('sudo rm -f -- "$podman_executable"');
    expect(cleanup.run).toContain('sudo test -e "$model_directory"');
    expect(cleanup.run).toContain("sudo stat -c '%u:%g:%a' -- \"$model_directory\"");
    expect(cleanup.run).toContain('sudo test -f "$target"');
    expect(cleanup.run).toContain('sudo test ! -L "$target"');
    expect(cleanup.run).toContain("Qualification Podman executable remains after cleanup");
    expect(cleanup.run).toContain("Qualification GPU resource directory remains after cleanup");
    expect(cleanup.run).toContain(
      "Qualification runtime directory remains after its systemd cleanup",
    );
    expect(cleanup.run).toContain("Qualification storage configuration remains after cleanup");
    expect(cleanup.run).toContain("userdel --remove");
    expect(cleanup.run).toContain("Qualification account still exists after cleanup");
    expect(cleanup.run).toContain("Qualification private group still exists after cleanup");
    expect(cleanup.run).toContain(
      "Qualification subordinate-ID authorization remains after cleanup",
    );
    expect(cleanup.run).toContain(
      "Qualification account output exists without its ownership marker",
    );
    expect(cleanup.run).toContain('sudo rm -f -- "$ownership_marker"');
    const accountOwnershipSource = [
      boundary.run,
      gpuResources.run,
      installer.run,
      execute.run,
      cleanup.run,
    ].join("\n");
    expect(accountOwnershipSource).not.toContain("${uid}:${uid}");
    expect(accountOwnershipSource).not.toContain("$uid:$uid");
    expect(accountOwnershipSource).not.toContain("$ACCOUNT:$ACCOUNT");
  });

  it("aggregates the exact successful 24-case cohort in a separate workflow job", () => {
    const aggregate = job("native-runtime-qualification-producer-aggregate");
    const download = step(aggregate, "Download the exact case evidence cohort");
    const identity = step(aggregate, "Resolve this aggregate job identity");
    const setupNode = step(aggregate, "Set up Node for qualification aggregation");
    const collect = step(aggregate, "Validate and aggregate all 24 case receipts");
    const upload = step(aggregate, "Upload aggregate evidence");
    const aggregateCheckout = step(aggregate, "Check out the qualification aggregator");

    expect(aggregate.name).toBe("Aggregate native runtime qualification evidence");
    expect(aggregate.needs).toEqual([
      "generate-matrix",
      "native-runtime-qualification-producer-plan",
      "native-runtime-qualification-producer",
    ]);
    expect(aggregate.if).toContain(
      "needs.native-runtime-qualification-producer.result == 'success'",
    );
    expect(aggregate.permissions).toEqual({
      actions: "read",
      contents: "read",
      "pull-requests": "read",
    });
    expect(aggregateCheckout.with?.repository).toBe("${{ github.repository }}");
    expect(download.with).toMatchObject({
      pattern: "native-runtime-qualification-evidence-${{ inputs.checkout_sha }}-*",
      "merge-multiple": false,
    });
    expect(identity.run).toContain('.status == "in_progress"');
    expect(identity.run).toContain("select(length == 1)");
    expect(identity.run).toContain("Aggregate job lookup exceeds the bounded 100-job page");
    expect(setupNode.with?.["node-version"]).toBe("22.19.0");
    expect(collect.run).toContain("native-runtime-qualification-producer-aggregate.mts");
    expect(collect.env?.QUALIFICATION_PLAN).toBe(
      "${{ needs.native-runtime-qualification-producer-plan.outputs.matrix }}",
    );
    expect(upload.with).toMatchObject({
      name: "native-runtime-qualification-${{ inputs.checkout_sha }}",
      path: "${{ runner.temp }}/native-runtime-aggregate/",
      "if-no-files-found": "error",
    });
  });
});
