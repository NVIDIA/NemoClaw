// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Build the macOS installer for a darwin_arm64 CLI bundle. Compile with
//! rustc; no crates. Staging runs anywhere; packaging needs macOS's pkgbuild,
//! productbuild, and tiffutil. See tools/release/macos-installer/README.md.
//!
//! Usage: macos-installer build BUNDLE VERSION DOCS_REF OUTPUT
//!
//! The package installs BUNDLE unchanged as /usr/local/nemoclaw. The CLI finds
//! its bundle from its own path (crates/nemoclaw-cli/src/deployment.rs), and
//! macOS reports a program started through a symbolic link by the link's
//! path, so nothing links to the CLI: /etc/paths.d puts the bundle's bin
//! directory on PATH for login shells instead. A preinstall script removes the
//! previous bundle, so an upgrade leaves exactly the new one.
use std::{env, fs, os::unix::fs::PermissionsExt, path::Path, process::Command};

type Result<T> = std::result::Result<T, String>;

/// The package's receipt identifier, which upgrades and uninstalls name.
const IDENTIFIER: &str = "com.nvidia.nemoclaw.cli";
const PRODUCT: &str = "com.nvidia.nemoclaw";
const TITLE: &str = "NemoClaw Agent Configs";
const INSTALL_DIR: &str = "/usr/local/nemoclaw";
/// /etc links to /private/etc, so the payload names the directory itself:
/// Installer never has to resolve, or replace, the link.
const PATHS_FILE: &str = "/private/etc/paths.d/nemoclaw";
/// CI builds and tests the darwin_arm64 bundle only on macOS 15.
const MINIMUM_MACOS: &str = "15.0";
const INTEL_TITLE: &str = "NemoClaw Agent Configs requires a Mac with Apple silicon.";
const INTEL_MESSAGE: &str =
    "This Mac has an Intel processor. NemoClaw Agent Configs runs only on Macs with Apple silicon.";
const MACOS_TITLE: &str = "NemoClaw Agent Configs requires macOS 15 or later.";
const MACOS_MESSAGE: &str = "Update macOS in System Settings, then open this installer again.";
/// Installer runs this as root before it writes the payload. $3 is the
/// target volume's mount point.
const PREINSTALL: &str = "#!/bin/sh\n\
# Remove the installed bundle, so an upgrade leaves exactly the new one.\n\
set -eu\n\
rm -rf \"${3%/}/usr/local/nemoclaw\"\n";
const STYLE: &str = include_str!("macos-installer/style.css");
const PAGES: [(&str, &str); 2] = [
    ("welcome.html", include_str!("macos-installer/welcome.html")),
    (
        "conclusion.html",
        include_str!("macos-installer/conclusion.html"),
    ),
];
/// Each appearance's artwork at 1x and 2x, which packaging joins into one TIFF.
const ARTWORK: [(&str, &[u8], &[u8]); 2] = [
    (
        "background",
        include_bytes!("macos-installer/background.png"),
        include_bytes!("macos-installer/background@2x.png"),
    ),
    (
        "background-darkAqua",
        include_bytes!("macos-installer/background-darkAqua.png"),
        include_bytes!("macos-installer/background-darkAqua@2x.png"),
    ),
];

/// A bundle version, as Installer compares and the distribution records it.
fn check_version(version: &str) -> Result<()> {
    let mut chars = version.chars();
    if !chars.next().is_some_and(|c| c.is_ascii_digit())
        || !chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))
    {
        return Err(format!(
            "Invalid version {version:?}: use digits, letters, '.', '-', and '+', starting with a digit"
        ));
    }
    Ok(())
}

/// A Git revision or ref whose documentation the pages link.
fn check_docs_ref(docs_ref: &str) -> Result<()> {
    if docs_ref.is_empty()
        || docs_ref.starts_with(['/', '.', '-'])
        || docs_ref.contains("..")
        || !docs_ref
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '/'))
    {
        return Err(format!("Invalid documentation ref {docs_ref:?}"));
    }
    Ok(())
}

fn io(context: &Path) -> impl Fn(std::io::Error) -> String + '_ {
    move |error| format!("{}: {error}", context.display())
}

