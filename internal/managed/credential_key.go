// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package managed

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/rand"
	"errors"

	"github.com/containerd/errdefs"
	"github.com/moby/moby/client"
)

const credentialKeyPath = "/state/openshell/gateway/credentials/key-encryption-key.bin"

// Keep the credential encryption key alongside the database before starting a
// gateway. A legacy experimental container may have its key in its own rootfs;
// observe it during plan and copy it only during storage creation, before any
// process replacement. Never generate a substitute for an existing gateway.
func (d *Docker) credentialKey(ctx context.Context, s Spec, helper, dataPath string, bound, create bool) ([]byte, error) {
	b, err := d.ReadFile(ctx, helper, dataPath+credentialKeyPath, 32)
	if err == nil {
		if len(b) != 32 {
			return nil, errors.New("gateway credential encryption key is invalid")
		}
		return b, nil
	}
	if !errdefs.IsNotFound(err) || bound {
		return nil, errors.New("gateway credential encryption key is missing or unobservable; resources retained")
	}
	c, err := d.API.ContainerInspect(ctx, s.Name, client.ContainerInspectOptions{})
	if errdefs.IsNotFound(err) {
		if !create {
			return nil, ErrPartial
		}
		b = make([]byte, 32)
		rand.Read(b)
	} else {
		if err != nil {
			return nil, errors.New("legacy gateway observation failed; key creation forbidden")
		}
		if _, err = d.Observe(ctx, s, ""); err != nil {
			return nil, err
		}
		b, err = d.ReadFile(ctx, c.Container.ID, "/root/.local/state/openshell/gateway/credentials/key-encryption-key.bin", 32)
		if err != nil || len(b) != 32 {
			return nil, errors.New("legacy gateway credential encryption key is unobservable; replacement forbidden")
		}
	}
	if !create {
		return b, nil
	}
	var archive bytes.Buffer
	t := tar.NewWriter(&archive)
	for _, name := range []string{"state", "state/openshell", "state/openshell/gateway", "state/openshell/gateway/credentials"} {
		if err = t.WriteHeader(&tar.Header{Name: name, Typeflag: tar.TypeDir, Mode: 0700}); err != nil {
			return nil, err
		}
	}
	if err = t.WriteHeader(&tar.Header{Name: credentialKeyPath[1:], Mode: 0600, Size: 32}); err != nil {
		return nil, err
	}
	if _, err = t.Write(b); err != nil {
		return nil, err
	}
	if err = t.Close(); err != nil {
		return nil, err
	}
	if _, err = d.API.CopyToContainer(ctx, helper, client.CopyToContainerOptions{DestinationPath: dataPath, Content: &archive}); err != nil {
		return nil, errors.New("credential encryption key persistence outcome unknown; retain intent")
	}
	return d.credentialKey(ctx, s, helper, dataPath, true, false)
}
