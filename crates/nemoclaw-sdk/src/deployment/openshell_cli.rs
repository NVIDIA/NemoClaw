// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

/// An OpenShell process configured for one deployment. Keep this value alive
/// until the process exits; dropping it removes its private configuration.
pub struct OpenShellCommand {
    command: tokio::process::Command,
    _configuration: tempfile::TempDir,
}

impl OpenShellCommand {
    pub fn command(&mut self) -> &mut tokio::process::Command {
        &mut self.command
    }
}

impl Deployment {
    /// Prepare the bundled CLI for a plaintext or mTLS gateway in saved state.
    pub fn openshell(&self) -> Result<OpenShellCommand, Error> {
        if cfg!(windows) {
            return Err(Error::Bundle(
                "the pinned OpenShell release publishes no Windows CLI; use NemoClaw inside WSL2",
            ));
        }
        if !crate::bundle::openshell_available() {
            return Err(Error::Bundle(
                "the pinned OpenShell release publishes no CLI for this platform; use a supported Linux or Apple silicon host",
            ));
        }
        if !self.state_directory.join("intent.json").is_file() {
            return Err(Error::State(
                "deployment intent is unavailable; apply a deployment first",
            ));
        }
        let (bundle, store) = self.open()?;
        let record = store
            .load()?
            .ok_or(Error::State("deployment intent is unavailable"))?;
        if record.destroyed() || record.destroying() {
            return Err(Error::State(
                "deployment is being destroyed or has been destroyed",
            ));
        }
        let document = &record.document;
        if !supported(document) {
            return Err(Error::State(
                "nemoclaw openshell currently supports plaintext and mTLS gateways; bearer-token and managed Kubernetes gateways require a separately configured OpenShell CLI (issue #14855)",
            ));
        }
        let binary = bundle
            .directory
            .join("libexec")
            .join(crate::bundle::executable("openshell"));
        if !bundle.manifest.files.contains_key("libexec/openshell") {
            return Err(Error::Bundle(
                "bundle lacks its pinned OpenShell CLI; install a complete bundle",
            ));
        }
        let state = std::path::absolute(&self.state_directory)
            .map_err(|_| Error::State("cannot resolve deployment state directory"))?;
        let root = state.join("openshell");
        crate::kubernetes::receipt::private_directory(&root)?;
        let configuration = tempfile::tempdir_in(&root)
            .map_err(|_| Error::State("cannot create private OpenShell configuration"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(configuration.path(), fs::Permissions::from_mode(0o700))
                .map_err(|_| Error::State("cannot protect private OpenShell configuration"))?;
        }
        let workspace = document.workspace();
        let gateway = &document.spec.gateway;
        // The certificate names and XDG layout are OpenShell's documented
        // mTLS interface. Metadata and token files remain OpenShell-owned.
        if let Some(tls) = gateway.tls() {
            let directory = configuration
                .path()
                .join("openshell/gateways")
                .join(&workspace)
                .join("mtls");
            crate::kubernetes::receipt::private_directory(&directory)?;
            for (name, reference) in [
                ("ca.crt", Some(&tls.ca)),
                ("tls.crt", tls.certificate.as_ref()),
                ("tls.key", tls.key.as_ref()),
            ] {
                if let Some(reference) = reference {
                    let path = self.secrets.resolve(&reference.env)?;
                    let bytes = fs::read(path)
                        .map_err(|_| Error::State("cannot read OpenShell TLS credential file"))?;
                    atomic_write(&directory.join(name), &bytes)?;
                }
            }
        }
        let mut command = tokio::process::Command::new(binary);
        command
            .env("XDG_CONFIG_HOME", configuration.path())
            .env("XDG_STATE_HOME", configuration.path().join("state"))
            .env("XDG_DATA_HOME", configuration.path().join("data"))
            .env(
                "OPENSHELL_SYSTEM_GATEWAY_DIR",
                configuration.path().join("system"),
            )
            .env("OPENSHELL_GATEWAY", &workspace)
            .env(
                "OPENSHELL_GATEWAY_ENDPOINT",
                gateway
                    .endpoint()
                    .ok_or(Error::State("gateway has no endpoint"))?,
            )
            .env("OPENSHELL_WORKSPACE", &workspace)
            .env_remove("OPENSHELL_GATEWAY_INSECURE");
        Ok(OpenShellCommand {
            command,
            _configuration: configuration,
        })
    }
}

pub(super) fn supported(document: &Document) -> bool {
    let gateway = &document.spec.gateway;
    gateway.as_kubernetes().is_none()
        && gateway.credential().is_none()
        && gateway.endpoint().is_some_and(|endpoint| {
            endpoint.starts_with("http://")
                || gateway
                    .tls()
                    .is_some_and(|tls| tls.certificate.is_some() && tls.key.is_some())
        })
}

#[cfg(all(test, unix, not(all(target_os = "macos", target_arch = "x86_64"))))]
mod tests {
    use super::*;
    use crate::bundle::{Manifest, executable, hash_file, required_files};
    use std::fs;