fn create_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path).map_err(io(path))?;
    // Installer gives the payload's directories, including the root, which
    // is /, these modes.
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).map_err(io(path))
}

fn write(path: &Path, contents: &[u8], mode: u32) -> Result<()> {
    fs::write(path, contents).map_err(io(path))?;
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(io(path))
}

/// Copy the bundle's files and directories; a bundle holds nothing else. Every
/// file stays readable by all users, and executable when the bundle's is.
fn copy_bundle(from: &Path, to: &Path) -> Result<()> {
    create_dir(to)?;
    let mut entries = fs::read_dir(from)
        .map_err(io(from))?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(io(from))?;
    entries.sort();
    for source in entries {
        let target = to.join(source.file_name().ok_or("Invalid bundle entry")?);
        let metadata = fs::symlink_metadata(&source).map_err(io(&source))?;
        if metadata.is_dir() {
            copy_bundle(&source, &target)?;
        } else if metadata.is_file() {
            fs::copy(&source, &target).map_err(io(&source))?;
            let mode = if metadata.permissions().mode() & 0o111 != 0 {
                0o755
            } else {
                0o644
            };
            fs::set_permissions(&target, fs::Permissions::from_mode(mode)).map_err(io(&target))?;
        } else {
            return Err(format!(
                "{} is neither a file nor a directory; a bundle holds only those",
                source.display()
            ));
        }
    }
    Ok(())
}

fn check_bundle(bundle: &Path) -> Result<()> {
    for name in ["bin/nemoclaw", "manifest.json", "LICENSE"] {
        let path = bundle.join(name);
        if !fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.is_file()) {
            return Err(format!(
                "{} has no {name}; pass a darwin_arm64 bundle directory, such as dist/darwin_arm64",
                bundle.display()
            ));
        }
    }
    Ok(())
}

/// The license page: NemoClaw's license, then each notice the bundle ships
/// for the programs it includes from other projects.
fn license(bundle: &Path) -> Result<String> {
    let read = |path: &Path| fs::read_to_string(path).map_err(io(path));
    let mut text = format!(
        "{TITLE} is licensed under the Apache License, Version 2.0, which follows.\n\
         The programs it includes from other projects are under the licenses after it.\n\n"
    );
    text.push_str(&read(&bundle.join("LICENSE"))?);
    let directory = bundle.join("licenses");
    let mut notices = match fs::read_dir(&directory) {
        Ok(entries) => entries
            .map(|entry| entry.map(|entry| entry.path()))
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(io(&directory))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(io(&directory)(error)),
    };
    notices.sort();
    for notice in notices {
        let name = notice
            .file_name()
            .ok_or("Invalid notice")?
            .to_string_lossy()
            .into_owned();
        let rule = "-".repeat(72);
        text.push_str(&format!("\n\n{rule}\nlicenses/{name}\n{rule}\n\n"));
        text.push_str(&read(&notice)?);
    }
    Ok(text)
}

/// Fill a page's placeholders; one the tool doesn't know fails.
fn page(template: &str, version: &str, docs_ref: &str) -> Result<String> {
    let docs = format!("https://github.com/NVIDIA/NemoClaw/blob/{docs_ref}/docs");
    let minimum = MINIMUM_MACOS.trim_end_matches(".0");
    let mut page = template.replace("{{STYLE}}", STYLE);
    for (name, value) in [
        ("VERSION", version),
        ("DOCS", docs.as_str()),
        ("INSTALL_DIR", INSTALL_DIR),
        ("MINIMUM_MACOS", minimum),
    ] {
        page = page.replace(&format!("{{{{{name}}}}}"), value);
    }
    if let Some(start) = page.find("{{") {
        let rest = &page[start..];
        let end = rest.find("}}").map_or(rest.len(), |end| end + 2);
        return Err(format!("Unknown page placeholder {}", &rest[..end]));
    }
    Ok(page)
}

