// This file is part of the tf-provider project
//
// Copyright (C) ANEO, 2024-2024. All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License")
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

//! [`Server`] module

use std::collections::HashMap;
use std::env;
use std::fs::File;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use base64::Engine;
use futures::TryFutureExt;
use rcgen::{BasicConstraints, IsCa};
use time::ext::NumericalDuration;
use tokio::try_join;
use tokio_stream::wrappers::TcpListenerStream;
use tokio_util::sync::CancellationToken;
use tonic::transport::{Identity, ServerTlsConfig};
use tower_http::trace::TraceLayer;

use crate::function::DynamicFunction;
use crate::plugin::grpc_broker_server::GrpcBrokerServer;
use crate::plugin::grpc_controller_server::GrpcControllerServer;
use crate::plugin::grpc_stdio_server::GrpcStdioServer;
use crate::schema::FunctionSchema;
use crate::tfplugin6::provider_server::ProviderServer;

use crate::data_source::DynamicDataSource;
use crate::plugin::GrpcIo;
use crate::provider::DynamicProvider;
use crate::resource::DynamicResource;
use crate::{schema::Schema, Diagnostics};

const CORE_PROTOCOL_VERSION: u8 = 1;

/// TF provider server
pub(crate) struct Server {
    pub(crate) provider: Box<dyn DynamicProvider>,
    pub(crate) io: GrpcIo,
    pub(crate) cancellation_token: CancellationToken,

    pub(crate) init_diags: Diagnostics,
    pub(crate) schema: Option<Schema>,
    pub(crate) meta_schema: Option<Schema>,
    pub(crate) resources: HashMap<String, (Box<dyn DynamicResource>, Schema)>,
    pub(crate) data_sources: HashMap<String, (Box<dyn DynamicDataSource>, Schema)>,
    pub(crate) functions: HashMap<String, (Box<dyn DynamicFunction>, FunctionSchema)>,
}

impl Server {
    pub fn new(provider_name: String, provider: Box<dyn DynamicProvider>) -> Self {
        let mut diags = Default::default();
        let mut has_errors = false;
        let mut set_error = || {
            has_errors = true;
            None
        };
        let schema = provider.schema(&mut diags).or_else(&mut set_error);
        let meta_schema = provider.meta_schema(&mut diags).or_else(&mut set_error);
        let resources = provider
            .get_resources(&mut diags)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(name, resource)| {
                let schema = resource.schema(&mut diags).or_else(&mut set_error)?;
                Some((format!("{}_{}", provider_name, name), (resource, schema)))
            })
            .collect();
        let data_sources = provider
            .get_data_sources(&mut diags)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(name, data_source)| {
                let schema = data_source.schema(&mut diags).or_else(&mut set_error)?;
                Some((format!("{}_{}", provider_name, name), (data_source, schema)))
            })
            .collect();
        let functions = provider
            .get_functions(&mut diags)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(name, function)| match function.schema(&mut diags) {
                Some(schema) => Some((name, (function, schema))),
                None => {
                    has_errors = true;
                    None
                }
            })
            .collect();

        if has_errors {
            diags.internal_error()
        }

        Self {
            provider,
            io: Default::default(),
            cancellation_token: Default::default(),
            init_diags: diags,
            schema,
            meta_schema,
            resources,
            data_sources,
            functions,
        }
    }

    pub(crate) fn get_resource<'a>(
        &'a self,
        diags: &mut Diagnostics,
        name: &str,
    ) -> Option<&'a dyn DynamicResource> {
        if let Some(resource) = self.resources.get(name) {
            Some(resource.0.as_ref())
        } else {
            diags.root_error_short(format!("Could not find resource `{}` in provider", name));
            None
        }
    }
    pub(crate) fn get_data_source<'a>(
        &'a self,
        diags: &mut Diagnostics,
        name: &str,
    ) -> Option<&'a dyn DynamicDataSource> {
        if let Some(data_source) = self.data_sources.get(name) {
            Some(data_source.0.as_ref())
        } else {
            diags.root_error_short(format!("Could not find data source `{}` in provider", name));
            None
        }
    }
    pub(crate) fn get_function<'a>(
        &'a self,
        diags: &mut Diagnostics,
        name: &str,
    ) -> Option<&'a dyn DynamicFunction> {
        if let Some(function) = self.functions.get(name) {
            Some(function.0.as_ref())
        } else {
            diags.root_error_short(format!("Could not find function `{}` in provider", name));
            None
        }
    }
}

