// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Installs, upgrades, downgrades, and uninstalls the Windows installer for
//! the current user, as a user would, and checks each result. It changes the
//! machine it runs on, so CI / Bundle runs it on a fresh runner only.
//! Compile with rustc; no crates.
//!
//! windows-installer-e2e --older OLDER.msi --current CURRENT.msi
//!     --version VERSION --msi-version MSI_VERSION --stale RELATIVE --logs DIR
//!
//! OLDER is a lower-versioned build whose bundle has the extra file STALE;
//! CURRENT is the build under test, whose bundle reports VERSION.
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};
type Result<T> = std::result::Result<T, String>;

/// The installer source's UpgradeCode.
const UPGRADE_CODE: &str = "{3BD34EE5-425E-4DBC-A15A-E52865D10C8B}";
const PUBLISHER: &str = "NVIDIA Corporation";
const DOWNGRADE: &str = "A newer version of NVIDIA NemoClaw Agent Configs is already installed.";
/// What plan --destroy reports in an empty directory once the CLI has found
/// and verified its bundle; a missing or altered bundle fails before it.
const NO_STATE: &str = "destroy requires existing deployment state";
/// Windows Installer's exit code for a failed installation.
const INSTALL_FAILURE: i32 = 1603;

/// The entries of a Path value, without empty ones.
fn path_entries(value: &str) -> Vec<&str> {
    value
        .split(';')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .collect()
}

/// How many entries of a Path value name `directory`, as Windows compares
/// paths: without case or a trailing separator.
fn occurrences(value: &str, directory: &str) -> usize {
    let normal = |path: &str| path.trim_end_matches('\\').to_lowercase();
    path_entries(value)
        .into_iter()
        .filter(|entry| normal(entry) == normal(directory))
        .count()
}

/// The data of value `name` in reg query's output, or None when it has none.
fn reg_value(output: &str, name: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let line = line.trim_start();
        let rest = line.get(name.len()..)?;
        let head = line.get(..name.len())?;
        if !head.eq_ignore_ascii_case(name) || !rest.starts_with("    ") {
            return None;
        }
        let rest = rest.trim_start();
        let (kind, data) = rest.split_once("    ").unwrap_or((rest.trim_end(), ""));
        kind.starts_with("REG_")
            .then(|| data.trim_start().trim_end_matches(['\r', '\n']).to_owned())
    })
}

/// A registry value with its %NAME% references expanded from `lookup`, as
/// Windows expands REG_EXPAND_SZ values for a new process; unknown names stay.
fn expand(value: &str, lookup: impl Fn(&str) -> Option<String>) -> String {
    let mut expanded = String::new();
    let mut rest = value;
    while let Some(start) = rest.find('%') {
        expanded.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) => {
                let name = &after[..end];
                match lookup(name).filter(|_| !name.is_empty()) {
                    Some(found) => expanded.push_str(&found),
                    None => {
                        expanded.push('%');
                        expanded.push_str(name);
                        expanded.push('%');
                    }
                }
                rest = &after[end + 1..];
            }
            None => {
                expanded.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    expanded.push_str(rest);
    expanded
}

/// A Windows Installer log, which is UTF-16 with a byte order mark or ANSI.
fn log_text(bytes: &[u8]) -> String {
    match bytes {
        [0xff, 0xfe, rest @ ..] => {
            let units: Vec<u16> = rest
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect();
            String::from_utf16_lossy(&units)
        }
        _ => String::from_utf8_lossy(bytes).into_owned(),
    }
}

type Product = (String, Vec<(String, String)>);

/// Each product's properties from lines of PRODUCT<TAB>NAME<TAB>VALUE.
fn products(output: &str) -> Vec<Product> {
    let mut products: Vec<Product> = Vec::new();
    for line in output.lines() {
        let mut fields = line.splitn(3, '\t');
        let (Some(product), Some(name), Some(value)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let property = (name.to_owned(), value.trim_end().to_owned());
        match products.iter_mut().find(|(code, _)| code == product) {
            Some((_, properties)) => properties.push(property),
            None => products.push((product.to_owned(), vec![property])),
        }
    }
    products
}

fn property<'a>(product: &'a [(String, String)], name: &str) -> &'a str {
    product
        .iter()
        .find(|(key, _)| key == name)
        .map_or("", |(_, value)| value.as_str())
}