/// The distribution: one hidden choice installing the component package,
/// on Apple silicon running at least MINIMUM_MACOS. The installation check
/// runs when the package opens and refuses another Mac with its reason;
/// hostArchitectures keeps Installer from needing Rosetta on Apple silicon.
fn distribution(version: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
    <title>{TITLE}</title>
    <options customize="never" hostArchitectures="arm64"/>
    <domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>
    <volume-check>
        <allowed-os-versions>
            <os-version min="{MINIMUM_MACOS}"/>
        </allowed-os-versions>
    </volume-check>
    <installation-check script="supported_mac()"/>
    <script><![CDATA[
function supported_mac() {{
    if (system.sysctl('hw.optional.arm64') != 1) {{
        my.result.type = 'Fatal';
        my.result.title = '{INTEL_TITLE}';
        my.result.message = '{INTEL_MESSAGE}';
        return false;
    }}
    if (system.compareVersions(system.version.ProductVersion, '{MINIMUM_MACOS}') < 0) {{
        my.result.type = 'Fatal';
        my.result.title = '{MACOS_TITLE}';
        my.result.message = 'This Mac runs macOS ' + system.version.ProductVersion + '. {MACOS_MESSAGE}';
        return false;
    }}
    return true;
}}
    ]]></script>
    <welcome file="welcome.html" mime-type="text/html"/>
    <license file="license.txt" mime-type="text/plain"/>
    <conclusion file="conclusion.html" mime-type="text/html"/>
    <background file="background.tiff" mime-type="image/tiff" alignment="bottomleft" scaling="none"/>
    <background-darkAqua file="background-darkAqua.tiff" mime-type="image/tiff" alignment="bottomleft" scaling="none"/>
    <choices-outline>
        <line choice="default">
            <line choice="{IDENTIFIER}"/>
        </line>
    </choices-outline>
    <choice id="default"/>
    <choice id="{IDENTIFIER}" visible="false">
        <pkg-ref id="{IDENTIFIER}"/>
    </choice>
    <pkg-ref id="{IDENTIFIER}" version="{version}" onConclusion="none">nemoclaw-cli.pkg</pkg-ref>
    <product id="{PRODUCT}" version="{version}"/>
</installer-gui-script>
"#
    )
}

/// Lay out everything the packaging tools read under WORK: the payload in
/// root, the preinstall script in scripts, the pages in resources, the
/// artwork in art, and distribution.xml.
fn stage(bundle: &Path, work: &Path, version: &str, docs_ref: &str) -> Result<()> {
    check_version(version)?;
    check_docs_ref(docs_ref)?;
    check_bundle(bundle)?;
    let root = work.join("root");
    for directory in [
        "",
        "usr",
        "usr/local",
        "private",
        "private/etc",
        "private/etc/paths.d",
    ] {
        create_dir(&root.join(directory))?;
    }
    copy_bundle(bundle, &root.join(INSTALL_DIR.trim_start_matches('/')))?;
    write(
        &root.join(PATHS_FILE.trim_start_matches('/')),
        format!("{INSTALL_DIR}/bin\n").as_bytes(),
        0o644,
    )?;
    let scripts = work.join("scripts");
    create_dir(&scripts)?;
    write(&scripts.join("preinstall"), PREINSTALL.as_bytes(), 0o755)?;
    let resources = work.join("resources");
    create_dir(&resources)?;
    for (name, template) in PAGES {
        let page = page(template, version, docs_ref)?;
        write(&resources.join(name), page.as_bytes(), 0o644)?;
    }
    write(
        &resources.join("license.txt"),
        license(bundle)?.as_bytes(),
        0o644,
    )?;
    let art = work.join("art");
    create_dir(&art)?;
    for (name, single, double) in ARTWORK {
        write(&art.join(format!("{name}.png")), single, 0o644)?;
        write(&art.join(format!("{name}@2x.png")), double, 0o644)?;
    }
    write(
        &work.join("distribution.xml"),
        distribution(version).as_bytes(),
        0o644,
    )?;
    create_dir(&work.join("packages"))
}

fn run(command: &mut Command) -> Result<()> {
    let program = command.get_program().to_string_lossy().into_owned();
    let status = command
        .status()
        .map_err(|error| format!("Could not run {program}: {error}"))?;
    if !status.success() {
        return Err(format!("{program} failed ({status})"));
    }
    Ok(())
}