/// Serve the provider
///
/// # Arguments
///
/// * `name` - Name of the provider to serve
/// * `provider` - Provider to be served
///
/// # Cancel Safety
///
/// It is not safe to cancel the output future
///
/// # See Also
///
/// [`serve_dynamic`]
pub async fn serve<U: ToString, V: DynamicProvider>(name: U, provider: V) -> Result<()> {
    serve_dynamic(name.to_string(), Box::new(provider)).await
}
/// Serve the provider
///
/// # Arguments
///
/// * `name` - Name of the provider to serve
/// * `provider` - Provider to be served
///
/// # Cancel Safety
///
/// It is not safe to cancel the output future
///
/// # See Also
///
/// [`serve`]
pub async fn serve_dynamic(name: String, provider: Box<dyn DynamicProvider>) -> Result<()> {
    let server = Arc::new(Server::new(name, provider));
    let addrs = SockAddrIter::new()?;
    let (tcp_stream, endpoint) = listen(addrs)?;

    if let Ok(path) = env::var("PLUGIN_LOG_FILE") {
        let log_file = File::create(path)?;
        tracing_subscriber::fmt()
            .with_max_level(tracing::Level::TRACE)
            .with_ansi(false)
            .with_writer(Mutex::new(log_file))
            .init();
    }

    let tls_config = TlsConfig::new()?;

    let serve = tls_config
        .builder()?
        .layer(TraceLayer::new_for_grpc())
        .add_service(GrpcBrokerServer::new(server.clone()))
        .add_service(GrpcControllerServer::new(server.clone()))
        .add_service(GrpcStdioServer::new(server.clone()))
        .add_service(ProviderServer::new(server.clone()))
        .serve_with_incoming_shutdown(
            tokio_stream::StreamExt::map(tcp_stream, without_delay),
            server.cancellation_token.cancelled(),
        );

    async fn info(endpoint: &str, der: &[u8]) -> Result<()> {
        println!(
            "{}|6|tcp|{}|grpc|{}",
            CORE_PROTOCOL_VERSION,
            endpoint,
            base64::engine::general_purpose::STANDARD_NO_PAD.encode(der),
        );
        Ok(())
    }

    try_join!(
        serve.map_err(|e| anyhow!(e)),
        info(&endpoint, tls_config.cert.as_slice()),
    )?;

    Ok(())
}

#[derive(Copy, Clone)]
struct SockAddrIter {
    ip: IpAddr,
    port: u16,
    port_max: u16,
}

impl SockAddrIter {
    fn new_with_ip(ip: IpAddr) -> Result<Self> {
        let port_min = if let Ok(port) = env::var("PLUGIN_MIN_PORT") {
            port.parse()?
        } else {
            1025_u16
        };
        let port_max = if let Ok(port) = env::var("PLUGIN_MAX_PORT") {
            port.parse()?
        } else {
            65535_u16
        };

        Ok(Self {
            ip,
            port: std::cmp::min(port_min, port_max),
            port_max: std::cmp::max(port_min, port_max),
        })
    }
    fn new() -> Result<Self> {
        Self::new_with_ip(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)))
    }
}

impl Iterator for SockAddrIter {
    type Item = SocketAddr;
    fn next(&mut self) -> Option<Self::Item> {
        if self.port_max == 0 {
            return None;
        }
        let port = self.port;
        if self.port == self.port_max {
            self.port_max = 0;
        } else {
            self.port += 1;
        }
        Some(SocketAddr::new(self.ip, port))
    }
}

