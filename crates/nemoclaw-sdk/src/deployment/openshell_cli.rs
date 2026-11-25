// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[cfg(unix)]
use super::{Deployment, Error};
#[cfg(unix)]
use crate::kubernetes::receipt::private_directory;
#[cfg(unix)]
use std::fs;

/// Whether this client can represent the gateway's authentication with the
/// pinned CLI. A client certificate does not supply a required bearer token.
pub(super) fn unavailable(gateway: &crate::config::Gateway) -> Option<&'static str> {
    if !crate::bundle::openshell_available() {
        return Some(
            "OpenShell publishes no CLI for this platform; use a supported Linux or Apple silicon client, or WSL 2 on Windows",
        );
    }
    let bearer = match gateway {
        crate::config::Gateway::Managed(managed) => !matches!(
            managed.target,
            crate::config::ManagedTarget::Docker(_) | crate::config::ManagedTarget::Podman(_)
        ),
        crate::config::Gateway::External(external) => {
            external.credential.is_some() && external.oidc.is_none()
        }
    };
    bearer.then_some("the bundled OpenShell CLI cannot use this gateway's bearer token; use a separately authenticated OpenShell CLI where supported")
}

#[cfg(unix)]
impl Deployment {
    /// The bundled OpenShell CLI, set to run `args` against this deployment's
    /// gateway and workspace through OpenShell's documented selectors. Its
    /// configuration lives in the state directory, apart from the user's own.
    /// When the gateway sets `oidc` and OpenShell has not registered it, also
    /// returns the `openshell` arguments that register it and sign in.
    pub fn openshell(
        &self,
        args: &[std::ffi::OsString],
    ) -> Result<(std::process::Command, Option<Vec<String>>), Error> {
        let (bundle, store) = self.open()?;
        if !bundle.manifest.files.contains_key("libexec/openshell") {
            return Err(Error::Bundle(
                "the bundle has no OpenShell CLI; OpenShell publishes none for this platform",
            ));
        }
        let document = store
            .load()?
            .ok_or(Error::State("no deployment; apply one first"))?
            .document;
        let gateway = &document.spec.gateway;
        if let Some(reason) = unavailable(gateway) {
            return Err(Error::State(reason));
        }
        let endpoint = gateway.endpoint().ok_or(Error::State(
            "the gateway has no endpoint for the OpenShell CLI to reach",
        ))?;
        let workspace = document.workspace();
        let configuration = std::path::absolute(self.state_directory.join("openshell"))
            .map_err(|_| Error::State("cannot resolve state directory"))?;
        let profile = configuration.join("openshell/gateways").join(&workspace);
        private_directory(&profile)?;
        if let Some(tls) = gateway.tls() {
            // Link the referenced files into OpenShell's mTLS layout.
            let mtls = profile.join("mtls");
            private_directory(&mtls)?;
            for (name, reference) in [
                ("ca.crt", Some(&tls.ca)),
                ("tls.crt", tls.certificate.as_ref()),
                ("tls.key", tls.key.as_ref()),
            ] {
                let link = mtls.join(name);
                let _ = fs::remove_file(&link);
                if let Some(reference) = reference {
                    let target = std::path::absolute(self.secrets.resolve(&reference.env)?)
                        .map_err(|_| Error::State("cannot resolve TLS file path"))?;
                    std::os::unix::fs::symlink(target, &link)
                        .map_err(|_| Error::State("cannot link TLS file for OpenShell"))?;
                }
            }
        }
        // OpenShell signs in to an OIDC gateway when it is registered; until
        // then, give the arguments that register this one.
        let mut sign_in = None;
        if let crate::config::Gateway::External(external) = gateway
            && let Some(oidc) = &external.oidc
            && !profile.join("metadata.json").exists()
            // Login guidance must not intercept upstream gateway management
            // or help, including after global options. OpenShell still owns
            // argument parsing and all authentication decisions.
            && !args.iter().any(|arg| matches!(arg.to_str(), Some("gateway" | "--help" | "-h" | "--version" | "-V")))
        {
            let mut add = vec![
                "gateway".into(),
                "add".into(),
                endpoint.clone(),
                format!("--name={workspace}"),
                format!("--oidc-issuer={}", oidc.issuer),
                format!("--oidc-client-id={}", oidc.client_id),
            ];
            if let Some(audience) = &oidc.audience {
                add.push(format!("--oidc-audience={audience}"));
            }
            if let Some(scopes) = &oidc.scopes {
                add.push(format!("--oidc-scopes={scopes}"));
            }
            if add.iter().any(|arg| arg.chars().any(char::is_control)) {
                return Err(Error::State(
                    "gateway OIDC login settings must not contain control characters",
                ));
            }
            sign_in = Some(add);
        }
        let mut command = std::process::Command::new(bundle.directory.join("libexec/openshell"));
        command
            .args(args)
            .env("XDG_CONFIG_HOME", &configuration)
            .env("OPENSHELL_SYSTEM_GATEWAY_DIR", configuration.join("system"))
            .env("OPENSHELL_GATEWAY", &workspace)
            .env("OPENSHELL_GATEWAY_ENDPOINT", &endpoint)
            .env("OPENSHELL_WORKSPACE", &workspace)
            .env_remove("OPENSHELL_GATEWAY_INSECURE");
        Ok((command, sign_in))
    }
}
