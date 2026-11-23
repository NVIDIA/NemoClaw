// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! CI lifecycle selection at the command boundary, without compiling or deploying fixtures.

use std::{
    fs,
    os::unix::fs::PermissionsExt,
    process::{Command, Output},
};

struct Fixture(tempfile::TempDir);

#[test]
fn build_steps_publish_wall_time_and_outcome_even_on_failure() {
    for step in ["build", "bundle"] {
        for failed in [false, true] {
            let fixture = Fixture::new();
            let summary = fixture.0.path().join("summary.md");
            let output = fixture
                .command(&[step])
                .env("CARGO_RESULT", if failed { "1" } else { "0" })
                .env("GITHUB_STEP_SUMMARY", &summary)
                .output()
                .unwrap();
            assert_eq!(output.status.success(), !failed);
            let report = fs::read_to_string(summary).unwrap_or_default();
            assert!(
                report.contains(&format!("{step} (linux_arm64)")),
                "{report}"
            );
            assert!(report.contains(" s wall"), "{report}");
            assert!(
                report.contains(if failed { "failed" } else { "passed" }),
                "{report}"
            );
        }
    }
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let bin = root.path().join("bin");
        fs::create_dir(&bin).unwrap();
        for (name, script) in [
            ("protoc", "#!/bin/sh\nprintf 'libprotoc 36.2\\n'\n"),
            (
                "cargo",
                r#"#!/bin/sh
if [ "$1 $2" = 'nextest --version' ]; then
    printf 'cargo-nextest 0.9.152\n'
    exit 0
fi
printf '%s\n' "$@" > arguments
{ printf '%s\n' "$@"; printf -- '--\n'; } >> invocations
printf '%s\n' "${NEXTEST_TEST_THREADS-unset}" > test-threads-env
printf '%s\n' "${CARGO_PROFILE_DEV_DEBUG-unset}" > profile-debug-env
printf '%s\n' "${NEMOCLAW_BUNDLE_VERSION-unset}" > bundle-version-env
[ -n "${NEMOCLAW_HCL_CASE-}" ] && printf '%s\n' "$NEMOCLAW_HCL_CASE" >> hcl-cases
if [ "$1" = build ]; then
    /bin/mkdir -p target/debug
    printf '#!/bin/sh\nprintf "%%s\\n" "$@" > bundled\n' > target/debug/nemoclaw-build
    /bin/chmod +x target/debug/nemoclaw-build
    exit "${CARGO_RESULT:-0}"
fi
if [ "$1 $2" = 'nextest list' ]; then
    previous=
    profile=
    for argument; do
        [ "$previous" = --profile ] && profile=$argument
        previous=$argument
    done
    case $profile in
        contract) printf '%s\n' "${CARGO_LIST_CONTRACT:-$CARGO_LIST}" ;;
        integration) printf '%s\n' "${CARGO_LIST_INTEGRATION:-$CARGO_LIST}" ;;
        live-docker) printf '%s\n' "${CARGO_LIST_LIVE_DOCKER:-$CARGO_LIST}" ;;
        live-kind) printf '%s\n' "${CARGO_LIST_LIVE_KIND:-$CARGO_LIST}" ;;
        *) printf '%s\n' "$CARGO_LIST" ;;
    esac
    exit "${CARGO_RESULT:-0}"