fn check(condition: bool, message: impl FnOnce() -> String) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(message())
    }
}

fn output(command: &mut Command) -> Result<(i32, String)> {
    let output = command
        .output()
        .map_err(|e| format!("cannot run {:?}: {e}", command.get_program()))?;
    Ok((
        output.status.code().unwrap_or(-1),
        format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ),
    ))
}

fn registry(key: &str, name: &str) -> Result<Option<String>> {
    let (code, text) = output(Command::new("reg").args(["query", key, "/v", name]))?;
    Ok(if code == 0 {
        reg_value(&text, name)
    } else {
        None
    })
}

fn user_path() -> Result<String> {
    Ok(registry("HKCU\\Environment", "Path")?.unwrap_or_default())
}

/// The Path a new terminal gets: the machine's, then the user's, expanded.
fn new_terminal_path() -> Result<String> {
    let machine = registry(
        "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
        "Path",
    )?
    .unwrap_or_default();
    let lookup = |name: &str| env::var(name).ok();
    Ok(format!(
        "{};{}",
        expand(&machine, lookup),
        expand(&user_path()?, lookup)
    ))
}

/// Runs a command line in a new cmd.exe with a new terminal's Path.
fn in_new_terminal(directory: &Path, line: &[&str]) -> Result<(i32, String)> {
    let shell = env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
    output(
        Command::new(shell)
            .args(["/d", "/c"])
            .args(line)
            .env("PATH", new_terminal_path()?)
            .current_dir(directory),
    )
}

fn powershell(script: &str, package: Option<&Path>) -> Result<String> {
    let mut command = Command::new("powershell.exe");
    command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    if let Some(package) = package {
        command.env("PACKAGE", package);
    }
    let (code, text) = output(&mut command)?;
    check(code == 0, || {
        format!("Windows Installer's API failed: {text}")
    })?;
    Ok(text)
}

/// Windows Installer's view of the products with the installer's UpgradeCode.
fn installed() -> Result<Vec<Product>> {
    let script = format!(
        r#"$ErrorActionPreference = 'Stop'
$i = New-Object -ComObject WindowsInstaller.Installer
function Get($o, $name, $arguments) {{ $o.GetType().InvokeMember($name, 'GetProperty', $null, $o, $arguments) }}
# A function's output enumerates the returned list into its product codes.
foreach ($p in @(Get $i 'RelatedProducts' @('{UPGRADE_CODE}'))) {{
  foreach ($n in 'InstalledProductName', 'VersionString', 'Publisher', 'HelpLink', 'URLInfoAbout', 'URLUpdateInfo', 'AssignmentType') {{
    "$p`t$n`t$(Get $i 'ProductInfo' @($p, $n))"
  }}
}}"#
    );
    Ok(products(&powershell(&script, None)?))
}

/// The package's Word Count summary property, whose bit 8 says it installs
/// without elevated privileges.
fn word_count(package: &Path) -> Result<u32> {
    let script = r#"$ErrorActionPreference = 'Stop'
$i = New-Object -ComObject WindowsInstaller.Installer
$s = $i.GetType().InvokeMember('SummaryInformation', 'GetProperty', $null, $i, @($env:PACKAGE, 0))
$s.GetType().InvokeMember('Property', 'GetProperty', $null, $s, @(15))"#;
    let text = powershell(script, Some(package))?;
    text.trim()
        .parse()
        .map_err(|_| format!("unexpected Word Count {text}"))
}

