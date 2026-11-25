// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// 3S submission adapted from NVIDIA/fleet-intelligence-client PR #16,
// revision 9291b7eecac39b303e092d8c2109db579972f626 (Apache-2.0).
// Changes: Vault JWT authentication, inventory selection, bounded extraction,
// and explicit notarization result validation. Compile with rustc; no crates.
use std::{
    env, fs,
    io::Write,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
};
type Result<T> = std::result::Result<T, String>;
const VAULT: &str = "https://prod.internal.vault.nvidia.com";
const NAMESPACE: &str = "dgxc-eng-ai";
const AUDIENCE: &str = "https://prod.internal.vault.nvidia.com";
fn required(name: &str) -> Result<String> {
    env::var(name)
        .ok()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Missing {name}"))
}
// Capture output: service error responses and CLI diagnostics can contain credentials.
fn capture(cmd: &mut Command, input: Option<&[u8]>) -> Result<Vec<u8>> {
    let program = Path::new(cmd.get_program())
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("tool")
        .to_owned();
    let mut child = cmd
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "Could not start required tool")?;
    if let Some(bytes) = input {
        child
            .stdin
            .take()
            .ok_or("Missing child stdin")?
            .write_all(bytes)
            .map_err(|_| "Could not write child stdin")?;
    }
    let output = child
        .wait_with_output()
        .map_err(|_| "Could not wait for required tool")?;
    if !output.status.success() {
        return Err(format!(
            "Required tool {program} failed ({}); no release output is approved",
            output.status
        ));
    }
    Ok(output.stdout)
}
fn json_field(bytes: &[u8], filter: &str) -> Result<String> {
    let output = capture(
        Command::new(if cfg!(target_os = "linux") {
            "/usr/bin/jq"
        } else {
            "jq"
        })
        .args(["-er", filter]),
        Some(bytes),
    )?;
    let s = String::from_utf8(output).map_err(|_| "Invalid UTF-8")?;
    let s = s.trim_end_matches('\n');
    if s.is_empty() || s.contains(['\r', '\n']) {
        return Err("Invalid empty or multiline field".into());
    }
    Ok(s.into())
}
fn quoted(s: &str) -> String {
    let mut result = String::from("\"");
    for ch in s.chars() {
        match ch {
            '"' => result.push_str("\\\""),
            '\\' => result.push_str("\\\\"),
            '\n' => result.push_str("\\n"),
            '\r' => result.push_str("\\r"),
            '\t' => result.push_str("\\t"),
            c if c.is_control() => result.push_str(&format!("\\u{:04x}", c as u32)),
            c => result.push(c),
        }
    }
    result.push('"');
    result
}
fn http(url: &str, headers: &[String], body: Option<&str>) -> Result<Vec<u8>> {
    if !url.starts_with("https://") {
        return Err("HTTPS is required".into());
    }
    // Config travels over stdin so authentication headers never enter argv.
    let mut config = format!("url = {}\n", quoted(url));
    for h in headers {
        config.push_str(&format!("header = {}\n", quoted(h)));
    }
    if let Some(b) = body {
        config.push_str(&format!("data = {}\n", quoted(b)));
    }
    capture(
        Command::new(if cfg!(target_os = "linux") {
            "/usr/bin/curl"
        } else {
            "curl"
        })
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin")
        .args([
            "-q",
            "--silent",
            "--show-error",
            "--fail",
            "--proto",
            "=https",
            "--connect-timeout",
            "15",
            "--max-time",
            "90",
            "--config",
            "-",
        ]),
        Some(config.as_bytes()),
    )
}
struct VaultToken(String);
impl Drop for VaultToken {
    fn drop(&mut self) {
        let _ = http(
            &format!("{VAULT}/v1/auth/token/revoke-self"),
            &[
                format!("X-Vault-Namespace: {NAMESPACE}"),
                format!("X-Vault-Token: {}", self.0),
            ],
            Some("{}"),
        );
    }
}
fn mask(s: &str) {
    println!(
        "::add-mask::{}",
        s.replace('%', "%25")
            .replace('\r', "%0D")
            .replace('\n', "%0A")
    );
}
fn authorize(role: &str) -> Result<VaultToken> {
    let url = required("ACTIONS_ID_TOKEN_REQUEST_URL")?;
    if !url.starts_with("https://") {
        return Err("Invalid OIDC URL".into());
    }
    let sep = if url.contains('?') { '&' } else { '?' };
    let jwt = json_field(
        &http(
            &format!("{url}{sep}audience={AUDIENCE}"),
            &[format!(
                "Authorization: bearer {}",
                required("ACTIONS_ID_TOKEN_REQUEST_TOKEN")?
            )],
            None,
        )?,
        ".value | select(type == \"string\")",
    )?;
    mask(&jwt);
    let body = format!("{{\"role\":{},\"jwt\":{}}}", quoted(role), quoted(&jwt));
    let response = http(
        &format!("{VAULT}/v1/auth/jwt/nemoclaw-release-signing/login"),
        &[
            format!("X-Vault-Namespace: {NAMESPACE}"),
            "Content-Type: application/json".into(),
        ],
        Some(&body),
    )?;
    let token = VaultToken(json_field(
        &response,
        ".auth.client_token | select(type == \"string\")",
    )?);
    mask(&token.0);
    Ok(token)
}
fn credentials() -> Result<(String, String, VaultToken)> {
    let token = authorize("nemoclaw-release-signing")?;
    let response = http(
        &format!("{VAULT}/v1/services/nemoclaw-release-signing/ssa/issue/creds"),
        &[
            format!("X-Vault-Namespace: {NAMESPACE}"),
            format!("X-Vault-Token: {}", token.0),
        ],
        None,
    )?;
    let id = json_field(&response, ".data.client_id | select(type == \"string\")")?;
    let secret = json_field(&response, ".data.secret | select(type == \"string\")")?;
    mask(&secret);
    Ok((id, secret, token))
}
struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Result<Self> {
        let parent = PathBuf::from(required("RUNNER_TEMP")?);
        let path = parent.join(format!("nemoclaw-3s-{}", std::process::id()));
        fs::create_dir(&path).map_err(|_| "Could not create private scratch directory")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
                .map_err(|_| "chmod scratch failed")?;
        }
        Ok(Self(path))
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn safe_program(bundle: &Path, name: &str) -> Result<()> {
    if name.is_empty()
        || !Path::new(name)
            .components()
            .all(|p| matches!(p, Component::Normal(_)))
    {
        return Err("Inventory path is outside bundle".into());
    }
    let root = bundle.canonicalize().map_err(|_| "Missing bundle")?;
    let file = bundle.join(name);
    let meta = fs::symlink_metadata(&file).map_err(|_| "Missing executable")?;
    if !meta.is_file()
        || meta.file_type().is_symlink()
        || !file
            .canonicalize()
            .map_err(|_| "Missing executable")?
            .starts_with(root)
    {
        return Err("Inventory entry is not a regular file inside bundle".into());
    }
    Ok(())
}
fn require_accepted(json: &[u8]) -> Result<()> {
    if json_field(json, ".status")? != "Accepted" {
        return Err("Apple has not accepted the notarization submission".into());
    }
    Ok(())
}
fn inventory(bundle: &Path) -> Result<Vec<String>> {
    let output = capture(
        Command::new("bash")
            .arg(".github/scripts/signing-inventory.sh")
            .arg(bundle)
            .arg("darwin_arm64"),
        None,
    )?;
    let text = String::from_utf8(output).map_err(|_| "Invalid inventory")?;
    let mut names = Vec::new();
    for line in text.lines() {
        let (owner, name) = line.split_once('\t').ok_or("Invalid inventory row")?;
        safe_program(bundle, name)?;
        match owner {
            "nvidia" => names.push(name.into()),
            "hashicorp" => (),
            _ => return Err("Unknown signing owner".into()),
        }
    }
    if names.is_empty() {
        return Err("No NVIDIA executables to sign".into());
    }
    Ok(names)
}
/// The identifier codesign gives a program: 3S signs the submitted file, and
/// codesign names it after the file without its extension. A reverse-DNS name
/// per program, without a provider's version, keeps each program's designated
/// requirement distinct and unchanged across releases.
fn signing_identifier(name: &str) -> Result<String> {
    let file = Path::new(name)
        .file_name()
        .and_then(|file| file.to_str())
        .ok_or("Invalid program name")?;
    let stem = file
        .match_indices("_v")
        .find(|(index, _)| file[index + 2..].starts_with(|c: char| c.is_ascii_digit()))
        .map_or(file, |(index, _)| &file[..index]);
    if stem.is_empty() {
        return Err("Invalid program name".into());
    }
    let stem: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    Ok(format!("com.nvidia.nemoclaw.{stem}"))
}
fn prepare_executable(source: &Path, destination: &Path) -> Result<()> {
    fs::copy(source, destination).map_err(|_| "Could not copy executable")?;
    // The private runner extracts under umask 077; 3S must receive a normal
    // executable rather than inheriting those private scratch permissions.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(destination, fs::Permissions::from_mode(0o755))
            .map_err(|_| "Could not set signing payload permissions")?;
    }
    Ok(())
}
fn submit_3s(
    input: &Path,
    scratch: &Path,
    result_filename: &str,
    id: &str,
    secret: &str,
) -> Result<()> {
    capture(
        Command::new("nvsec")
            .env("HOME", scratch)
            .env("XDG_CACHE_HOME", scratch)
            .env("TMPDIR", scratch)
            .env("NVSEC_SSA_CLIENT_ID", id)
            .env("NVSEC_SSA_CLIENT_SECRET", secret)
            .args([
                "3s",
                "submit",
                "--description",
                "NemoClaw macOS release signing",
                "--job_type",
                "MACOS",
                "--scope",
                "SIGNING_MACOS",
                "--auth",
                "ssa",
                "--input_file",
            ])
            .arg(input)
            .args(["--download", "--timeout", "600", "--result_dir"])
            .arg(scratch)
            .args([
                "--result_filename",
                result_filename,
                "--nspect_id",
                "NSPECT-SQ44-PJFM",
            ]),
        None,
    )?;
    Ok(())
}
fn sign(bundle: &Path) -> Result<()> {
    if required("MACOS_THIRD_PARTY_SIGNING_APPROVED")? != "true" {
        return Err("Product Security approval is required".into());
    }
    let names = inventory(bundle)?;
    let scratch = Scratch::new()?;
    let (id, secret, token) = credentials()?;
    drop(token);
    for name in names {
        let member = format!("{}.command", signing_identifier(&name)?);
        let input = scratch.0.join(&member);
        let archive = scratch.0.join("input.zip");
        let signed = scratch.0.join("signed.zip");
        prepare_executable(&bundle.join(&name), &input)?;
        capture(
            Command::new("zip")
                .current_dir(&scratch.0)
                .args(["-q", "-X"])
                .arg(&archive)
                .arg(&member),
            None,
        )?;
        submit_3s(&archive, &scratch.0, "signed.zip", &id, &secret)?;
        // Read just the expected member; never extract service-returned paths.
        let listing = capture(Command::new("unzip").arg("-Z1").arg(&signed), None)?;
        if listing != format!("{member}\n").as_bytes() {
            return Err("Unexpected 3S archive layout".into());
        }
        let bytes = capture(
            Command::new("unzip").arg("-p").arg(&signed).arg(&member),
            None,
        )?;
        if bytes.len() < 4 {
            return Err("3S returned an empty executable".into());
        }
        // The final hosted-Mac check proves signature, identity, and notarization.
        fs::write(&input, bytes).map_err(|_| "Could not save signed executable")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&input, fs::Permissions::from_mode(0o755))
                .map_err(|_| "chmod executable failed")?;
        }
        fs::copy(&input, bundle.join(&name)).map_err(|_| "Could not replace executable")?;
        fs::remove_file(archive).map_err(|_| "Could not remove input archive")?;
        fs::remove_file(signed).map_err(|_| "Could not remove result archive")?;
    }
    Ok(())
}
// Installer packages retain their .pkg extension so 3S selects pkg signing.
// Submit the package directly: a ZIP selects application signing in 3S.
// Replace the input only after the returned package passes validation.
fn sign_package_with(
    package: &Path,
    scratch: &Path,
    submit: impl FnOnce(&Path, &Path) -> Result<()>,
) -> Result<()> {
    let member = package
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("Invalid package name")?;
    if !member.ends_with(".pkg") {
        return Err("Expected a .pkg installer".into());
    }
    safe_program(package.parent().ok_or("Missing package directory")?, member)?;
    let payload = scratch.join(member);
    fs::copy(package, &payload).map_err(|_| "Could not copy installer")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&payload, fs::Permissions::from_mode(0o644))
            .map_err(|_| "Could not set package permissions")?;
    }
    let signed = scratch.join("signed.pkg");
    submit(&payload, &signed)?;
    let bytes = fs::read(&signed).map_err(|_| "3S did not return a signed installer")?;
    if !bytes.starts_with(b"xar!") {
        return Err("3S did not return an installer package".into());
    }
    // The hosted Mac verifies the Developer ID Installer identity and notarization.
    fs::write(package, bytes).map_err(|_| "Could not save signed installer")?;
    Ok(())
}
fn sign_package(package: &Path) -> Result<()> {
    let scratch = Scratch::new()?;
    let (id, secret, token) = credentials()?;
    drop(token);
    sign_package_with(package, &scratch.0, |archive, _| {
        submit_3s(archive, &scratch.0, "signed.pkg", &id, &secret)
    })
}
fn notarize(bundle: &Path) -> Result<()> {
    let names = inventory(bundle)?;
    let scratch = Scratch::new()?;
    let archive = scratch.0.join("notarize.zip");
    let mut zip = Command::new("zip");
    zip.current_dir(bundle).args(["-q", "-X"]).arg(&archive);
    for name in &names {
        zip.arg(name);
    }
    capture(&mut zip, None)?;
    let result = capture(
        Command::new("xcrun")
            .args(["notarytool", "submit"])
            .arg(&archive)
            .args([
                "--keychain-profile",
                &required("APPLE_NOTARY_PROFILE")?,
                "--keychain",
                &required("APPLE_NOTARY_KEYCHAIN")?,
                "--wait",
                "--timeout",
                "20m",
                "--output-format",
                "json",
            ]),
        None,
    )?;
    require_accepted(&result)?;
    fs::write(
        PathBuf::from(required("RUNNER_TEMP")?).join("darwin_arm64.notarization.json"),
        result,
    )
    .map_err(|_| "Could not save notarization evidence")?;
    Ok(())
}
// Job metadata is an early rejection; Vault validates the signed issuer claims.
fn admit_with(job: &str, login: impl FnOnce() -> Result<()>) -> Result<()> {
    if !matches!(job, "sign-macos-3s" | "sign-macos-installer-3s") {
        return Err("This runner accepts only the release signing job".into());
    }
    login()
}
fn admit() -> Result<()> {
    admit_with(&required("GITHUB_JOB")?, || {
        let token = authorize("nemoclaw-release-signing-admission")?;
        drop(token);
        println!("Signing runner admission accepted by Vault");
        Ok(())
    })
}
fn run() -> Result<()> {
    let args: Vec<_> = env::args().collect();
    if args.len() == 2 && args[1] == "admit" {
        return admit();
    }
    if args.len() != 3 {
        return Err(
            "Usage: macos-signing admit | sign BUNDLE | sign-package PACKAGE | notarize BUNDLE"
                .into(),
        );
    }
    let bundle = Path::new(&args[2])
        .canonicalize()
        .map_err(|_| "Missing bundle")?;
    match args[1].as_str() {
        "sign" => sign(&bundle),
        "sign-package" => sign_package(&bundle),
        "notarize" => notarize(&bundle),
        _ => Err("Unknown signing operation".into()),
    }
}
fn main() {
    if let Err(error) = run() {
        eprintln!("::error::{error}");
        std::process::exit(1);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unrelated_job_is_rejected_before_authentication() {
        let called = std::cell::Cell::new(false);
        assert!(admit_with("pull-request-build", || {
            called.set(true);
            Ok(())
        })
        .is_err());
        assert!(!called.get());
    }
    #[test]
    fn signing_job_is_rejected_when_vault_denies_its_identity() {
        assert!(admit_with("sign-macos-3s", || Err("identity denied".into())).is_err());
    }
    #[test]
    fn signing_job_requires_successful_admission() {
        let called = std::cell::Cell::new(false);
        assert!(admit_with("sign-macos-3s", || {
            called.set(true);
            Ok(())
        })
        .is_ok());
        assert!(called.get());
    }
    #[test]
    fn installer_job_requires_vault_admission() {
        let called = std::cell::Cell::new(false);
        assert!(admit_with("sign-macos-installer-3s", || {
            called.set(true);
            Ok(())
        })
        .is_ok());
        assert!(called.get());
        assert!(admit_with("sign-macos-installer-3s", || Err("denied".into())).is_err());
    }
    #[test]
    fn package_signing_submits_a_pkg_and_preserves_input_on_failure() {
        let root = env::temp_dir().join(format!("nemoclaw-package-test-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let package = root.join("nemoclaw-v0.1.0-rc.1-darwin_arm64.pkg");
        let work = root.join("work");
        fs::create_dir(&work).unwrap();
        for failure in ["none", "service", "invalid", "empty"] {
            fs::write(&package, b"xar!unsigned package").unwrap();
            let result = sign_package_with(&package, &work, |input, output| {
                assert_eq!(
                    input.extension().unwrap(),
                    "pkg",
                    "3S selects package signing from the input extension"
                );
                assert_eq!(fs::read(input).unwrap(), b"xar!unsigned package");
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    assert_eq!(
                        fs::metadata(input).unwrap().permissions().mode() & 0o777,
                        0o644
                    );
                }
                if failure == "service" {
                    return Err("submission failed".into());
                }
                let bytes = match failure {
                    "empty" => b"".as_slice(),
                    "invalid" => b"not a package".as_slice(),
                    _ => b"xar!signed package".as_slice(),
                };
                fs::write(output, bytes).unwrap();
                Ok(())
            });
            if failure == "none" {
                assert!(result.is_ok(), "{result:?}");
                assert_eq!(fs::read(&package).unwrap(), b"xar!signed package");
            } else {
                assert!(result.is_err(), "{failure}");
                assert_eq!(fs::read(&package).unwrap(), b"xar!unsigned package");
            }
            for entry in fs::read_dir(&work).unwrap() {
                fs::remove_file(entry.unwrap().path()).unwrap();
            }
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejected_submission_stops_release() {
        assert!(require_accepted(br#"{"status":"Rejected"}"#).is_err());
    }
    #[test]
    fn incomplete_submission_stops_release() {
        assert!(require_accepted(br#"{"status":"In Progress"}"#).is_err());
        assert!(require_accepted(b"{}").is_err());
        assert!(require_accepted(b"invalid JSON").is_err());
    }
    #[test]
    fn accepted_submission_continues() {
        assert!(require_accepted(br#"{"status":"Accepted"}"#).is_ok());
    }
    #[test]
    fn regular_program_inside_bundle_is_allowed() {
        let root = std::env::temp_dir().join(format!("nemoclaw-path-test-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("program"), b"fixture").unwrap();
        assert!(safe_program(&root, "program").is_ok());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc/passwd", root.join("outside")).unwrap();
            assert!(safe_program(&root, "outside").is_err());
            std::os::unix::fs::symlink("program", root.join("alias")).unwrap();
            assert!(safe_program(&root, "alias").is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn inventory_cannot_escape_bundle() {
        assert!(safe_program(Path::new("."), "../outside").is_err());
        assert!(safe_program(Path::new("."), "/tmp/outside").is_err());
    }
    #[test]
    fn each_program_gets_its_own_versionless_signing_identifier() {
        for (name, identifier) in [
            ("bin/nemoclaw", "com.nvidia.nemoclaw.nemoclaw"),
            ("libexec/tofu", "com.nvidia.nemoclaw.tofu"),
            (
                "providers/nvidia.github.io/nemoclaw/fabric/0.1.0-rc.1/darwin_arm64/terraform-provider-fabric_v0.1.0-rc.1",
                "com.nvidia.nemoclaw.terraform-provider-fabric",
            ),
            (
                "providers/registry.opentofu.org/kreuzwerker/docker/4.7.0/darwin_arm64/terraform-provider-docker_v4.7.0",
                "com.nvidia.nemoclaw.terraform-provider-docker",
            ),
            ("bin/odd_name.x", "com.nvidia.nemoclaw.odd-name-x"),
        ] {
            assert_eq!(signing_identifier(name).unwrap(), identifier);
        }
        assert!(signing_identifier("bin/_v1").is_err());
    }

    #[test]
    fn failed_tools_identify_the_program_and_status_without_disclosing_output() {
        let error = capture(
            Command::new("sh").args([
                "-c",
                "printf stdout-sensitive; printf stderr-sensitive >&2; exit 7",
            ]),
            None,
        )
        .unwrap_err();
        assert!(error.contains("sh"), "{error}");
        assert!(error.contains('7'), "{error}");
        assert!(!error.contains("stdout-sensitive"));
        assert!(!error.contains("stderr-sensitive"));
    }
    #[cfg(unix)]
    #[test]
    fn signing_payload_is_executable_by_the_signing_service() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("nemoclaw-mode-test-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        let source = root.join("source");
        let payload = root.join("payload.command");
        fs::write(&source, b"executable fixture").unwrap();
        fs::set_permissions(&source, fs::Permissions::from_mode(0o700)).unwrap();
        prepare_executable(&source, &payload).unwrap();
        let mode = fs::metadata(&payload).unwrap().permissions().mode() & 0o777;
        let contents = fs::read(&payload).unwrap();
        fs::remove_dir_all(&root).unwrap();
        assert_eq!(mode, 0o755);
        assert_eq!(contents, b"executable fixture");
    }
}