fi
printf '%s\n' "$NEMOCLAW_TEST_BUNDLE" "${NEMOCLAW_TEST_TOFU-unset}" "${NEMOCLAW_TEST_PROVIDER-unset}" "${NEMOCLAW_TEST_FIXTURES-unset}" > inputs
exit "${CARGO_RESULT:-0}"
"#,
            ),
        ] {
            let path = bin.join(name);
            fs::write(&path, script).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        // The live-docker step installs the pinned OpenShell CLI unless it is
        // already where the pin puts it. Seed it there, as an earlier run
        // would have; fixtures must never download it, so its pin points
        // nowhere they can reach and a step that tries fails at once.
        let mut pins: serde_json::Value =
            serde_json::from_slice(include_bytes!("../../../versions.json")).unwrap();
        for artifacts in pins["platforms"].as_object_mut().unwrap().values_mut() {
            if let Some(openshell) = artifacts.get_mut("openshell") {
                let checksum = openshell["sha256"].as_str().unwrap();
                let cli = root
                    .path()
                    .join(".tools")
                    .join(format!("openshell-{}", &checksum[..12]))
                    .join("openshell");
                fs::create_dir_all(cli.parent().unwrap()).unwrap();
                fs::write(&cli, "#!/bin/sh\n").unwrap();
                fs::set_permissions(&cli, fs::Permissions::from_mode(0o755)).unwrap();
                openshell["url"] = "http://offline.invalid/openshell.tar.gz".into();
            }
        }
        // Image builds place their pinned sources first, which
        // seed_image_sources downloads as an earlier run would have; these
        // pins lead nowhere.
        for files in pins["imageSources"].as_object_mut().unwrap().values_mut() {
            for (name, source) in files.as_object_mut().unwrap() {
                use sha2::{Digest, Sha256};
                let checksum = nemoclaw_build::hex(&Sha256::digest(name.as_bytes()));
                *source = serde_json::json!({
                    "url": format!("https://offline.invalid/{name}"),
                    "sha256": checksum,
                });
            }
        }
        fs::write(
            root.path().join("versions.json"),
            serde_json::to_vec_pretty(&pins).unwrap(),
        )
        .unwrap();
        Self(root)
    }

    /// Download each pinned image source, whose bytes are its file name.
    fn seed_image_sources(&self) {
        let pins: serde_json::Value =
            serde_json::from_slice(&fs::read(self.0.path().join("versions.json")).unwrap())
                .unwrap();
        let downloads = self.0.path().join(".build/downloads");
        fs::create_dir_all(&downloads).unwrap();
        for files in pins["imageSources"].as_object().unwrap().values() {
            for (name, source) in files.as_object().unwrap() {
                fs::write(downloads.join(source["sha256"].as_str().unwrap()), name).unwrap();
            }
        }
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_nemoclaw-build"));
        command
            .arg("ci")
            .args(args)
            .current_dir(self.0.path())
            .env("CARGO", self.0.path().join("bin/cargo"))
            .env("CARGO_LIST", r#"{"rust-suites":{"selected-suite":{"testcases":{"selected":{"filter-match":{"status":"matches"}}}},"unselected-suite":{"testcases":{"unselected":{"filter-match":{"status":"mismatch"}}}}}}"#)
            .env("PROTOC", self.0.path().join("bin/protoc"))
            .env("PATH", self.0.path().join("bin"))
            .env("TEST_PLATFORM", "linux_arm64")
            .env_remove("NEMOCLAW_TEST_TOFU")
            .env_remove("NEMOCLAW_TEST_PROVIDER")
            .env_remove("GITHUB_ENV")
            .env_remove("GITHUB_PATH")
            .env_remove("GITHUB_STEP_SUMMARY");
        // A CI run's numbered version needs the checkout's history.
        for name in [
            "GITHUB_REPOSITORY",
            "GITHUB_WORKFLOW_REF",
            "GITHUB_RUN_NUMBER",
            "GITHUB_RUN_ATTEMPT",
        ] {
            command.env_remove(name);
        }
        command
    }

    fn run(&self, args: &[&str]) -> Output {
        self.command(args).output().unwrap()
    }

    fn arguments(&self) -> String {
        fs::read_to_string(self.0.path().join("arguments")).unwrap()
    }

    /// Each cargo call's arguments, in order.
    fn invocations(&self) -> Vec<String> {
        fs::read_to_string(self.0.path().join("invocations"))
            .unwrap_or_default()
            .split("--\n")
            .filter(|call| !call.is_empty())
            .map(str::to_owned)
            .collect()
    }

    /// The test inputs the last test run received: the bundle, OpenTofu, the
    /// provider, and the fixture executables' directory.
    fn inputs(&self) -> Vec<String> {
        fs::read_to_string(self.0.path().join("inputs"))
            .unwrap()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    /// Each `nextest archive` call's archive file and filterset, in order.
    fn archives(&self) -> Vec<(String, String)> {
        let invocations = fs::read_to_string(self.0.path().join("invocations")).unwrap_or_default();
        invocations
            .split("--\n")
            .filter(|call| call.starts_with("nextest\narchive\n"))
            .map(|call| {
                let value = |option: &str| {
                    call.lines()
                        .skip_while(|arg| *arg != option)
                        .nth(1)
                        .unwrap_or_default()
                        .to_owned()
                };
                (value("--archive-file"), value("--filterset"))
            })
            .collect()
    }

    /// Fake `docker` and `zstd` that record their calls in `docker.log` and
    /// what `docker load` reads in `docker.stdin`, for the live image paths.
    fn fake_container_tools(&self) {
        for (name, script) in [
            (
                "docker",
                r#"#!/bin/sh
printf '%s\n' "$*" >> docker.log
if [ -n "$DOCKER_FAIL_IMAGE" ]; then
    case "$1 $2" in
        'buildx bake')
            [ "$3" = "$DOCKER_FAIL_IMAGE" ] && exit 1 ;;
        'buildx build')
            for argument; do
                [ "$argument" = "nc-live-images:$DOCKER_FAIL_IMAGE" ] && exit 1
            done ;;
    esac
fi
case "$1 $2" in
    'info --format') printf '%s\n' '{"Address":"/test/containerd.sock","Namespaces":{"Containers":"test-images"}}' ;;
    'version '*) printf '29.0.0\n' ;;
    'buildx bake')
        if [ "$3" = --print ]; then
            printf '{"target":{"%s":{"tags":["%s:%s"]}}}\n' "$4" "$IMAGE_PREFIX" "$4"
        else
            # A catalog export writes the image's installed catalog.
            for argument; do
                case "$argument" in
                    *.output=type=local,dest=*)
                        if [ "$3" = dummy ]; then
                            printf '{"adapters":[{"descriptor":{"adapter_id":"org.nemoclaw.dummy"}}]}\n'
                        else
                            printf '{"adapters":[]}\n'
                        fi > "${argument#*dest=}/catalog.json" ;;
                esac
            done
        fi ;;
    'run '*) printf '{"protocol":1}\n' ;;
    'image inspect') printf 'sha256:0123456789abcdef\n' ;;
    'image ls') printf 'nc-live-images:unneeded\n' ;;
    'save '*) printf 'saved %s\n' "$*" ;;
    'load '*) while IFS= read -r line; do printf '%s\n' "$line" >> docker.stdin; done ;;