/// A test-only copy of the current package that fails after installing files.
/// Editing the copy leaves the release package and its signature untouched.
fn failing_upgrade(package: &Path, logs: &Path) -> Result<PathBuf> {
    let copy = logs.join("failing-upgrade.msi");
    fs::copy(package, &copy).map_err(|e| format!("cannot copy the upgrade fixture: {e}"))?;
    let script = r#"$ErrorActionPreference = 'Stop'
$i = New-Object -ComObject WindowsInstaller.Installer
function Get($o, $name, $arguments) { $o.GetType().InvokeMember($name, 'GetProperty', $null, $o, $arguments) }
function Call($o, $name, $arguments) { $o.GetType().InvokeMember($name, 'InvokeMethod', $null, $o, $arguments) }
$db = Call $i 'OpenDatabase' @($env:PACKAGE, 1)
function Execute($sql) {
  $view = Call $db 'OpenView' @($sql)
  Call $view 'Execute' @() | Out-Null
  return $view
}
$view = Execute "SELECT ``Sequence`` FROM ``InstallExecuteSequence`` WHERE ``Action`` = 'InstallFiles'"
$record = Call $view 'Fetch' @()
$sequence = (Get $record 'IntegerData' @(1)) + 1
Execute "INSERT INTO ``CustomAction`` (``Action``, ``Type``, ``Target``) VALUES ('NemoClawTestUpgradeFailure', 19, 'Intentional upgrade failure after installing files')" | Out-Null
Execute "INSERT INTO ``InstallExecuteSequence`` (``Action``, ``Condition``, ``Sequence``) VALUES ('NemoClawTestUpgradeFailure', 'WIX_UPGRADE_DETECTED', $sequence)" | Out-Null
Call $db 'Commit' @() | Out-Null"#;
    powershell(script, Some(&copy))?;
    Ok(copy)
}

struct Installer {
    logs: PathBuf,
    step: usize,
}

impl Installer {
    /// Runs msiexec ACTION PACKAGE quietly, with a verbose log.
    fn msiexec(&mut self, action: &str, package: &Path, name: &str) -> Result<(i32, String)> {
        self.step += 1;
        let log = self.logs.join(format!("{}-{name}.log", self.step));
        eprintln!("msiexec {action} {} /qn", package.display());
        let status = Command::new("msiexec")
            .arg(action)
            .arg(package)
            .args(["/qn", "/norestart", "/l*v"])
            .arg(&log)
            .status()
            .map_err(|e| format!("cannot run msiexec: {e}"))?;
        let text = fs::read(&log)
            .map(|bytes| log_text(&bytes))
            .unwrap_or_default();
        Ok((status.code().unwrap_or(-1), text))
    }

    fn succeed(&mut self, action: &str, package: &Path, name: &str) -> Result<()> {
        let (code, _) = self.msiexec(action, package, name)?;
        check(code == 0, || {
            format!(
                "msiexec {action} {} exited {code}; see its log",
                package.display()
            )
        })
    }
}

struct Options {
    older: PathBuf,
    current: PathBuf,
    version: String,
    msi_version: String,
    stale: String,
    logs: PathBuf,
}

fn options() -> Result<Options> {
    let mut values = std::collections::BTreeMap::new();
    let mut args = env::args().skip(1);
    while let Some(flag) = args.next() {
        let value = args.next().ok_or_else(|| format!("{flag} needs a value"))?;
        values.insert(flag, value);
    }
    let mut take = |flag: &str| {
        values
            .remove(flag)
            .ok_or_else(|| format!("missing {flag}; see the usage in this file"))
    };
    Ok(Options {
        older: absolute(take("--older")?)?,
        current: absolute(take("--current")?)?,
        version: take("--version")?,
        msi_version: take("--msi-version")?,
        stale: take("--stale")?,
        logs: absolute(take("--logs")?)?,
    })
}

/// msiexec reads a slash in a package path as an option, so each path is made
/// absolute, which on Windows also turns its slashes into backslashes.
fn absolute(value: String) -> Result<PathBuf> {
    std::path::absolute(&value).map_err(|e| format!("{value}: {e}"))
}