/// Build the component package from the staged payload, then the product
/// archive that Installer opens.
fn package(work: &Path, version: &str, output: &Path) -> Result<()> {
    let art = work.join("art");
    let resources = work.join("resources");
    for (name, _, _) in ARTWORK {
        run(Command::new("tiffutil")
            .arg("-cathidpicheck")
            .arg(art.join(format!("{name}.png")))
            .arg(art.join(format!("{name}@2x.png")))
            .arg("-out")
            .arg(resources.join(format!("{name}.tiff"))))?;
    }
    run(Command::new("pkgbuild")
        .arg("--root")
        .arg(work.join("root"))
        .args(["--identifier", IDENTIFIER, "--version", version])
        .args(["--install-location", "/", "--ownership", "recommended"])
        .args(["--min-os-version", MINIMUM_MACOS])
        .arg("--scripts")
        .arg(work.join("scripts"))
        .arg(work.join("packages/nemoclaw-cli.pkg")))?;
    run(Command::new("productbuild")
        .arg("--distribution")
        .arg(work.join("distribution.xml"))
        .arg("--resources")
        .arg(&resources)
        .arg("--package-path")
        .arg(work.join("packages"))
        .arg(output))
}

fn build(bundle: &Path, version: &str, docs_ref: &str, output: &Path) -> Result<()> {
    let work = env::temp_dir().join(format!("nemoclaw-installer-{}", std::process::id()));
    if work.exists() {
        fs::remove_dir_all(&work).map_err(io(&work))?;
    }
    let result =
        stage(bundle, &work, version, docs_ref).and_then(|()| package(&work, version, output));
    let _ = fs::remove_dir_all(&work);
    result
}

