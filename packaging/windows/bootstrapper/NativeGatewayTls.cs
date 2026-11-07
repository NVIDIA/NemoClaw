// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

using System;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;

namespace Nvidia.NemoClaw.Bootstrapper;

// This short-lived helper returns session keys only through the launcher's pipe.
// It never changes a certificate store or writes a key to a log or temporary file.
internal static class NativeGatewayTls
{
    internal sealed class Material
    {
        public int SchemaVersion => 1;
        public string CaCertificate { get; init; } = "";
        public string ServerCertificate { get; init; } = "";
        public string ServerPrivateKey { get; init; } = "";
        public string ClientCertificate { get; init; } = "";
        public string ClientPrivateKey { get; init; } = "";
    }

    [DllImport("kernel32.dll", ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern IntPtr GetStdHandle(int handle);

    [DllImport("kernel32.dll", ExactSpelling = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    private static extern uint GetFileType(IntPtr handle);

    internal static int Run()
    {
        // Refuse a terminal or redirected disk file before generating secrets.
        if (GetFileType(GetStdHandle(-11)) != 3) return 2;
        try
        {
            using var output = Console.OpenStandardOutput();
            Write(output);
            return 0;
        }
        catch (Exception) { return 1; }
    }

    internal static void Write(Stream output)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(Generate(), new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        });
        try
        {
            if (bytes.Length > 16 * 1024) throw new InvalidOperationException("Gateway TLS material exceeds its bound.");
            output.Write(bytes);
            output.Flush();
        }
        finally { CryptographicOperations.ZeroMemory(bytes); }
    }

    internal static Material Generate()
    {
        var notBefore = DateTimeOffset.UtcNow.AddMinutes(-5);
        var notAfter = notBefore.AddYears(1);
        using var caKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var caRequest = new CertificateRequest("CN=openshell-ca", caKey, HashAlgorithmName.SHA256);
        caRequest.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, true, 0, true));
        caRequest.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.CrlSign, true));
        caRequest.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(caRequest.PublicKey, false));
        using var ca = caRequest.CreateSelfSigned(notBefore, notAfter);

        using var serverKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var serverRequest = Leaf("CN=openshell-server", serverKey, "1.3.6.1.5.5.7.3.1");
        var names = new SubjectAlternativeNameBuilder();
        names.AddDnsName("localhost");
        names.AddIpAddress(IPAddress.Loopback);
        names.AddIpAddress(IPAddress.IPv6Loopback);
        serverRequest.CertificateExtensions.Add(names.Build());
        using var server = serverRequest.Create(ca, notBefore, notAfter, Serial());

        using var clientKey = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        // OpenShell derives the CLI user's role from the verified certificate OU.
        var clientRequest = Leaf("CN=openshell-client, OU=openshell-user", clientKey, "1.3.6.1.5.5.7.3.2");
        using var client = clientRequest.Create(ca, notBefore, notAfter, Serial());
        return new Material
        {
            CaCertificate = ca.ExportCertificatePem(),
            ServerCertificate = server.ExportCertificatePem(),
            ServerPrivateKey = serverKey.ExportPkcs8PrivateKeyPem(),
            ClientCertificate = client.ExportCertificatePem(),
            ClientPrivateKey = clientKey.ExportPkcs8PrivateKeyPem(),
        };
    }

    private static CertificateRequest Leaf(string subject, ECDsa key, string purpose)
    {
        var request = new CertificateRequest(subject, key, HashAlgorithmName.SHA256);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature, true));
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection { new Oid(purpose) }, true));
        request.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(request.PublicKey, false));
        return request;
    }

    private static byte[] Serial()
    {
        var serial = RandomNumberGenerator.GetBytes(16);
        serial[0] = (byte)((serial[0] & 0x7f) | 1);
        return serial;
    }
}
