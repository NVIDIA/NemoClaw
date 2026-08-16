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

describe("native runtime qualification producer workflow", () => {
  it("keeps candidate execution out of the authenticated controller", () => {
    const generate = job("generate-matrix");
    const checkout = generate.steps?.find((entry) => entry.uses?.startsWith("actions/checkout@"));

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

    expect(plan.if).toContain("github.ref == 'refs/heads/main'");
    expect(plan.if).toContain("inputs.jobs == 'native-runtime-qualification-producer'");
    expect(plan.permissions).toEqual({
      actions: "read",
      contents: "read",
      "pull-requests": "read",
    });
    expect(authenticate.run).toContain('"$CANDIDATE_REPOSITORY" == "NVIDIA/NemoClaw"');
    expect(authenticate.run).toContain('"$WORKFLOW_SHA" == "$BASE_SHA"');
    expect(authenticate.run).toContain('"$WORKFLOW_SHA" == "$CANDIDATE_SHA"');
    expect(authenticate.env?.DISPATCH_WORKFLOW_SHA).toBe("${{ github.workflow_sha }}");
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
    const trustedCheckout = step(plan, "Check out the trusted qualification producer");
    expect(trustedCheckout.with?.["sparse-checkout"]).toContain(
      "src/lib/onboard/runtime-provider/native-qualification-authority.ts",
    );
  });

  it("limits candidate-workflow protected execution to the latest commit on an administrator-controlled PR source branch", () => {
    const generate = job("generate-matrix");
    const authenticate = step(generate, "Authenticate manual PR dispatch");
    const source = authenticate.run ?? "";

    expect(source).toContain(
      "Candidate-workflow native runtime qualification requires a repository administrator",
    );
    expect(source).toContain(
      '"$CHECKOUT_REPOSITORY" == "$GITHUB_REPOSITORY" && "$WORKFLOW_SHA" == "$CHECKOUT_SHA" && "$BASE_SHA" != "$CHECKOUT_SHA"',
    );
    expect(source).toContain('"$WORKFLOW_REF" == "refs/heads/${pr_source_ref}"');
    expect(source).toContain('"$JOBS" == "native-runtime-qualification-producer" && -z "$TARGETS"');
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
    expect(setupGo.uses).toBe("actions/setup-go@44694675825211faa026b3c33043df3e48a5fa00");
    expect(setupGo.with).toEqual({ "go-version": "1.25.9", cache: false });
    expect(setupRust.uses).toBe(
      "actions-rust-lang/setup-rust-toolchain@166cdcfd11aee3cb47222f9ddb555ce30ddb9659",
    );
    expect(setupRust.with).toEqual({ toolchain: "1.88.0", cache: false, rustflags: "" });
    expect(buildDependencies.run).not.toContain("libsubid-dev");
    expect(buildDependencies.run).not.toContain("libgpgme-dev");
    expect(buildDependencies.run).not.toContain("libassuan-dev");
    expect(buildDependencies.run).not.toContain("libgpg-error-dev");
    expect(build.run).toContain("podman rootlessport PREFIX=/usr/local");
    expect(build.run).toContain("EXTRA_BUILDTAGS=containers_image_openpgp");
    expect(build.run).not.toContain("quadlet");
    expect(build.run).toContain("make --directory=.netavark-source --jobs=2 build");
    expect(build.run).toContain("make --directory=.aardvark-source --jobs=2 build");
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

  it("runs each candidate case in an isolated account and emits one trusted artifact", () => {
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
    const installer = step(producer, "Run the authenticated installer qualification");
    const execute = step(producer, "Execute the candidate qualification case without credentials");
    const validate = step(producer, "Validate receipts and emit bounded evidence");
    const upload = step(producer, "Upload the qualification case evidence");
    const cleanup = step(producer, "Remove qualification resources");
    const source = JSON.stringify(producer);
    const boundaryRun = boundary.run ?? "";
    const executeRun = execute.run ?? "";

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
    expect(source).not.toMatch(/NVIDIA_API_KEY|NVIDIA_INFERENCE_API_KEY|DOCKERHUB_TOKEN/u);
    expect(podmanHost.run).toContain('[[ "${ID:-}" == "ubuntu" ]]');
    expect(podmanHost.run).toContain('"${VERSION_ID:-}" == "24.04"');
    expect(podmanHost.run).toContain('"${VERSION_ID:-}" == "26.04"');
    expect(podmanHost.run).toContain("Ubuntu release is not reviewed");
    expect(podmanDownload.with).toMatchObject({
      name: "native-runtime-podman-toolchain-${{ matrix.case.architecture }}",
      path: "${{ runner.temp }}/native-runtime-podman-toolchain",
    });
    expect(podman.run).toContain("/usr/bin/apt-get install");
    for (const requiredPackage of [
      "acl",
      "apparmor",
      "conmon",
      "fuse-overlayfs",
      "golang-github-containers-common",
      "passt",
      "runc",
      "slirp4netns",
      "uidmap",
    ]) {
      expect(podman.run).toContain(requiredPackage);
    }
    expect(podman.run).toContain("find -P");
    expect(podman.run).toContain("sha256sum --check --strict SHA256SUMS");
    expect(podman.run).toContain('"nemoclaw-native-podman-toolchain-v1"');
    expect(podman.run).toContain("Downloaded native Podman toolchain contains unexpected files");
    expect(podman.run).toContain("Native Podman toolchain target must not be a symlink");
    expect(podman.run).toContain('dpkg --compare-versions "$conmon_version" ge 2.1.7');
    expect(podman.run).toContain('dpkg --compare-versions "$runc_version" ge 1.1.11');
    expect(podman.run).toContain('"netavark 2.1.0"');
    expect(podman.run).toContain('"aardvark-dns 2.1.0"');
    expect(podman.run).toContain('[[ "$version" == "podman version 6.1.0" ]]');
    expect(podman.run).not.toContain("CANDIDATE_DIRECTORY");
    expect(boundary.run).toContain("mask --runtime docker.service docker.socket");
    expect(boundary.run).toContain("useradd --create-home --shell /usr/sbin/nologin");
    expect(boundary.run).toContain("ensure_subordinate_range /etc/subuid --add-subuids");
    expect(boundary.run).toContain("ensure_subordinate_range /etc/subgid --add-subgids");
    expect(boundary.run).toContain("has no free subordinate-ID range for rootless Podman");
    expect(boundary.run).toContain('sudo -u "$account" env -i');
    expect(boundary.run).toContain("podman info --format json");
    expect(boundary.run).toContain("Credential-free rootless Podman readiness failed");
    expect(boundary.run).toContain('install -d -m 0755 "$guard_dir"');
    expect(boundary.run).toContain('chmod 0555 "$guard_dir/docker"');
    expect(boundary.run).toContain('setfacl --modify "u:${account}:--x"');
    expect(boundary.run).not.toContain("chmod o+x");
    expect(boundaryRun.indexOf("printf 'account=%s")).toBeLessThan(
      boundaryRun.indexOf("useradd --create-home"),
    );
    expect(dependencies.run).toContain('sudo -u "$ACCOUNT" env -i');
    expect(dependencies.run).toContain('cd "$1"');
    expect(dependencies.run).toContain("package.json package-lock.json");
    expect(dependencies.run).toContain('! -L "$file" && -O "$file"');
    expect(dependencies.run).toContain("npm --prefix");
    expect(dependencies.run).toContain("ci --ignore-scripts");
    expect(installer.run).toContain('sudo -u "$ACCOUNT" env -i');
    expect(installer.run).toContain("run-native-runtime-installer-qualification.sh");
    expect(installer.run).not.toContain("chown -R");
    expect(installer.run).toContain('sudo test -d "$INSTALLER_RECEIPT_PARENT/receipts"');
    expect(installer.run).toContain('sudo test ! -L "$INSTALLER_RECEIPT_PARENT/receipts"');
    expect(execute.run).toContain('sudo -u "$ACCOUNT" env -i');
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
    expect(execute.run).toContain(
      'PATH="$GUARD_DIRECTORY:$NODE_DIRECTORY:/usr/local/bin:/usr/bin:/bin"',
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
    expect(cleanup.run).toContain('account="${ACCOUNT:-nemoclawq}"');
    expect(cleanup.run).toContain("pkill -KILL -u");
    expect(cleanup.run).toContain("userdel --remove");
    expect(cleanup.run).toContain("Qualification account still exists after cleanup");
  });

  it("aggregates the exact successful 24-case cohort in a separate trusted job", () => {
    const aggregate = job("native-runtime-qualification-producer-aggregate");
    const download = step(aggregate, "Download the exact case evidence cohort");
    const identity = step(aggregate, "Resolve this aggregate job identity");
    const setupNode = step(aggregate, "Set up Node for qualification aggregation");
    const collect = step(aggregate, "Validate and aggregate all 24 case receipts");
    const upload = step(aggregate, "Upload the immutable aggregate evidence");
    const aggregateCheckout = step(aggregate, "Check out the trusted qualification aggregator");

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
