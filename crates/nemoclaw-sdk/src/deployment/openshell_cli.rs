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
        crate::config::Gateway::Managed(managed) => {
            return managed
                .cluster()
                .is_some_and(|cluster| {
                    cluster.authentication.profile
                        == crate::config::KubernetesAuthenticationProfile::Development
                })
                .then_some("the development authentication profile is for isolated testing; only NemoClaw gets its tokens");
        }
        crate::config::Gateway::External(external) => {
            external.credential.is_some() && external.oidc.is_none()
        }
    };
    bearer.then_some("the bundled OpenShell CLI cannot use this gateway's bearer token yet (https://github.com/NVIDIA/NemoClaw/issues/14880); use a separately authenticated OpenShell CLI where supported")
}

/// The `openshell` arguments that register an OIDC gateway in the bundled
/// CLI's configuration and sign in, once.
pub(super) fn registration(document: &crate::config::Document) -> Option<Vec<String>> {
    let (issuer, client_id, audience, scopes) = match &document.spec.gateway {
        crate::config::Gateway::External(external) => {
            let oidc = external.oidc.as_ref()?;
            let client_id = Some(oidc.client_id.clone());
            (
                oidc.issuer.clone(),
                client_id,
                oidc.audience.clone(),
                oidc.scopes.clone(),
            )
        }
        // The gateway's own OIDC settings; OpenShell defaults the client ID.
        crate::config::Gateway::Managed(managed) => {
            let table = managed
                .config
                .as_ref()?
                .get(crate::managed::gateway_config::OIDC_TABLE)?;
            let field = |key: &str| table.get(key)?.as_str().map(str::to_owned);
            (field("issuer")?, None, field("audience"), None)
        }
    };
    let mut add = vec![
        "gateway".into(),
        "add".into(),
        document.spec.gateway.endpoint()?,
        format!("--name={}", document.workspace()),
        format!("--oidc-issuer={issuer}"),
    ];
    add.extend(client_id.map(|id| format!("--oidc-client-id={id}")));
    add.extend(audience.map(|audience| format!("--oidc-audience={audience}")));
    add.extend(scopes.map(|scopes| format!("--oidc-scopes={scopes}")));
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
        } else if gateway.as_kubernetes().is_some() {
            // Apply keeps the cluster gateway's CA in the state directory.
            let mtls = profile.join("mtls");
            private_directory(&mtls)?;
            let link = mtls.join("ca.crt");
            let _ = fs::remove_file(&link);
            let target = std::path::absolute(self.state_directory.join("kubernetes/client/ca.crt"))
                .map_err(|_| Error::State("cannot resolve TLS file path"))?;
            std::os::unix::fs::symlink(target, &link)
                .map_err(|_| Error::State("cannot link TLS file for OpenShell"))?;
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
