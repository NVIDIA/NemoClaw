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
    match gateway {
        crate::config::Gateway::Managed(managed) => {
            let cluster = managed.cluster()?;
            if cluster.authentication.profile
                == crate::config::KubernetesAuthenticationProfile::Development
            {
                Some(
                    "the development authentication profile is for isolated testing, and only NemoClaw gets its tokens",
                )
            } else if cluster.expose.is_none() {
                Some(
                    "the gateway isn't published; publish it with expose, or reach it with a separately authenticated OpenShell CLI",
                )
            } else {
                None
            }
        }
        crate::config::Gateway::External(external) => (external.credential.is_some()
            && external.oidc.is_none())
        .then_some(
            "the bundled OpenShell CLI cannot use this gateway's bearer token yet (https://github.com/NVIDIA/NemoClaw/issues/14880); use a separately authenticated OpenShell CLI where supported",
        ),
    }
}

/// The `openshell` arguments that register an OIDC gateway in the bundled
/// CLI's configuration and sign in, once.
pub(super) fn registration(document: &crate::config::Document) -> Option<Vec<String>> {
    let (issuer, client_id, audience, scopes) = match &document.spec.gateway {
        crate::config::Gateway::External(external) => {
            let oidc = external.oidc.as_ref()?;
            (
                oidc.issuer.clone(),
                oidc.client_id.clone(),
                oidc.audience.clone(),
                oidc.scopes.clone(),
            )
        }
        // A managed cluster's issuer settings are OpenShell's own table.
        crate::config::Gateway::Managed(managed) => {
            let client_id = managed.cluster()?.authentication.client_id.clone()?;
            let table = managed
                .config
                .as_ref()?
                .get(crate::managed::gateway_config::OIDC_TABLE)?;
            let field = |key: &str| table.get(key)?.as_str().map(str::to_owned);
            (field("issuer")?, client_id, field("audience"), None)
        }
    };
    let mut add = vec![
        "gateway".into(),
        "add".into(),
        document.spec.gateway.endpoint()?,
        format!("--name={}", document.workspace()),
        format!("--oidc-issuer={issuer}"),
        format!("--oidc-client-id={client_id}"),
    ];
    if let Some(audience) = audience {
        add.push(format!("--oidc-audience={audience}"));
    }
    if let Some(scopes) = scopes {
        add.push(format!("--oidc-scopes={scopes}"));
    }
    Some(add)
}

#[cfg(unix)]
impl Deployment {
    /// The bundled OpenShell CLI, set to run `args` against this deployment's
    /// gateway and workspace through OpenShell's documented selectors. Its
    /// configuration lives in the state directory, apart from the user's own.
    pub fn openshell(&self, args: &[std::ffi::OsString]) -> Result<std::process::Command, Error> {
        let (bundle, store) = self.open()?;
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
        // The referenced files, or a managed cluster's CA, which apply keeps
        // in the state directory; that gateway authenticates by token.
        let mut files: Vec<(&str, Option<std::path::PathBuf>)> = Vec::new();
        if let Some(tls) = gateway.tls() {
            for (name, reference) in [
                ("ca.crt", Some(&tls.ca)),
                ("tls.crt", tls.certificate.as_ref()),
                ("tls.key", tls.key.as_ref()),
            ] {
                let path = match reference {
                    Some(reference) => Some(self.secrets.resolve(&reference.env)?.into()),
                    None => None,
                };
                files.push((name, path));
            }
        } else if gateway.as_kubernetes().is_some() {
            let ca = self.state_directory.join("kubernetes/client/ca.crt");
            files.push(("ca.crt", Some(ca)));
        }
        if !files.is_empty() {
            // Link them into OpenShell's mTLS layout.
            let mtls = profile.join("mtls");
            private_directory(&mtls)?;
            for (name, path) in files {
                let link = mtls.join(name);
                let _ = fs::remove_file(&link);
                if let Some(path) = path {
                    let target = std::path::absolute(path)
                        .map_err(|_| Error::State("cannot resolve TLS file path"))?;
                    std::os::unix::fs::symlink(target, &link)
                        .map_err(|_| Error::State("cannot link TLS file for OpenShell"))?;
                }
            }
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
        Ok(command)
    }
}
