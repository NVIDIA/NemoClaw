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
    printf 'cargo-nextest 0.9.150\n'
    exit 0
fi
printf '%s\n' "$@" > arguments
printf '%s\n' "${NEXTEST_TEST_THREADS-unset}" > test-threads-env
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
        live-docker) printf '%s\n' "${CARGO_LIST_LIVE_DOCKER:-$CARGO_LIST}" ;;
        live-kind) printf '%s\n' "${CARGO_LIST_LIVE_KIND:-$CARGO_LIST}" ;;
        *) printf '%s\n' "$CARGO_LIST" ;;
    esac
    exit "${CARGO_RESULT:-0}"
fi
printf '%s\n' "$NEMOCLAW_TEST_BUNDLE" "${NEMOCLAW_TEST_TOFU-unset}" "${NEMOCLAW_TEST_PROVIDER-unset}" > inputs
exit "${CARGO_RESULT:-0}"
"#,
            ),
        ] {
            let path = bin.join(name);
            fs::write(&path, script).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        fs::write(
            root.path().join("versions.json"),
            include_bytes!("../../../versions.json"),
        )
        .unwrap();
        Self(root)
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
        command
    }

    fn run(&self, args: &[&str]) -> Output {
        self.command(args).output().unwrap()
    }

    fn arguments(&self) -> String {
        fs::read_to_string(self.0.path().join("arguments")).unwrap()
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
            [ "$3" = "$DOCKER_FAIL_IMAGE" ] && exit 1
            for argument; do
                [ "$argument" = "ollama-proxy.tags=nc-live-images:$DOCKER_FAIL_IMAGE" ] && exit 1
            done ;;
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
            ".tools/nextest-0.9.150/cargo-nextest",
            "target/debug/terraform-provider-openshell",
            "target/debug/terraform-provider-fabric",
            "target/debug/terraform-provider-vllm",
            "target/debug/terraform-provider-ollama",
            "target/debug/terraform-provider-host",
            "target/debug/nemoclaw-fixture-ssh",
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
    let output = fixture.run(&["lifecycle", "--partition", "hash:1/2"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let args = fixture.arguments();
    assert!(args.contains("--partition\nhash:1/2\n"), "{args}");
    assert!(
        args.contains("--profile\nlifecycle\n--run-ignored\nonly\n"),
        "{args}"
    );
    // The bundle supplies OpenTofu and the providers; each provider's own
    // tests use the one Cargo built.
    let inputs = fs::read_to_string(fixture.0.path().join("inputs")).unwrap();
    let inputs: Vec<_> = inputs.lines().collect();
    assert_eq!(inputs.len(), 3, "{inputs:?}");
    assert!(inputs[0].ends_with("/dist/linux_arm64"), "{inputs:?}");
    assert!(std::path::Path::new(inputs[0]).is_absolute(), "{inputs:?}");
    assert_eq!(inputs[1..], ["unset", "unset"]);
}

#[test]
fn archived_lifecycle_uses_the_checkout_without_building_again() {
    let fixture = Fixture::new();
    let output = fixture.run(&[
        "lifecycle",
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
        args.contains("--profile\nlifecycle\n--run-ignored\nonly\n"),
        "{args}"
    );
    assert!(args.contains("--partition\nhash:2/2\n"), "{args}");
    for build_option in ["--workspace\n", "--all-targets\n", "--locked\n"] {
        assert!(
            !args.contains(build_option),
            "archive execution must not request a build: {args}"
        );
    }
}

#[test]
fn lifecycle_options_cannot_silently_narrow_default_or_other_ci_steps() {
    let partition = "--partition requires ci lifecycle";
    let archive = "--archive-file requires ci lifecycle, live-docker, or live-kind";
    let images = "--images requires ci live-docker or live-kind";
    for (args, expected) in [
        (vec!["lifecycle", "--images", "images.tar.zst"], images),
        (vec!["--images", "images.tar.zst"], images),
        (vec!["--partition", "hash:1/2"], partition),
        (vec!["test", "--partition", "hash:1/2"], partition),
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
fn archive_packages_tools_and_the_ssh_relay_but_leaves_providers_to_the_bundle_and_nextest() {
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
        ".tools/nextest-0.9.150/cargo-nextest",
        "target/debug/nemoclaw-fixture-ssh",
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

#[test]
fn linux_archives_also_hold_the_live_suites_so_live_jobs_need_not_compile() {
    let fixture = Fixture::new();
    fixture.seed_build_outputs();
    let output = fixture
        .command(&["archive"])
        .env("CARGO_LIST_LIVE_DOCKER", suite("docker-suite"))
        .env("CARGO_LIST_LIVE_KIND", suite("kind-suite"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let args = fixture.arguments();
    assert!(
        args.contains(
            "--filterset\nbinary_id(=docker-suite) | binary_id(=kind-suite) | binary_id(=selected-suite)\n"
        ),
        "{args}"
    );
}

#[test]
fn other_platforms_archive_only_the_lifecycle_suite_because_live_suites_need_linux() {
    let fixture = Fixture::new();
    fixture.seed_build_outputs();
    let output = fixture
        .command(&["archive"])
        .env("TEST_PLATFORM", "darwin_arm64")
        .env("CARGO_LIST_LIVE_DOCKER", suite("docker-suite"))
        .env("CARGO_LIST_LIVE_KIND", suite("kind-suite"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let args = fixture.arguments();
    assert!(
        args.contains("--filterset\nbinary_id(=selected-suite)\n"),
        "{args}"
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
fn live_images_builds_the_agent_hermes_dummy_and_proxy_images_once_and_saves_them_compressed() {
    let fixture = Fixture::new();
    fixture.fake_container_tools();
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
    // Both proxies build from the Bake target, differing only in a label.
    for variant in ["a", "b"] {
        assert!(
            log.lines()
                .any(|line| line.starts_with("buildx bake ollama-proxy --load")
                    && line.contains(&format!("ollama-proxy.tags=nc-live-images:proxy-{variant}"))
                    && line.contains(&format!(
                        "ollama-proxy.labels.org.nemoclaw.test=proxy-{variant}"
                    ))),
            "{log}"
        );
    }
    assert!(!log.contains("buildx build"), "{log}");
    assert!(!log.lines().any(|line| line.starts_with("save ")), "{log}");
    let archive =
        fs::read_to_string(fixture.0.path().join(".build/ci/live-images.tar.zst")).unwrap();
    assert!(
        archive.trim()
            == "exported docker.io/library/nc-live-images:openclaw docker.io/library/nc-live-images:hermes docker.io/library/nc-live-images:dummy docker.io/library/nc-live-images:proxy-a docker.io/library/nc-live-images:proxy-b",
        "{archive}"
    );
}

#[test]
fn live_images_report_each_build_duration() {
    let fixture = Fixture::new();
    fixture.fake_container_tools();
    let output = fixture.run(&["live-images"]);
    let report = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "{report}");
    for image in ["openclaw", "dummy", "proxy-a", "proxy-b"] {
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

#[test]
fn live_images_report_failed_build_duration_and_stop() {
    let images = ["openclaw", "dummy", "proxy-a", "proxy-b"];
    for (index, image) in images.iter().enumerate() {
        let fixture = Fixture::new();
        fixture.fake_container_tools();
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
        for later in &images[index + 1..] {
            assert!(
                !report.contains(&format!("Building live image nc-live-images:{later}")),
                "{report}"
            );
        }
        assert!(!fixture.0.path().join("containerd.log").exists());
    }
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
    for image in ["openclaw", "dummy", "proxy-a", "proxy-b"] {
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

#[test]
fn archive_rejects_an_empty_lifecycle_selection_instead_of_publishing_no_tests() {
    let fixture = Fixture::new();
    let output = fixture
        .command(&["archive"])
        .env("CARGO_LIST", r#"{"rust-suites":{}}"#)
        .output()
        .unwrap();
    assert!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(
        error.contains("no lifecycle test binaries were selected"),
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
        .command(&["lifecycle", "--partition", "hash:1/2"])
        .env("CARGO_RESULT", "42")
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("CI step lifecycle failed"));
}

#[test]
fn local_lifecycle_uses_available_cpus_up_to_eight_workers() {
    let available = std::thread::available_parallelism().map_or(4, usize::from);
    for args in [
        vec!["lifecycle"],
        vec!["lifecycle", "--archive-file", "tests.tar.zst"],
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
        let mut command = fixture.command(&["lifecycle"]);
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
fn live_docker_pulls_a_v1_commits_images_and_derives_the_proxy_pair_instead_of_building() {
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
    for image in ["openclaw", "dummy", "ollama-proxy"] {
        let pulled = format!("pull --quiet {package}:{image}-{commit}-");
        assert!(
            log.lines().any(|line| line.starts_with(&pulled)),
            "{image} not pulled: {log}"
        );
    }
    for image in ["openclaw", "dummy"] {
        assert!(
            log.lines().any(
                |line| line.starts_with(&format!("tag {package}:{image}-{commit}-"))
                    && line.ends_with(&format!(":{image}"))
                    && line.contains(" nc-live-")
            ),
            "{image} not named for this run: {log}"
        );
    }
    // No agent or proxy builds and no archive: only one-layer images on the
    // pulled ones, the proxy pair and the derived reference image.
    assert!(
        !log.contains("buildx bake") && !log.lines().any(|line| line.starts_with("load")),
        "{log}"
    );
    let builds: Vec<_> = log
        .lines()
        .filter(|line| line.contains("buildx build"))
        .collect();
    assert_eq!(builds.len(), 3, "{log}");
    for image in ["proxy-a", "proxy-b", "dummy-derived"] {
        assert!(
            builds
                .iter()
                .any(|line| line.starts_with("buildx build --builder default")
                    && line.contains(&format!(":{image} "))),
            "{image} not derived: {log}"
        );
    }
}

#[test]
fn live_images_commit_is_a_full_commit_for_the_live_steps_only() {
    let fixture = Fixture::new();
    let commit = "0123456789abcdef0123456789abcdef01234567";
    for (args, message) in [
        (
            vec!["lifecycle", "--images-commit", commit],
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
