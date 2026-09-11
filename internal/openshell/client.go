// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package openshell

import (
	"fmt"
	"net/url"
	"os"
	"time"

	"github.com/NVIDIA/NemoClaw/internal/config"
	v1 "github.com/NVIDIA/OpenShell/sdk/go/openshell/v1"
	ostypes "github.com/NVIDIA/OpenShell/sdk/go/openshell/v1/types"
)

func Connect(g config.Gateway) (*v1.Client, error) {
	if err := config.ValidateEndpoint(g.Endpoint, true); err != nil {
		return nil, err
	}
	u, _ := url.Parse(g.Endpoint)
	c := v1.Config{Address: g.Endpoint, Auth: v1.NoAuth(), Timeout: 30 * time.Second, RetryPolicy: &ostypes.RetryPolicy{MaxRetries: 0}}
	if u.Scheme == "http" {
		if g.Credential != nil || g.TLS != nil {
			return nil, fmt.Errorf("credentials require TLS")
		}
	}
	if g.Credential != nil {
		token, err := Resolve(g.Credential.Env)
		if err != nil {
			return nil, err
		}
		c.Auth = v1.StaticToken(token)
	}
	if g.TLS != nil {
		ca, err := Resolve(g.TLS.CA.Env)
		if err != nil {
			return nil, err
		}
		cert, err := Resolve(g.TLS.Certificate.Env)
		if err != nil {
			return nil, err
		}
		key, err := Resolve(g.TLS.Key.Env)
		if err != nil {
			return nil, err
		}
		c.TLS = &v1.TLSConfig{CAFile: ca, CertFile: cert, KeyFile: key}
	}
	client, err := v1.NewClient(c)
	if err != nil {
		return nil, fmt.Errorf("cannot configure authenticated gateway connection")
	}
	return client, nil
}

func Resolve(name string) (string, error) {
	v, ok := os.LookupEnv(name)
	if !ok || v == "" {
		return "", fmt.Errorf("missing credential reference %s", name)
	}
	return v, nil
}

// Remote errors can contain credentials echoed by the upstream server.
func remoteError(operation string, err error) error {
	if err == nil {
		return nil
	}
	if v1.IsNotFound(err) {
		return fmt.Errorf("%s: resource absent", operation)
	}
	if v1.IsAlreadyExists(err) {
		return fmt.Errorf("%s: resource collision; inspect ownership before retrying", operation)
	}
	if v1.IsUnauthenticated(err) {
		return fmt.Errorf("%s: gateway authentication failed", operation)
	}
	if v1.IsPermissionDenied(err) {
		return fmt.Errorf("%s: gateway permission denied", operation)
	}
	if v1.IsUnavailable(err) || v1.IsDeadlineExceeded(err) || v1.IsCancelled(err) {
		return fmt.Errorf("%s: gateway transport unavailable or interrupted", operation)
	}
	return fmt.Errorf("%s failed; remote outcome may be inconclusive", operation)
}