const USAGE: &str = "Usage: macos-installer build BUNDLE VERSION DOCS_REF OUTPUT";

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let result = match args.as_slice() {
        [command, bundle, version, docs_ref, output] if command == "build" => {
            build(Path::new(bundle), version, docs_ref, Path::new(output))
        }
        _ => Err(USAGE.into()),
    };
    if let Err(error) = result {
        eprintln!("::error::{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::BTreeMap, path::PathBuf, process::Output};

    /// A directory removed when the test ends.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new(name: &str) -> Self {
            let path = env::temp_dir().join(format!(
                "macos-installer-test-{}-{name}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn put(root: &Path, name: &str, contents: &str, mode: u32) {
        let path = root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, contents).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(mode)).unwrap();
    }

    fn fake_bundle(root: &Path) {
        put(
            root,
            "bin/nemoclaw",
            "#!/bin/sh\necho nemoclaw 0.0.1\n",
            0o700,
        );
        put(root, "libexec/tofu", "tofu", 0o755);
        put(root, "manifest.json", "{}\n", 0o600);
        put(root, "LICENSE", "Apache License\n", 0o644);
        put(root, "licenses/OpenTofu-LICENSE", "MPL\n", 0o644);
        put(root, "licenses/docker-provider-LICENSE", "MPL too\n", 0o644);
        put(root, "schemas/deployment.json", "{}\n", 0o644);
    }

    type Tree = BTreeMap<String, (Vec<u8>, u32)>;

    /// Every file under ROOT by relative path, with its contents and mode.
    fn tree(root: &Path) -> Tree {
        fn walk(root: &Path, directory: &Path, files: &mut Tree) {
            for entry in fs::read_dir(directory).unwrap() {
                let path = entry.unwrap().path();
                let metadata = fs::symlink_metadata(&path).unwrap();
                if metadata.is_dir() {
                    walk(root, &path, files);
                } else {
                    let name = path.strip_prefix(root).unwrap().to_string_lossy();
                    let mode = metadata.permissions().mode() & 0o777;
                    files.insert(name.into_owned(), (fs::read(&path).unwrap(), mode));
                }
            }
        }
        let mut files = BTreeMap::new();
        walk(root, root, &mut files);
        files
    }

    #[test]
    fn the_payload_is_the_bundle_under_the_install_directory_and_its_bin_on_path() {
        let scratch = Scratch::new("payload");
        let bundle = scratch.0.join("bundle");
        fake_bundle(&bundle);
        let work = scratch.0.join("work");
        stage(&bundle, &work, "0.1.0-rc.13", "v0.1.0-rc.13").unwrap();
        let mut expected: Tree = tree(&bundle)
            .into_iter()
            .map(|(name, (contents, mode))| {
                let mode = if mode & 0o111 != 0 { 0o755 } else { 0o644 };
                (format!("usr/local/nemoclaw/{name}"), (contents, mode))
            })
            .collect();
        expected.insert(
            "private/etc/paths.d/nemoclaw".into(),
            (b"/usr/local/nemoclaw/bin\n".to_vec(), 0o644),
        );
        assert_eq!(tree(&work.join("root")), expected);
        let root = fs::metadata(work.join("root")).unwrap().permissions();
        assert_eq!(root.mode() & 0o777, 0o755, "the payload root becomes /");
    }

    #[test]
    fn a_directory_that_is_not_a_bundle_is_refused() {
        let scratch = Scratch::new("not-a-bundle");
        for missing in ["bin/nemoclaw", "manifest.json", "LICENSE"] {
            let bundle = scratch.0.join(missing.replace('/', "-"));
            fake_bundle(&bundle);
            fs::remove_file(bundle.join(missing)).unwrap();
            let error = stage(&bundle, &scratch.0.join("work"), "0.1.0", "v1").unwrap_err();
            assert!(error.contains(missing), "{missing}: {error}");
        }
    }

    #[test]
    fn a_bundle_holding_a_symbolic_link_is_refused() {
        let scratch = Scratch::new("link");
        let bundle = scratch.0.join("bundle");
        fake_bundle(&bundle);
        std::os::unix::fs::symlink("/etc/passwd", bundle.join("licenses/link")).unwrap();
        let error = stage(&bundle, &scratch.0.join("work"), "0.1.0", "v1").unwrap_err();
        assert!(error.contains("licenses/link"), "{error}");
    }

    #[test]
    fn the_license_page_holds_the_bundle_license_and_each_notice_it_ships() {
        let scratch = Scratch::new("license");
        fake_bundle(&scratch.0);
        let text = license(&scratch.0).unwrap();
        let positions: Vec<usize> = [
            "Apache License\n",
            "licenses/OpenTofu-LICENSE\n",
            "MPL\n",
            "licenses/docker-provider-LICENSE\n",
            "MPL too\n",
        ]
        .iter()
        .map(|part| {
            text.find(part)
                .unwrap_or_else(|| panic!("{part:?} missing:\n{text}"))
        })
        .collect();
        assert!(positions.windows(2).all(|pair| pair[0] < pair[1]), "{text}");
    }

    #[test]
    fn the_pages_name_the_version_and_link_the_documentation_of_the_release() {
        let guide =
            "https://github.com/NVIDIA/NemoClaw/blob/v0.1.0-rc.13/docs/get-started/first-deployment.md";
        for (name, template) in PAGES {
            let page = page(template, "0.1.0-rc.13", "v0.1.0-rc.13").unwrap();
            assert!(!page.contains("{{"), "{name}");
            assert!(page.contains("prefers-color-scheme: dark"), "{name}");
            let expected = if name == "welcome.html" {
                "0.1.0-rc.13"
            } else {
                guide
            };
            assert!(page.contains(expected), "{name}");
        }
        let error = page("{{UNKNOWN}} text", "0.1.0", "v1").unwrap_err();
        assert!(error.contains("{{UNKNOWN}}"), "{error}");
    }

    #[test]
    fn the_distribution_admits_only_apple_silicon_with_the_minimum_macos() {
        let xml = distribution("0.1.0-rc.13");
        for expected in [
            r#"hostArchitectures="arm64""#,
            r#"<os-version min="15.0"/>"#,
            "system.sysctl('hw.optional.arm64') != 1",
            "compareVersions(system.version.ProductVersion, '15.0') < 0",
            r#"<pkg-ref id="com.nvidia.nemoclaw.cli" version="0.1.0-rc.13""#,
            r#"<background file="background.tiff""#,
            r#"<background-darkAqua file="background-darkAqua.tiff""#,
            r#"<license file="license.txt""#,
        ] {
            assert!(xml.contains(expected), "{expected} missing:\n{xml}");
        }
        // The script's strings are single-quoted JavaScript inside XML.
        for message in [INTEL_TITLE, INTEL_MESSAGE, MACOS_TITLE, MACOS_MESSAGE] {
            assert!(!message.contains(['\'', '\\', '<', '&']), "{message}");
        }
    }

    #[test]
    fn versions_and_references_that_could_alter_the_package_are_refused() {
        for version in ["", "v0.1.0", "0.1.0\"/>", "0.1 0"] {
            assert!(check_version(version).is_err(), "{version:?}");
        }
        for docs_ref in ["", "../main", "/v1", "v1?x", "-v"] {
            assert!(check_docs_ref(docs_ref).is_err(), "{docs_ref:?}");
        }
        assert!(check_version("0.1.0-rc.13.2+build").is_ok());
        assert!(check_docs_ref("0123abcd").is_ok());
    }

    #[test]
    fn the_preinstall_script_removes_only_the_installed_bundle() {
        let scratch = Scratch::new("preinstall");
        let volume = scratch.0.join("volume");
        put(&volume, "usr/local/nemoclaw/bin/nemoclaw", "old", 0o755);
        put(&volume, "usr/local/nemoclaw/stale", "old", 0o444);
        put(&volume, "usr/local/bin/other", "kept", 0o755);
        put(&scratch.0, "preinstall", PREINSTALL, 0o755);
        let target = format!("{}/", volume.display());
        let status = Command::new(scratch.0.join("preinstall"))
            .args(["package.pkg", &target, &target])
            .status()
            .unwrap();
        assert!(status.success());
        assert!(!volume.join("usr/local/nemoclaw").exists());
        let other = fs::read_to_string(volume.join("usr/local/bin/other")).unwrap();
        assert_eq!(other, "kept");
    }

    // The tests below change the Mac they run on: they install into / with
    // sudo, so only CI's disposable macOS runners run them, with --ignored.

    fn output(command: &mut Command) -> Output {
        command.output().unwrap()
    }

    fn text(output: &Output) -> String {
        format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    }

    fn install(package: &Path) -> Output {
        output(
            Command::new("sudo")
                .args(["installer", "-pkg"])
                .arg(package)
                .args(["-target", "/"]),
        )
    }

    /// Run SCRIPT in a login shell whose environment holds only HOME, an
    /// empty directory: what a new Terminal window starts with, without the
    /// user's startup files.
    fn login_shell(home: &Path, script: &str) -> Output {
        output(
            Command::new("/usr/bin/env")
                .arg("-i")
                .arg(format!("HOME={}", home.display()))
                .args(["/bin/zsh", "-l", "-c", script])
                .current_dir(home),
        )
    }

    #[test]
    #[ignore = "installs into / with sudo; CI's macOS installer job runs it"]
    fn upgrading_leaves_only_the_new_bundle_and_uninstalling_leaves_nothing() {
        let bundle = PathBuf::from(
            env::var("NEMOCLAW_INSTALLER_BUNDLE")
                .expect("NEMOCLAW_INSTALLER_BUNDLE names a darwin_arm64 bundle"),
        );
        let scratch = Scratch::new("system");
        let version = output(Command::new(bundle.join("bin/nemoclaw")).arg("--version"));
        assert!(version.status.success(), "{}", text(&version));
        let reported = String::from_utf8(version.stdout).unwrap();
        let bundle_version = reported.split_whitespace().nth(1).unwrap().to_owned();
        // An older release whose bundle held a file that the new one doesn't.
        let old = scratch.0.join("old");
        copy_bundle(&bundle, &old).unwrap();
        put(
            &old,
            "licenses/removed-in-the-new-release",
            "stale\n",
            0o644,
        );
        let old_package = scratch.0.join("old.pkg");
        let new_package = scratch.0.join("new.pkg");
        build(&old, "0.0.1", "v1", &old_package).unwrap();
        build(&bundle, &bundle_version, "v1", &new_package).unwrap();
        let home = scratch.0.join("home");
        fs::create_dir_all(&home).unwrap();
        let installed = Path::new(INSTALL_DIR);

        let result = install(&old_package);
        assert!(result.status.success(), "{}", text(&result));
        assert!(installed
            .join("licenses/removed-in-the-new-release")
            .is_file());

        let result = install(&new_package);
        assert!(result.status.success(), "{}", text(&result));
        let contents = |root: &Path| -> BTreeMap<String, Vec<u8>> {
            tree(root)
                .into_iter()
                .map(|(name, (contents, _))| (name, contents))
                .collect()
        };
        let (expected, actual) = (contents(&bundle), contents(installed));
        let extra: Vec<_> = actual
            .keys()
            .filter(|name| !expected.contains_key(*name))
            .collect();
        let missing: Vec<_> = expected
            .keys()
            .filter(|name| !actual.contains_key(*name))
            .collect();
        assert!(
            extra.is_empty() && missing.is_empty(),
            "extra {extra:?}, missing {missing:?}"
        );
        assert!(
            actual == expected,
            "an installed file differs from the bundle's"
        );
        let receipt = output(Command::new("pkgutil").args(["--files", IDENTIFIER]));
        let receipt = String::from_utf8(receipt.stdout).unwrap();
        assert!(!receipt.contains("removed-in-the-new-release"), "{receipt}");
        assert!(
            receipt
                .lines()
                .any(|line| line == "private/etc/paths.d/nemoclaw"),
            "{receipt}"
        );

        // A new Terminal window finds the CLI, which finds its bundle.
        let shell = login_shell(&home, "command -v nemoclaw && nemoclaw --version");
        assert!(shell.status.success(), "{}", text(&shell));
        assert_eq!(
            String::from_utf8(shell.stdout).unwrap(),
            format!("{INSTALL_DIR}/bin/nemoclaw\n{reported}")
        );
        // Destroy verifies the bundle before it reads the state directory,
        // which the empty home directory lacks.
        let shell = login_shell(&home, "nemoclaw plan --destroy");
        let said = text(&shell);
        assert!(!shell.status.success(), "{said}");
        assert!(
            said.contains("destroy requires existing deployment state"),
            "{said}"
        );
        // TEMPORARY diagnostic: does a symbolic link to the CLI find its bundle?
        let link = home.join("nemoclaw-link");
        std::os::unix::fs::symlink(installed.join("bin/nemoclaw"), &link).unwrap();
        let linked = output(
            Command::new(&link)
                .args(["plan", "--destroy"])
                .current_dir(&home),
        );
        eprintln!("SYMLINK DIAGNOSTIC: {}", text(&linked));

        // Uninstall as docs/get-started/install.md describes.
        let removed =
            output(Command::new("sudo").args(["rm", "-rf", INSTALL_DIR, "/etc/paths.d/nemoclaw"]));
        assert!(removed.status.success(), "{}", text(&removed));
        let forgotten = output(Command::new("sudo").args(["pkgutil", "--forget", IDENTIFIER]));
        assert!(forgotten.status.success(), "{}", text(&forgotten));
        assert!(!installed.exists());
        assert!(!Path::new(PATHS_FILE).exists());
        let info = output(Command::new("pkgutil").args(["--pkg-info", IDENTIFIER]));
        assert!(!info.status.success(), "{}", text(&info));
        let shell = login_shell(&home, "command -v nemoclaw");
        assert!(!shell.status.success(), "{}", text(&shell));
    }

    #[test]
    #[ignore = "runs Installer as root on an unsupported Mac; CI's refusal jobs run it"]
    fn an_unsupported_mac_refuses_the_installer_and_says_why() {
        let scratch = Scratch::new("refusal");
        let bundle = scratch.0.join("bundle");
        fake_bundle(&bundle);
        let package = scratch.0.join("nemoclaw.pkg");
        build(&bundle, "0.0.1", "v1", &package).unwrap();
        let result = install(&package);
        let said = text(&result);
        eprintln!("{said}");
        assert!(!result.status.success(), "{said}");
        let expected = if env::consts::ARCH == "x86_64" {
            [INTEL_TITLE, INTEL_MESSAGE]
        } else {
            [MACOS_TITLE, MACOS_MESSAGE]
        };
        assert!(
            expected.iter().any(|reason| said.contains(reason)),
            "{said}"
        );
        assert!(!Path::new(INSTALL_DIR).exists());
    }
}
