// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using Nvidia.NemoClaw.Bootstrapper;

public static class GatewayTlsControls
{
    public static int Main(string[] arguments)
    {
        if (arguments.Length == 1 && arguments[0] == "--gateway-tls-material")
            return NativeGatewayTls.Run();
        if (arguments.Length > 0 && arguments[0] == "--gateway-process")
            return NativeGatewayProcess.RunInstalled(arguments);
        if (arguments.Length == 1 && arguments[0] == "--fixture-wait")
        {
            System.Threading.Thread.Sleep(15000);
            return 0;
        }
        if (arguments.Length != 0) return 2;
        Run();
        return 0;
    }

    private static void Require(bool condition, string name)
    {
        if (!condition) throw new InvalidOperationException(name);
    }

    private static bool Trusted(X509Certificate2 leaf, X509Certificate2 ca, string purpose, DateTime time)
    {
        using var chain = new X509Chain();
        chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
        chain.ChainPolicy.CustomTrustStore.Add(ca);
        chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
        chain.ChainPolicy.DisableCertificateDownloads = true;
        chain.ChainPolicy.VerificationTime = time;
        chain.ChainPolicy.ApplicationPolicy.Add(new Oid(purpose));
        return chain.Build(leaf);
    }

    public static void Run()
    {
        var material = NativeGatewayTls.Generate();
        var other = NativeGatewayTls.Generate();
        using var ca = X509Certificate2.CreateFromPem(material.CaCertificate);
        using var otherCa = X509Certificate2.CreateFromPem(other.CaCertificate);
        using var server = X509Certificate2.CreateFromPem(material.ServerCertificate, material.ServerPrivateKey);
        using var client = X509Certificate2.CreateFromPem(material.ClientCertificate, material.ClientPrivateKey);
        Require(server.HasPrivateKey && client.HasPrivateKey, "Both leaf certificates must match their private keys.");
        Require(!ca.HasPrivateKey, "The CA private key must not leave the helper.");
        Require(Trusted(server, ca, "1.3.6.1.5.5.7.3.1", DateTime.UtcNow), "The server must validate against its session CA.");
        Require(Trusted(client, ca, "1.3.6.1.5.5.7.3.2", DateTime.UtcNow), "The client must validate against its session CA.");
        Require(!Trusted(server, otherCa, "1.3.6.1.5.5.7.3.1", DateTime.UtcNow), "A different session CA must be rejected.");
        Require(!Trusted(client, ca, "1.3.6.1.5.5.7.3.1", DateTime.UtcNow), "The client certificate cannot impersonate the server.");
        Require(!Trusted(server, ca, "1.3.6.1.5.5.7.3.2", DateTime.UtcNow), "The server certificate cannot impersonate the client.");
        Require(!Trusted(client, ca, "1.3.6.1.5.5.7.3.2", client.NotAfter.AddDays(1)), "Expired certificates must be rejected.");
        Require(client.Subject.Contains("OU=openshell-user", StringComparison.Ordinal) &&
            !client.Subject.Contains("openshell-admin", StringComparison.Ordinal), "The CLI receives only the OpenShell user role.");
        Require(material.ServerPrivateKey != other.ServerPrivateKey && material.ClientPrivateKey != other.ClientPrivateKey &&
            material.ClientPrivateKey != material.ServerPrivateKey, "Session and endpoint keys must be independent.");
        Require(!server.Extensions.OfType<X509BasicConstraintsExtension>().Single().CertificateAuthority &&
            !client.Extensions.OfType<X509BasicConstraintsExtension>().Single().CertificateAuthority,
            "Leaf keys must not authorize new certificates.");
        using var output = new MemoryStream();
        NativeGatewayTls.Write(output);
        Require(output.Length < 16 * 1024, "The pipe output must stay bounded.");
        using var document = JsonDocument.Parse(output.ToArray());
        var names = document.RootElement.EnumerateObject().Select(field => field.Name).OrderBy(name => name).ToArray();
        Require(names.SequenceEqual(new[] { "caCertificate", "clientCertificate", "clientPrivateKey", "schemaVersion", "serverCertificate", "serverPrivateKey" }),
            "Only the leaf keys and required certificates may leave the helper.");
        Require(document.RootElement.GetProperty("schemaVersion").GetInt32() == 1, "The pipe contract must be versioned.");
        Console.WriteLine("Gateway TLS controls: 14 passed; no keys written to disk or certificate stores.");
    }
}