fn run() -> Result<()> {
    let options = options()?;
    fs::create_dir_all(&options.logs).map_err(|e| e.to_string())?;
    let mut installer = Installer {
        logs: options.logs.clone(),
        step: 0,
    };
    let local = env::var("LOCALAPPDATA").map_err(|_| "LOCALAPPDATA isn't set")?;
    let folder = Path::new(&local).join("Programs").join("NemoClaw");
    let bin = folder.join("bin").display().to_string();
    let executable = folder.join("bin").join("nemoclaw.exe");
    let stale = folder.join(&options.stale);
    let installed_once = |when: &str| -> Result<()> {
        let path = user_path()?;
        check(occurrences(&path, &bin) == 1, || {
            format!("{when}, the user Path doesn't name {bin} once: {path}")
        })
    };

    check(!folder.exists(), || {
        format!("{} exists before the test", folder.display())
    })?;
    check(word_count(&options.current)? & 8 == 8, || {
        "the package asks for elevated privileges".into()
    })?;

    eprintln!("== Install the older build");
    installer.succeed("/i", &options.older, "install-older")?;
    check(executable.is_file(), || {
        format!("{} isn't installed", executable.display())
    })?;
    check(stale.is_file(), || {
        format!("the older build didn't install {}", stale.display())
    })?;
    installed_once("after installing")?;

    eprintln!("== Restore the older build after a failed upgrade");
    let previous_products = installed()?;
    let previous_executable = fs::read(&executable).map_err(|e| e.to_string())?;
    let broken = failing_upgrade(&options.current, &options.logs)?;
    let (code, log) = installer.msiexec("/i", &broken, "failed-upgrade")?;
    check(
        code == INSTALL_FAILURE
            && log.contains("Intentional upgrade failure after installing files"),
        || format!("the upgrade fixture didn't reach its intentional failure: exited {code}"),
    )?;
    check(executable.is_file(), || {
        "the failed upgrade removed the previous CLI instead of restoring it".into()
    })?;
    check(
        fs::read(&executable).map_err(|e| e.to_string())? == previous_executable,
        || "the failed upgrade changed the previous CLI".into(),
    )?;
    check(stale.is_file(), || {
        "the failed upgrade didn't restore the older build's extra file".into()
    })?;
    check(installed()? == previous_products, || {
        "the failed upgrade didn't restore the previous registered product".into()
    })?;
    installed_once("after rolling back the failed upgrade")?;

    eprintln!("== Install the current build over it");
    installer.succeed("/i", &options.current, "upgrade")?;
    check(executable.is_file(), || {
        format!("{} isn't installed", executable.display())
    })?;
    if let Some(first) = Path::new(&options.stale).components().next() {
        let retired = folder.join(first);
        check(!retired.exists(), || {
            format!("{} remains from the older build", retired.display())
        })?;
    }
    installed_once("after upgrading")?;
    let listed = installed()?;
    check(listed.len() == 1, || {
        format!("expected one installed product, found {listed:?}")
    })?;
    let product = &listed[0].1;
    let name = format!("NVIDIA NemoClaw Agent Configs {}", options.version);
    for (key, expected) in [
        ("VersionString", options.msi_version.as_str()),
        ("Publisher", PUBLISHER),
        ("InstalledProductName", name.as_str()),
        // Installed for the current user only.
        ("AssignmentType", "0"),
    ] {
        check(property(product, key) == expected, || {
            format!("{key} is {:?}, not {expected:?}", property(product, key))
        })?;
    }
    for key in ["HelpLink", "URLInfoAbout", "URLUpdateInfo"] {
        check(property(product, key).starts_with("https://"), || {
            format!("{key} isn't a link: {:?}", property(product, key))
        })?;
    }

    eprintln!("== Run nemoclaw from a new terminal");
    let empty = options.logs.join("deployment");
    fs::create_dir_all(&empty).map_err(|e| e.to_string())?;
    let (code, found) = in_new_terminal(&empty, &["where", "nemoclaw"])?;
    let first = found.lines().next().unwrap_or_default().trim();
    check(
        code == 0 && first.eq_ignore_ascii_case(&executable.display().to_string()),
        || {
            format!(
                "a new terminal finds nemoclaw at {found:?}, not {}",
                executable.display()
            )
        },
    )?;
    let (code, reported) = in_new_terminal(&empty, &["nemoclaw", "--version"])?;
    check(
        code == 0 && reported.trim() == format!("nemoclaw {}", options.version),
        || format!("nemoclaw --version exited {code}: {reported}"),
    )?;
    let (code, planned) = in_new_terminal(
        &empty,
        &["nemoclaw", "plan", "--destroy", "--output", "json"],
    )?;
    check(
        code == 1 && planned.contains(NO_STATE) && !planned.contains("bundle"),
        || {
            format!("nemoclaw plan --destroy didn't reach the deployment state: exited {code}: {planned}")
        },
    )?;

    eprintln!("== Refuse the older build over the current one");
    let (code, log) = installer.msiexec("/i", &options.older, "downgrade")?;
    check(code == INSTALL_FAILURE && log.contains(DOWNGRADE), || {
        format!("installing the older build exited {code} without the downgrade message")
    })?;
    let listed = installed()?;
    check(
        listed.len() == 1 && property(&listed[0].1, "VersionString") == options.msi_version,
        || format!("the refused downgrade changed the installed product: {listed:?}"),
    )?;
    check(executable.is_file(), || {
        "the refused downgrade removed nemoclaw.exe".into()
    })?;

    eprintln!("== Uninstall");
    installer.succeed("/x", &options.current, "uninstall")?;
    check(!folder.exists(), || {
        format!("{} remains after uninstalling", folder.display())
    })?;
    let path = user_path()?;
    check(occurrences(&path, &bin) == 0, || {
        format!("the user Path still names {bin}: {path}")
    })?;
    check(
        registry("HKCU\\Software\\NVIDIA\\NemoClaw", "InstallFolder")?.is_none(),
        || "HKCU\\Software\\NVIDIA\\NemoClaw remains after uninstalling".into(),
    )?;
    let listed = installed()?;
    check(listed.is_empty(), || {
        format!("products remain installed: {listed:?}")
    })?;
    eprintln!("The installer installed, recovered from a failed upgrade, upgraded, refused a downgrade, and uninstalled cleanly.");
    Ok(())
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
    fn path_entries_match_without_case_or_a_trailing_separator() {
        let value = r"C:\Windows;;C:\Users\me\AppData\Local\Programs\NemoClaw\bin\; D:\tools";
        let bin = r"c:\users\ME\AppData\Local\Programs\NemoClaw\bin";
        assert_eq!(occurrences(value, bin), 1);
        assert_eq!(occurrences(&format!("{value};{bin}"), bin), 2);
        assert_eq!(occurrences(r"C:\Windows", bin), 0);
        assert_eq!(path_entries(value).len(), 3);
    }

    #[test]
    fn reg_query_output_yields_the_value_data() {
        let output = "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin;C:\\Program Files\\x\r\n\r\n";
        assert_eq!(
            reg_value(output, "Path").as_deref(),
            Some("%USERPROFILE%\\bin;C:\\Program Files\\x")
        );
        assert_eq!(reg_value(output, "PATHEXT"), None);
        let empty =
            "HKEY_CURRENT_USER\\Software\\NVIDIA\\NemoClaw\r\n    InstallFolder    REG_SZ    \r\n";
        assert_eq!(reg_value(empty, "InstallFolder").as_deref(), Some(""));
    }

    #[test]
    fn registry_paths_expand_like_a_new_process() {
        let lookup = |name: &str| {
            name.eq_ignore_ascii_case("SystemRoot")
                .then(|| r"C:\Windows".to_owned())
        };
        assert_eq!(
            expand(r"%SystemRoot%\system32;%UNKNOWN%\bin;100%", lookup),
            r"C:\Windows\system32;%UNKNOWN%\bin;100%"
        );
        assert_eq!(expand("%%", lookup), "%%");
    }

    #[test]
    fn installer_logs_are_read_in_either_encoding() {
        let mut utf16 = vec![0xff, 0xfe];
        for unit in DOWNGRADE.encode_utf16() {
            utf16.extend(unit.to_le_bytes());
        }
        assert!(log_text(&utf16).contains(DOWNGRADE));
        assert!(log_text(DOWNGRADE.as_bytes()).contains(DOWNGRADE));
    }

    #[test]
    fn product_listing_groups_properties_by_product() {
        let listed = products(
            "{A}\tPublisher\tNVIDIA Corporation\r\n{A}\tVersionString\t0.1.12\r\n{B}\tPublisher\tOther\r\nnoise\r\n",
        );
        assert_eq!(listed.len(), 2);
        assert_eq!(property(&listed[0].1, "VersionString"), "0.1.12");
        assert_eq!(property(&listed[1].1, "Publisher"), "Other");
        assert_eq!(property(&listed[1].1, "VersionString"), "");
    }
}