    fn deployment(root: &Path, mtls: bool) -> (Deployment, String) {
        let mut document =
            Document::parse(include_bytes!("../../../../examples/agents/openclaw.yaml").as_slice())
                .unwrap();
        if mtls {
            let crate::config::Gateway::External(gateway) = &mut document.spec.gateway else {
                unreachable!()
            };
            gateway.endpoint = "https://gateway.example.com".into();
            gateway.tls = Some(
                serde_json::from_value(serde_json::json!({
                    "ca":{"env":"OSH_TEST_CA"},
                    "certificate":{"env":"OSH_TEST_CERT"},
                    "key":{"env":"OSH_TEST_KEY"}
                }))
                .unwrap(),
            );
        }
        let workspace = document.workspace();
        let state = root.join("state");
        Store::open(&state)
            .unwrap()
            .save(&Record::new(document).unwrap())
            .unwrap();
        let bundle = root.join("bundle");
        let mut manifest = Manifest {
            version: "0.1.0".into(),
            rust: "test".into(),
            opentofu: crate::compile::OPENTOFU_VERSION.into(),
            files: Default::default(),
        };
        let script = "#!/bin/sh\nprintf '%s\\n' \"$OPENSHELL_GATEWAY_ENDPOINT\" \"$OPENSHELL_WORKSPACE\" \"$XDG_CONFIG_HOME\" \"$OPENSHELL_GATEWAY\"\nprintf '%s\\n' \"$@\"\nprintf 'upstream stderr\\n' >&2\nexit 37\n";
        let openshell = format!("libexec/{}", executable("openshell"));
        for name in required_files("0.1.0")
            .unwrap()
            .into_iter()
            .chain([openshell.clone()])
        {
            let path = bundle.join(&name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            if name == openshell {
                crate::executable::write_executable(&path, script);
            } else {
                fs::write(&path, b"fixture").unwrap();
            }
            manifest.files.insert(name, hash_file(&path).unwrap());
        }
        fs::write(
            bundle.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        (Deployment::new(&state, &bundle), workspace)
    }

    #[tokio::test]
    async fn plaintext_cli_uses_saved_selection_and_preserves_arguments_streams_and_exit_status() {
        let root = tempfile::tempdir().unwrap();
        let (deployment, workspace) = deployment(root.path(), false);
        let mut process = deployment.openshell().unwrap();
        let output = process
            .command()
            .args(["sandbox", "exec", "--", "a b", "--verbose"])
            .output()
            .await
            .unwrap();
        assert_eq!(output.status.code(), Some(37));
        let text = String::from_utf8(output.stdout).unwrap();
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines[0], "http://127.0.0.1:17671");
        assert_eq!(lines[1], workspace);
        let configuration = PathBuf::from(lines[2]);
        assert!(
            configuration
                .canonicalize()
                .unwrap()
                .starts_with(root.path().canonicalize().unwrap().join("state/openshell"))
        );
        assert_eq!(&lines[4..], ["sandbox", "exec", "--", "a b", "--verbose"]);
        assert_eq!(output.stderr, b"upstream stderr\n");
        drop(process);
        assert!(
            !configuration.exists(),
            "remove private configuration when the child has exited"
        );
    }

    struct Files(BTreeMap<String, String>);
    impl Secrets for Files {
        fn resolve(&self, name: &str) -> Result<String, crate::ObservationError> {
            self.0
                .get(name)
                .cloned()
                .ok_or(crate::ObservationError::Authentication)
        }
    }

    #[tokio::test]
    async fn mtls_credentials_are_private_isolated_and_removed_after_use() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let (deployment, workspace) = deployment(root.path(), true);
        let mut files = BTreeMap::new();
        for (variable, name, bytes) in [
            ("OSH_TEST_CA", "ca.crt", "CA sentinel"),
            ("OSH_TEST_CERT", "tls.crt", "certificate sentinel"),
            ("OSH_TEST_KEY", "tls.key", "private key sentinel"),
        ] {
            let path = root.path().join(name);
            fs::write(&path, bytes).unwrap();
            files.insert(variable.into(), path.to_str().unwrap().into());
        }
        let deployment = deployment.with_secrets(Arc::new(Files(files)));
        let mut process = deployment.openshell().unwrap();
        let output = process.command().output().await.unwrap();
        let text = String::from_utf8(output.stdout).unwrap();
        let lines: Vec<_> = text.lines().collect();
        assert_eq!(lines[0], "https://gateway.example.com");
        assert_eq!(lines[1], workspace);
        let config = PathBuf::from(lines[2]);
        assert_eq!(
            fs::metadata(&config).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let mtls = config
            .join("openshell/gateways")
            .join(&workspace)
            .join("mtls");
        for name in ["ca.crt", "tls.crt", "tls.key"] {
            assert_eq!(
                fs::read(mtls.join(name)).unwrap(),
                fs::read(root.path().join(name)).unwrap()
            );
            assert_eq!(
                fs::metadata(mtls.join(name)).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        drop(process);
        assert!(!config.exists());
        assert!(
            root.path().join("tls.key").exists(),
            "retain the caller's original key"
        );
    }

    #[test]
    fn bearer_credentials_are_rejected_without_creating_configuration_or_changing_intent() {
        let root = tempfile::tempdir().unwrap();
        let (deployment, _) = deployment(root.path(), true);
        let store = Store::open(&deployment.state_directory).unwrap();
        let mut record = store.load().unwrap().unwrap();
        let crate::config::Gateway::External(gateway) = &mut record.document.spec.gateway else {
            unreachable!()
        };
        gateway.credential = Some(SecretRef {
            env: "OIDC_TOKEN".into(),
        });
        record.digest = record.document.digest();
        store.save(&record).unwrap();
        drop(store);
        let before = fs::read(deployment.state_directory.join("intent.json")).unwrap();
        let error = deployment
            .openshell()
            .err()
            .expect("bearer credentials are outside this command's scope");
        assert!(error.to_string().contains("bearer-token"), "{error}");
        assert!(!deployment.state_directory.join("openshell").exists());
        assert_eq!(
            fs::read(deployment.state_directory.join("intent.json")).unwrap(),
            before
        );
    }

    #[test]
    fn missing_mtls_files_fail_without_leaving_copied_credentials() {
        let root = tempfile::tempdir().unwrap();
        let (deployment, _) = deployment(root.path(), true);
        assert!(
            deployment
                .with_secrets(Arc::new(Files(BTreeMap::new())))
                .openshell()
                .is_err()
        );
        assert_eq!(
            fs::read_dir(root.path().join("state/openshell"))
                .unwrap()
                .count(),
            0
        );
    }

    #[test]
    fn missing_deployment_does_not_create_state() {
        let root = tempfile::tempdir().unwrap();
        let state = root.path().join("absent");
        assert!(Deployment::new(&state, root.path()).openshell().is_err());
        assert!(!state.exists());
    }
}