impl std::net::ToSocketAddrs for SockAddrIter {
    type Iter = Self;
    fn to_socket_addrs(&self) -> std::io::Result<Self::Iter> {
        Ok(*self)
    }
}

/// An accepted provider connection, ready to answer OpenTofu.
///
/// gRPC replies are small writes; without `TCP_NODELAY`, each waits on
/// Nagle's algorithm and the client's delayed acknowledgment, about 40 ms
/// per provider call.
fn without_delay(stream: std::io::Result<tokio::net::TcpStream>) -> std::io::Result<tokio::net::TcpStream> {
    let stream = stream?;
    stream.set_nodelay(true)?;
    Ok(stream)
}

fn listen(addrs: SockAddrIter) -> Result<(TcpListenerStream, String)> {
    let listener = std::net::TcpListener::bind(addrs)?;
    listener.set_nonblocking(true)?;
    let endpoint = listener.local_addr()?.to_string();
    let listener = tokio::net::TcpListener::from_std(listener)?;
    Ok((TcpListenerStream::new(listener), endpoint))
}

struct TlsConfig {
    server: Option<ServerTlsConfig>,
    cert: Vec<u8>,
}

impl TlsConfig {
    fn new() -> Result<Self> {
        let env_cert = env::var("PLUGIN_CLIENT_CERT").unwrap_or_default();
        if env_cert.is_empty() {
            return Ok(Self {
                server: None,
                cert: Default::default(),
            });
        }

        // Read the client certificate
        let client_cert = tonic::transport::Certificate::from_pem(env_cert);

        // Parameters to generate the server certificate
        let mut cp = rcgen::CertificateParams::new(["localhost".to_string()])?;
        cp.not_before = time::OffsetDateTime::now_utc().saturating_sub(30.seconds());
        cp.not_after = time::OffsetDateTime::now_utc().saturating_add((30 * 365).days());
        let mut dn = rcgen::DistinguishedName::new();
        dn.push(rcgen::DnType::OrganizationName, "Hashicorp");
        dn.push(rcgen::DnType::CommonName, "localhost");
        cp.distinguished_name = dn;
        cp.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        cp.key_usages = vec![
            rcgen::KeyUsagePurpose::DigitalSignature,
            rcgen::KeyUsagePurpose::KeyEncipherment,
            rcgen::KeyUsagePurpose::KeyAgreement,
            rcgen::KeyUsagePurpose::KeyCertSign,
        ];
        cp.extended_key_usages = vec![
            rcgen::ExtendedKeyUsagePurpose::ClientAuth,
            rcgen::ExtendedKeyUsagePurpose::ServerAuth,
        ];
        cp.key_identifier_method = rcgen::KeyIdMethod::Sha512;

        // Generate the server certificate and its keys
        let keypair = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P384_SHA384)?;
        let server_cert = cp.self_signed(&keypair)?;

        let tls_config = ServerTlsConfig::new()
            .client_ca_root(client_cert)
            .client_auth_optional(true)
            .identity(Identity::from_pem(
                server_cert.pem(),
                keypair.serialize_pem(),
            ));

        Ok(Self {
            server: Some(tls_config),
            cert: server_cert.der().to_vec(),
        })
    }

    fn builder(&self) -> Result<tonic::transport::server::Server> {
        if let Some(ref tls_config) = &self.server {
            Ok(tonic::transport::server::Server::builder().tls_config(tls_config.clone())?)
        } else {
            Ok(tonic::transport::server::Server::builder())
        }
    }
}

#[cfg(test)]
mod delay_tests {
    #[tokio::test]
    async fn accepted_connections_send_replies_without_delay() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let _client = tokio::net::TcpStream::connect(address).await.unwrap();
        let (accepted, _) = listener.accept().await.unwrap();
        let accepted = super::without_delay(Ok(accepted)).unwrap();
        // Without TCP_NODELAY, each small gRPC reply waits on Nagle's
        // algorithm and the client's delayed acknowledgment: about 40 ms.
        assert!(accepted.nodelay().unwrap());
    }
}