esac
exit 0
"#,
            ),
            (
                "sudo",
                r#"#!/bin/sh
printf '%s\n' "$*" > containerd.log
[ "$1 $2 $3 $4 $5 $6 $7 $8 $9" = '-n ctr --address /test/containerd.sock --namespace test-images images export --all-platforms' ] || exit 1
shift 9
output=$1
shift
printf 'exported %s\n' "$*" > "$output"
"#,
            ),
            (
                "zstd",
                r#"#!/bin/sh
output=
input=
decompress=
previous=
for argument; do
    [ "$previous" = -o ] && output=$argument
    [ "$argument" = -d ] && decompress=1
    input=$argument
    previous=$argument
done
if [ -n "$decompress" ]; then
    while IFS= read -r line; do printf '%s\n' "$line"; done < "$input"
elif [ "$input" != "$output" ]; then
    /bin/cat "$input" > "$output"
else
    while IFS= read -r line; do printf '%s\n' "$line"; done > "$output"
fi
"#,
            ),
        ] {
            let path = self.0.path().join("bin").join(name);
            fs::write(&path, script).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    fn docker_log(&self) -> String {
        fs::read_to_string(self.0.path().join("docker.log")).unwrap_or_default()
    }

    /// Write the bundle manifest and runtime Dockerfile that the Docker live
    /// step reads before it runs any test.
    fn seed_live_inputs(&self) {
        for (path, content) in [
            ("dist/linux_arm64/manifest.json", "{}"),
            ("image/ollama/Dockerfile", "FROM ollama/ollama@sha256:0\n"),
            // The HCL E2E cases the suite binds to its run, with their scenarios.
            (
                "crates/nemoclaw-e2e/cases/docker-dummy.yaml",
                include_str!("../../nemoclaw-e2e/cases/docker-dummy.yaml"),
            ),
            (
                "crates/nemoclaw-e2e/tests/e2e/hcl/tests/docker-dummy.tftest.hcl",
                "\n",
            ),
            (
                "crates/nemoclaw-e2e/cases/docker-openclaw-hermes-interfaces.yaml",
                include_str!("../../nemoclaw-e2e/cases/docker-openclaw-hermes-interfaces.yaml"),
            ),
            (
                "crates/nemoclaw-e2e/tests/e2e/hcl/tests/docker-openclaw-hermes-interfaces.tftest.hcl",
                "\n",
            ),
            // A hosted case, which neither live suite runs.
            (
                "crates/nemoclaw-e2e/cases/docker-openclaw-nvidia.yaml",
                include_str!("../../nemoclaw-e2e/cases/docker-openclaw-nvidia.yaml"),
            ),
            (
                "crates/nemoclaw-e2e/tests/e2e/hcl/tests/docker-openclaw-nvidia.tftest.hcl",
                "\n",
            ),
        ] {
            let file = self.0.path().join(path);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, content).unwrap();
        }
    }

    /// Write the files the build step leaves for `ci archive` to package.
    fn seed_build_outputs(&self) {
        for path in [
            "dist/linux_arm64/bin/nemoclaw",
            "dist/linux_arm64/libexec/tofu",
            ".tools/protoc-36.2/bin/protoc",
            ".tools/nextest-0.9.152/cargo-nextest",
            "target/debug/terraform-provider-openshell",
            "target/debug/terraform-provider-fabric",
            "target/debug/terraform-provider-vllm",
            "target/debug/terraform-provider-ollama",
            "target/debug/terraform-provider-host",
            "target/debug/nemoclaw-fixture-control",
            "target/debug/nemoclaw-fixture-provider",
            "target/debug/nemoclaw-fixture-ssh",
            "target/debug/nemoclaw-fixture-ssh-simulator",
        ] {
            let file = self.0.path().join(path);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(&file, path).unwrap();
            fs::set_permissions(file, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
}

fn suite(id: &str) -> String {
    format!(
        r#"{{"rust-suites":{{"{id}":{{"testcases":{{"case":{{"filter-match":{{"status":"matches"}}}}}}}}}}}}"#
    )
}

#[test]
fn lifecycle_partition_reaches_nextest_without_changing_the_selected_suite() {
    let fixture = Fixture::new();
    let output = fixture.run(&["integration", "--partition", "hash:1/2"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let args = fixture.arguments();
    assert!(args.contains("--partition\nhash:1/2\n"), "{args}");
    assert!(
        args.contains("--profile\nintegration\n--run-ignored\nonly\n"),
        "{args}"
    );
    // The bundle supplies OpenTofu and the providers; each provider's own
    // tests use the one Cargo built.
    let inputs = fixture.inputs();
    assert_eq!(inputs.len(), 4, "{inputs:?}");
    assert!(inputs[0].ends_with("/dist/linux_arm64"), "{inputs:?}");
    assert!(std::path::Path::new(&inputs[0]).is_absolute(), "{inputs:?}");
    assert_eq!(inputs[1..3], ["unset", "unset"]);
}

/// CI runs the unit tests in partitions on separate runners. Each partition
/// gives nextest its slice; the doctests, which nextest doesn't run, run once,
/// with the first partition.
#[test]
fn unit_test_partitions_reach_nextest_and_only_the_first_runs_the_doctests() {
    for (partition, doctests) in [("slice:1/2", true), ("slice:2/2", false)] {
        let fixture = Fixture::new();
        let output = fixture.run(&["test", "--partition", partition]);
        assert!(
            output.status.success(),
            "{partition}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let invocations = fixture.invocations();
        let nextest = invocations
            .iter()
            .find(|call| call.starts_with("nextest\nrun\n"))
            .unwrap_or_else(|| panic!("{partition}: no nextest run in {invocations:?}"));
        assert!(
            nextest.contains(&format!("--partition\n{partition}\n")),
            "{nextest}"
        );
        assert!(nextest.contains("--profile\nci\n"), "{nextest}");
        assert_eq!(
            invocations
                .iter()
                .any(|call| call.starts_with("test\n") && call.contains("--doc\n")),
            doctests,
            "{partition}: {invocations:?}"
        );
    }
}

/// Tests started from another package find the fixture executables in the
/// directory the runner names, where Cargo leaves a build's executables.
#[test]
fn test_steps_build_the_fixture_executables_and_name_their_directory() {
    for step in ["test", "contract", "integration"] {
        let fixture = Fixture::new();
        let output = fixture.run(&[step]);
        assert!(
            output.status.success(),
            "{step}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let invocations = fixture.invocations();
        assert!(
            invocations[0].starts_with("build\n--locked\n--workspace\n--all-targets\n"),
            "{step} must build every executable before its tests: {invocations:?}"
        );
        assert!(
            invocations[1].starts_with("nextest\nrun\n"),
            "{step}: {invocations:?}"
        );
        let fixtures = fixture.inputs()[3].clone();
        assert!(
            std::path::Path::new(&fixtures).is_absolute(),
            "{step}: {fixtures}"
        );
        assert!(fixtures.ends_with("/target/debug"), "{step}: {fixtures}");
    }
}

#[test]
fn archived_lifecycle_uses_the_checkout_without_building_again() {
    let fixture = Fixture::new();
    let output = fixture.run(&[
        "integration",
        "--partition",
        "hash:2/2",
        "--archive-file",
        "tests.tar.zst",
    ]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let args = fixture.arguments();
    assert!(args.contains("--archive-file\ntests.tar.zst\n"), "{args}");
    assert!(fixture.0.path().join(".build/ci/extracted").is_dir());
    let workspace_remap = args
        .lines()
        .skip_while(|arg| *arg != "--workspace-remap")
        .nth(1)
        .expect("--workspace-remap needs a checkout path");
    // macOS temporary paths can use /var while current_dir resolves /private/var.
    assert_eq!(
        fs::canonicalize(workspace_remap).unwrap(),
        fixture.0.path().canonicalize().unwrap(),
        "{args}"
    );
    assert!(
        args.contains("--profile\nintegration\n--run-ignored\nonly\n"),
        "{args}"
    );
    assert!(args.contains("--partition\nhash:2/2\n"), "{args}");
    for build_option in ["--workspace\n", "--all-targets\n", "--locked\n"] {
        assert!(
            !args.contains(build_option),
            "archive execution must not request a build: {args}"
        );
    }
    let invocations = fixture.invocations();
    assert!(
        !invocations.iter().any(|call| call.starts_with("build\n")),
        "{invocations:?}"
    );
    // The lifecycle inputs unpack the fixture executables into the checkout.
    let fixtures = fixture.inputs()[3].clone();
    assert!(std::path::Path::new(&fixtures).is_absolute(), "{fixtures}");
    assert!(fixtures.ends_with("/target/debug"), "{fixtures}");
}

#[test]
fn lifecycle_options_cannot_silently_narrow_default_or_other_ci_steps() {
    let partition = "--partition requires ci test, contract, or integration";
    let archive = "--archive-file requires ci contract, integration, live-docker, or live-kind";
    let images = "--images requires ci live-docker or live-kind";
    for (args, expected) in [
        (vec!["integration", "--images", "images.tar.zst"], images),
        (vec!["--images", "images.tar.zst"], images),
        (vec!["--partition", "hash:1/2"], partition),
        (vec!["live-docker", "--partition", "hash:1/2"], partition),
        (vec!["fmt", "--archive-file", "tests.tar.zst"], archive),
        (vec!["--archive-file", "tests.tar.zst"], archive),
    ] {
        let fixture = Fixture::new();
        let output = fixture.run(&args);
        assert!(!output.status.success());
        let error = String::from_utf8_lossy(&output.stderr);
        assert!(error.contains(expected), "{error}");
        assert!(!fixture.0.path().join("arguments").exists());
        assert!(!fixture.0.path().join(".build").exists());
    }
}

#[test]
fn archive_packages_tools_and_fixture_executables_but_leaves_providers_to_the_bundle_and_nextest() {
    let fixture = Fixture::new();
    fixture.seed_build_outputs();
    // Tool discovery uses the fixture's explicit PROTOC and cargo commands.
    let output = fixture.run(&["archive"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let args = fixture.arguments();
    assert!(
        args.starts_with("nextest\narchive\n--locked\n--workspace\n--all-targets\n"),
        "{args}"
    );
    assert!(
        args.contains("--filterset\nbinary_id(=selected-suite)\n"),
        "{args}"
    );
    let packed = fs::File::open(fixture.0.path().join(".build/ci/lifecycle-inputs.tar")).unwrap();
    let unpacked = tempfile::tempdir().unwrap();
    tar::Archive::new(packed).unpack(unpacked.path()).unwrap();
    // The bundle job uploads dist/PLATFORM separately, in parallel with this build.
    assert!(!unpacked.path().join("dist").exists());
    // Nextest archives each provider package's executables with its tests.
    for name in ["nemoclaw", "openshell", "fabric"] {
        let path = format!("target/debug/terraform-provider-{name}");
        assert!(!unpacked.path().join(&path).exists(), "{path}");
    }
    for path in [
        ".tools/nextest-0.9.152/cargo-nextest",
        "target/debug/nemoclaw-fixture-control",
        "target/debug/nemoclaw-fixture-provider",
        "target/debug/nemoclaw-fixture-ssh",
        "target/debug/nemoclaw-fixture-ssh-simulator",
    ] {
        let file = unpacked.path().join(path);
        assert_eq!(fs::read_to_string(&file).unwrap(), path);
        assert_ne!(fs::metadata(file).unwrap().permissions().mode() & 0o111, 0);
    }
    assert_eq!(
        fs::read(unpacked.path().join(".build/ci/nemoclaw-build")).unwrap(),
        fs::read(env!("CARGO_BIN_EXE_nemoclaw-build")).unwrap()
    );
}

/// Run `ci archive` with a distinct test binary selected by each profile.
fn archive_layers(fixture: &Fixture, platform: &str) -> Output {
    fixture.seed_build_outputs();
    // Cargo's build directory, whose layout the runner must not assume.
    let e2e = fixture
        .0
        .path()
        .join("build-dir/nemoclaw-e2e/0123/out/e2e-0123");
    fs::create_dir_all(e2e.parent().unwrap()).unwrap();
    fs::write(&e2e, "e2e test executable").unwrap();
    let kind = serde_json::json!({"rust-suites": {"nemoclaw-e2e::e2e": {
        "binary-path": e2e,
        "testcases": {"case": {"filter-match": {"status": "matches"}}},
    }}});
    fixture
        .command(&["archive"])
        .env("TEST_PLATFORM", platform)
        .env("CARGO_LIST_CONTRACT", suite("contract-suite"))
        .env("CARGO_LIST_INTEGRATION", suite("integration-suite"))
        .env("CARGO_LIST_LIVE_DOCKER", suite("docker-suite"))
        .env("CARGO_LIST_LIVE_KIND", kind.to_string())
        .output()
        .unwrap()
}

/// Each test job downloads only the executables its layer runs, so each layer
/// gets its own archive; Linux also archives the live suites, so live jobs
/// need not compile.
#[test]
fn linux_archives_each_test_layer_separately_so_each_job_downloads_only_its_tests() {
    let fixture = Fixture::new();
    let output = archive_layers(&fixture, "linux_arm64");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fixture.archives(),
        [
            (
                ".build/ci/contract.tar.zst".to_owned(),
                "binary_id(=contract-suite)".to_owned()
            ),
            (
                ".build/ci/integration.tar.zst".to_owned(),
                "binary_id(=integration-suite)".to_owned()
            ),
            (
                ".build/ci/live.tar.zst".to_owned(),
                "binary_id(=docker-suite) | binary_id(=nemoclaw-e2e::e2e)".to_owned()
            ),
        ]
    );
}

/// The hosted and GPU HCL case jobs run the e2e test executable alone, so the
/// archive step copies out the one nextest lists, wherever Cargo built it.
#[test]
fn linux_archive_copies_out_the_e2e_executable_that_hcl_case_jobs_run() {
    let fixture = Fixture::new();
    let output = archive_layers(&fixture, "linux_arm64");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let e2e = fixture.0.path().join(".build/ci/e2e");
    assert_eq!(fs::read_to_string(&e2e).unwrap(), "e2e test executable");
}

#[test]
fn other_platforms_archive_no_live_suites_because_live_suites_need_linux() {
    let fixture = Fixture::new();
    let output = archive_layers(&fixture, "darwin_arm64");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let archives: Vec<_> = fixture
        .archives()
        .into_iter()
        .map(|(file, _)| file)
        .collect();
    assert_eq!(
        archives,
        [
            ".build/ci/contract.tar.zst",
            ".build/ci/integration.tar.zst"
        ]
    );
}

#[test]
fn live_suites_accept_an_archive_of_their_tests() {
    let fixture = Fixture::new();
    let output = fixture.run(&["live-docker", "--archive-file", "tests.tar.zst"]);
    assert!(!output.status.success());
    // It gets past option validation and stops at the missing bundle.
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(error.contains("build the bundle first"), "{error}");
}

#[test]
fn live_images_builds_the_agent_and_dummy_images_once_and_saves_them_compressed() {
    let fixture = Fixture::new();
    fixture.fake_container_tools();
    fixture.seed_image_sources();
    let output = fixture.run(&["live-images"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let log = fixture.docker_log();
    // ARM64 builds OpenClaw, Hermes and the reference dummy, under the shared
    // prefix the live steps load: each exports its catalog, then builds its
    // labeled stage.
    for name in ["openclaw", "hermes", "dummy"] {
        assert!(
            log.contains(&format!("buildx bake {name} --set {name}.target=catalog")),
            "{log}"
        );
        assert!(
            log.contains(&format!(
                "buildx bake {name} --load --set {name}.target=labeled --set {name}.args.CATALOG="
            )),
            "{log}"
        );
    }
    assert!(!log.contains("buildx build"), "{log}");
    assert!(!log.lines().any(|line| line.starts_with("save ")), "{log}");
    let archive =
        fs::read_to_string(fixture.0.path().join(".build/ci/live-images.tar.zst")).unwrap();
    assert!(
        archive.trim()
            == "exported docker.io/library/nc-live-images:openclaw docker.io/library/nc-live-images:hermes docker.io/library/nc-live-images:dummy",
        "{archive}"
    );
}

/// The GPU HCL cases that run only OpenClaw download a smaller archive.
#[test]
fn live_images_also_save_the_agent_image_alone() {
    let fixture = Fixture::new();
    fixture.fake_container_tools();
    fixture.seed_image_sources();
    let output = fixture.run(&["live-images"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let archive = fs::read_to_string(
        fixture
            .0
            .path()
            .join(".build/ci/live-images-openclaw.tar.zst"),
    )
    .unwrap();
    assert_eq!(
        archive.trim(),
        "exported docker.io/library/nc-live-images:openclaw"
    );
}

/// Builds the live images with `NEMOCLAW_SAVE_GHA_CACHE` set to `save`, or
/// unset, and checks that every build imports the cached layers and that the
/// second build saves them only when CI asks.
fn assert_live_images_cache(save: Option<&str>) {
    let fixture = Fixture::new();
    fixture.fake_container_tools();
    fixture.seed_image_sources();
    let mut command = fixture.command(&["live-images"]);
    command.env_remove("NEMOCLAW_SAVE_GHA_CACHE");
    if let Some(save) = save {
        command.env("NEMOCLAW_SAVE_GHA_CACHE", save);
    }
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let log = fixture.docker_log();
    for name in ["openclaw", "hermes", "dummy"] {
        let builds: Vec<&str> = log
            .lines()
            .filter(|line| line.starts_with(&format!("buildx bake {name} ")))
            .collect();
        assert_eq!(builds.len(), 2, "{log}");
        let scope = format!("type=gha,scope=live-images-{name}-arm64");
        for build in &builds {
            assert!(
                build.contains(&format!("{name}.cache-from={scope}")),
                "{build}"
            );
        }
        assert_eq!(
            builds[1].contains(&format!("{name}.cache-to={scope},")),
            save == Some("true"),
            "NEMOCLAW_SAVE_GHA_CACHE={save:?}: {}",
            builds[1]
        );
    }
}

// CI saves the live images' layers on v1 only; every build imports them. One
// test per setting keeps each within the unit test budget.
#[test]
fn live_images_import_cached_layers_without_saving_them_by_default() {
    assert_live_images_cache(None);
}

#[test]
fn live_images_import_cached_layers_without_saving_them_when_ci_declines() {
    assert_live_images_cache(Some("false"));
}

#[test]
fn live_images_import_cached_layers_and_save_them_when_ci_asks() {
    assert_live_images_cache(Some("true"));
}

#[test]
fn live_images_report_each_build_duration() {
    let fixture = Fixture::new();
    fixture.fake_container_tools();
    fixture.seed_image_sources();
    let output = fixture.run(&["live-images"]);
    let report = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "{report}");
    for image in ["openclaw", "hermes", "dummy"] {
        let tag = format!("nc-live-images:{image}");
        let start = report
            .find(&format!("Building live image {tag}\n"))
            .unwrap_or_else(|| panic!("missing build start for {tag}: {report}"));
        let completion = format!("Built live image {tag} in ");
        let end = report
            .find(&completion)
            .unwrap_or_else(|| panic!("missing build duration for {tag}: {report}"));
        assert!(start < end, "{report}");
        let seconds: f64 = report[end + completion.len()..]
            .lines()
            .next()
            .unwrap()
            .strip_suffix('s')
            .unwrap()
            .parse()
            .unwrap();
        assert!(seconds.is_finite() && seconds >= 0.0, "{report}");
    }
}

const LIVE_IMAGES: [&str; 3] = ["openclaw", "hermes", "dummy"];

/// Fails the build of `LIVE_IMAGES[index]` and checks that the report gives
/// its duration and that no later image starts.
fn assert_failed_live_image_build_stops(index: usize) {
    let image = LIVE_IMAGES[index];
    let fixture = Fixture::new();
    fixture.fake_container_tools();
    fixture.seed_image_sources();
    let output = fixture
        .command(&["live-images"])
        .env("DOCKER_FAIL_IMAGE", image)
        .output()
        .unwrap();
    let report = String::from_utf8_lossy(&output.stderr);
    assert!(!output.status.success(), "{report}");
    let failure = format!("Failed to build live image nc-live-images:{image} after ");
    let duration = report
        .lines()
        .find_map(|line| line.strip_prefix(&failure))
        .unwrap_or_else(|| panic!("missing failed duration: {report}"));
    let seconds: f64 = duration.strip_suffix('s').unwrap().parse().unwrap();
    assert!(seconds.is_finite() && seconds >= 0.0, "{report}");
    assert!(
        !report.contains(&format!("Built live image nc-live-images:{image} in ")),
        "{report}"
    );
    for later in &LIVE_IMAGES[index + 1..] {
        assert!(
            !report.contains(&format!("Building live image nc-live-images:{later}")),
            "{report}"
        );
    }
    assert!(!fixture.0.path().join("containerd.log").exists());
}

#[test]
fn live_images_report_a_failed_first_build_and_stop() {
    assert_failed_live_image_build_stops(0);
}

#[test]
fn live_images_report_a_failed_middle_build_and_stop() {
    assert_failed_live_image_build_stops(1);
}

#[test]
fn live_images_report_a_failed_last_build() {
    assert_failed_live_image_build_stops(2);
}

#[test]
fn live_images_are_built_on_linux_only() {
    let fixture = Fixture::new();
    fixture.fake_container_tools();
    let output = fixture
        .command(&["live-images"])
        .env("TEST_PLATFORM", "darwin_arm64")
        .output()
        .unwrap();
    assert!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(
        error.contains("the live images are built on Linux only"),
        "{error}"
    );
    assert!(fixture.docker_log().is_empty());
}

#[test]
fn live_docker_loads_prebuilt_images_under_its_own_names_instead_of_building() {
    let fixture = Fixture::new();
    fixture.fake_container_tools();
    fixture.seed_live_inputs();
    fs::write(fixture.0.path().join("images.tar.zst"), "prebuilt images\n").unwrap();
    let output = fixture.run(&["live-docker", "--images", "images.tar.zst"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let log = fixture.docker_log();
    // The only build is the derived reference image: one layer on the loaded
    // reference image, not an agent build.
    let builds: Vec<_> = log.lines().filter(|line| line.contains("buildx")).collect();
    assert!(
        builds.len() == 1
            && builds[0].starts_with("buildx build --builder default")
            && builds[0].contains(":dummy-derived"),
        "{log}"
    );
    let loaded = fs::read_to_string(fixture.0.path().join("docker.stdin")).unwrap();
    assert_eq!(loaded, "prebuilt images\n");
    for image in ["openclaw", "hermes", "dummy"] {
        assert!(
            log.lines().any(|line| line
                .strip_prefix(&format!("tag nc-live-images:{image} nc-live-"))
                .is_some_and(|rest| rest.ends_with(&format!(":{image}")))),
            "{log}"
        );
    }
    // Only the archive's own names are removed; a shared name another
    // worktree's build holds stays.
    assert!(
        !log.lines()
            .any(|line| line == "image rm nc-live-images:unneeded"),
        "{log}"
    );
}

#[test]
fn bundle_builds_its_build_tool_so_it_can_run_without_the_build_step() {
    let fixture = Fixture::new();
    assert!(
        !fixture
            .0
            .path()
            .join("target/debug/nemoclaw-build")
            .exists()
    );
    let output = fixture.run(&["bundle"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let args = fixture.arguments();
    assert!(
        args.starts_with("build\n--locked\n--package\nnemoclaw-build\n"),
        "{args}"
    );
    assert!(!args.contains("--no-default-features"), "{args}");
    let bundled = fs::read_to_string(fixture.0.path().join("bundled")).unwrap();
    assert_eq!(bundled, "bundle\n--platform\nlinux_arm64\n");
}

/// A part of a split bundle resolves features for every bundle package, as the
/// whole bundle build does, so all parts share its cached dependencies.
#[test]
fn bundle_executables_compile_only_those_with_the_whole_bundles_features() {
    let fixture = Fixture::new();
    // A part names the bundle's version, which hashes the source inputs.
    for root in nemoclaw_build::SOURCE_ROOTS {
        let path = fixture.0.path().join(root);
        if !path.exists() {
            fs::create_dir_all(path).unwrap();
        }
    }
    let output = fixture.run(&[
        "bundle",
        "--executables",
        "terraform-provider-vllm,terraform-provider-fabric",
    ]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        fixture.invocations(),
        [concat!(
            "build\n--locked\n--release\n--target\naarch64-unknown-linux-gnu\n--timings\n",
            "-p\nnemoclaw-cli\n-p\nnemoclaw-provider\n-p\nopenshell-provider\n-p\nfabric-provider\n",
            "--bin\nterraform-provider-vllm\n--bin\nterraform-provider-fabric\n",
        )]
    );
    assert!(!fixture.0.path().join("bundled").exists());
    let version = fs::read_to_string(fixture.0.path().join("bundle-version-env")).unwrap();
    assert!(
        version.starts_with("0.1.0-dev."),
        "a local part names the sources' version: {version}"
    );
    assert_eq!(
        fs::read_to_string(fixture.0.path().join("target/bundle-version")).unwrap(),
        version.trim_end(),
        "the part records the version it compiled for the assembly"
    );
}

#[test]
fn bundle_executables_name_bundle_executables_for_the_bundle_step_only() {
    let step = "--executables requires ci bundle";
    let executable = "--executables takes only the bundle's executables";
    for (args, expected) in [
        (vec!["build", "--executables", "nemoclaw"], step),
        (vec!["--executables", "nemoclaw"], step),
        (
            vec!["bundle", "--executables", "nemoclaw-build"],
            executable,
        ),
        (vec!["bundle", "--executables", ""], executable),
    ] {
        let fixture = Fixture::new();
        let output = fixture.run(&args);
        assert!(!output.status.success(), "{args:?}");
        let error = String::from_utf8_lossy(&output.stderr);
        assert!(error.contains(expected), "{args:?}: {error}");
        assert!(fixture.invocations().is_empty(), "{args:?}");
    }
}

#[test]
fn archive_rejects_a_layer_that_selects_no_tests_instead_of_publishing_none() {
    let fixture = Fixture::new();
    let output = fixture
        .command(&["archive"])
        .env("CARGO_LIST_INTEGRATION", r#"{"rust-suites":{}}"#)
        .output()
        .unwrap();
    assert!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(
        error.contains("no integration test binaries were selected"),
        "{error}"
    );
    assert!(
        !fixture
            .0
            .path()
            .join(".build/ci/lifecycle-inputs.tar")
            .exists()
    );
}

#[test]
fn a_failed_lifecycle_partition_fails_ci() {
    let fixture = Fixture::new();
    let output = fixture
        .command(&["integration", "--partition", "hash:1/2"])
        .env("CARGO_RESULT", "42")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("CI step integration failed"));
}

/// Nothing in CI reads debug information, and it is most of each test
/// archive, so CI builds and archives the workspace without it. Local runs keep
/// the developer's setting, and a setting the caller passes wins.
#[test]
fn ci_builds_without_debug_information_unless_the_caller_sets_it() {
    for (ci, explicit, expected) in [
        (true, None, "0"),
        (false, None, "unset"),
        (true, Some("1"), "1"),
    ] {
        for step in ["build", "archive"] {
            let fixture = Fixture::new();
            fixture.seed_build_outputs();
            let mut command = fixture.command(&[step]);
            command.env_remove("CI").env_remove("GITHUB_ACTIONS");
            if ci {
                command.env("CI", "true");
            }
            match explicit {
                Some(value) => command.env("CARGO_PROFILE_DEV_DEBUG", value),
                None => command.env_remove("CARGO_PROFILE_DEV_DEBUG"),
            };
            let output = command.output().unwrap();
            assert!(
                output.status.success(),
                "{step}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let seen = fs::read_to_string(fixture.0.path().join("profile-debug-env")).unwrap();
            assert_eq!(
                seen.trim(),
                expected,
                "{step} with CI={ci} and {explicit:?}"
            );
        }
    }
}

#[test]
fn local_lifecycle_uses_available_cpus_up_to_eight_workers() {
    let available = std::thread::available_parallelism().map_or(4, usize::from);
    for args in [
        vec!["integration"],
        vec!["integration", "--archive-file", "tests.tar.zst"],
    ] {
        let fixture = Fixture::new();
        let output = fixture
            .command(&args)
            .env_remove("CI")
            .env_remove("GITHUB_ACTIONS")
            .env_remove("NEXTEST_TEST_THREADS")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let arguments = fixture.arguments();
        let workers: usize = arguments
            .lines()
            .skip_while(|arg| *arg != "--test-threads")
            .nth(1)
            .expect("local lifecycle execution must choose its worker count")
            .parse()
            .unwrap();
        match available {
            0..=4 => assert_eq!(workers, 4, "keep the existing floor on small hosts"),
            5..=7 => assert_eq!(workers, available, "use the available CPUs"),
            _ => assert_eq!(workers, 8, "cap concurrency at the measured setting"),
        }
    }
}

#[test]
fn lifecycle_preserves_ci_profiles_and_explicit_worker_overrides() {
    for (ci, github, override_value) in [
        (Some("true"), None, None),
        (None, Some("true"), None),
        (None, None, Some("2")),
        (None, None, Some("num-cpus")),
        (Some("true"), None, Some("2")),
    ] {
        let fixture = Fixture::new();
        let mut command = fixture.command(&["integration"]);
        for (name, value) in [
            ("CI", ci),
            ("GITHUB_ACTIONS", github),
            ("NEXTEST_TEST_THREADS", override_value),
        ] {
            command.env_remove(name);
            if let Some(value) = value {
                command.env(name, value);
            }
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let arguments = fixture.arguments();
        assert!(!arguments.contains("--test-threads"), "{arguments}");
        let inherited = fs::read_to_string(fixture.0.path().join("test-threads-env")).unwrap();
        assert_eq!(inherited.trim(), override_value.unwrap_or("unset"));
    }
}

#[test]
fn live_docker_pulls_a_v1_commits_images_instead_of_building() {
    let fixture = Fixture::new();
    fixture.fake_container_tools();
    fixture.seed_live_inputs();
    let commit = "0123456789abcdef0123456789abcdef01234567";
    let output = fixture.run(&["live-docker", "--images-commit", commit]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let log = fixture.docker_log();
    let package = "ghcr.io/nvidia/nemoclaw/v1-ci";
    for image in ["openclaw", "hermes", "dummy"] {
        let pulled = format!("pull --quiet {package}:{image}-{commit}-");
        assert!(
            log.lines().any(|line| line.starts_with(&pulled)),
            "{image} not pulled: {log}"
        );
    }
    for image in ["openclaw", "hermes", "dummy"] {
        assert!(
            log.lines().any(
                |line| line.starts_with(&format!("tag {package}:{image}-{commit}-"))
                    && line.ends_with(&format!(":{image}"))
                    && line.contains(" nc-live-")
            ),
            "{image} not named for this run: {log}"
        );
    }
    // No agent builds and no archive: only the derived reference image, one
    // layer on the pulled one.
    assert!(
        !log.contains("buildx bake") && !log.lines().any(|line| line.starts_with("load")),
        "{log}"
    );
    let builds: Vec<_> = log
        .lines()
        .filter(|line| line.contains("buildx build"))
        .collect();
    assert_eq!(builds.len(), 1, "{log}");
    assert!(
        builds[0].starts_with("buildx build --builder default")
            && builds[0].contains(":dummy-derived "),
        "dummy-derived not derived: {log}"
    );
}

#[test]
fn live_images_commit_is_a_full_commit_for_the_live_steps_only() {
    let fixture = Fixture::new();
    let commit = "0123456789abcdef0123456789abcdef01234567";
    for (args, message) in [
        (
            vec!["integration", "--images-commit", commit],
            "--images-commit requires ci live-docker or live-kind",
        ),
        (
            vec!["live-kind", "--images-commit", "main"],
            "--images-commit must be a full lowercase commit hash",
        ),
        (
            vec![
                "live-docker",
                "--images-commit",
                commit,
                "--images",
                "images.tar.zst",
            ],
            "--images and --images-commit are alternatives",
        ),
    ] {
        let output = fixture.run(&args);
        assert!(!output.status.success(), "{args:?}");
        let error = String::from_utf8_lossy(&output.stderr);
        assert!(error.contains(message), "{args:?}: {error}");
    }
}

impl Fixture {
    /// The HCL cases that live-suite commands ran, in order.
    fn hcl_cases(&self) -> Vec<String> {
        fs::read_to_string(self.0.path().join("hcl-cases"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }
}

#[test]
fn live_docker_runs_every_docker_case_or_only_the_requested_ones() {
    for (requested, expected) in [
        (
            None,
            &["docker-dummy", "docker-openclaw-hermes-interfaces"][..],
        ),
        (
            Some("docker-openclaw-hermes-interfaces"),
            &["docker-openclaw-hermes-interfaces"],
        ),
        (Some(""), &[]),
    ] {
        let fixture = Fixture::new();
        fixture.fake_container_tools();
        fixture.seed_live_inputs();
        fs::write(fixture.0.path().join("images.tar.zst"), "prebuilt images\n").unwrap();
        let mut args = vec!["live-docker", "--images", "images.tar.zst"];
        if let Some(requested) = requested {
            args.extend(["--hcl-cases", requested]);
        }
        let output = fixture.run(&args);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(fixture.hcl_cases(), expected, "{requested:?}");
    }
}

#[test]
fn live_docker_refuses_a_case_that_runs_elsewhere_before_starting() {
    let fixture = Fixture::new();
    fixture.fake_container_tools();
    fixture.seed_live_inputs();
    let output = fixture.run(&["live-docker", "--hcl-cases", "docker-openclaw-nvidia"]);
    assert!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(error.contains("docker-openclaw-nvidia"), "{error}");
    assert!(fixture.docker_log().is_empty(), "{}", fixture.docker_log());
}

#[test]
fn live_kind_without_requested_cases_starts_no_cluster() {
    let fixture = Fixture::new();
    fixture.fake_container_tools();
    fixture.seed_live_inputs();
    let output = fixture.run(&["live-kind", "--hcl-cases", ""]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(fixture.docker_log().is_empty(), "{}", fixture.docker_log());
    assert!(fixture.hcl_cases().is_empty());
}

#[test]
fn only_the_live_suites_take_hcl_cases() {
    let output = Fixture::new().run(&["contract", "--hcl-cases", "docker-dummy"]);
    assert!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(error.contains("--hcl-cases"), "{error}");
}
