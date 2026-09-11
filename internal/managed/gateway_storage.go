// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package managed

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"

	"github.com/containerd/errdefs"
	"github.com/moby/moby/client"
)

// GatewayStorage binds the database volume, bridge, and signing key independently
// of the gateway process. The retained initializer provides read-only Docker
// archive access even while the gateway is stopped or being replaced.
func (d *Docker) GatewayStorage(ctx context.Context, s Spec, id string, create bool) (string, error) {
	if s.Kind != GatewayKind || s.Layout != 0 || s.Validate() != nil {
		return "", errors.New("invalid gateway storage specification")
	}
	info, err := d.API.Info(ctx, client.InfoOptions{})
	if err != nil || info.Info.ID == "" {
		return "", errors.New("gateway storage engine identity unavailable")
	}
	v, ve := d.API.VolumeInspect(ctx, s.Volume(), client.VolumeInspectOptions{})
	n, ne := d.API.NetworkInspect(ctx, s.Network(), client.NetworkInspectOptions{})
	i, ie := d.API.ContainerInspect(ctx, s.Name+"-initialize", client.ContainerInspectOptions{})
	for _, e := range []error{ve, ne, ie} {
		if e != nil && !errdefs.IsNotFound(e) {
			return "", errors.New("gateway storage observation failed; absence unconfirmed")
		}
	}
	if ve == nil {
		if err = verifyVolume(s, v.Volume); err != nil {
			return "", err
		}
	}
	if ne == nil {
		if err = verifyNetwork(s, n.Network); err != nil {
			return "", err
		}
	}
	if ie == nil {
		c := i.Container
		if c.ID == "" || c.Config == nil || c.State == nil || c.Config.Image != s.Image() || verifyLabels(s.labels(), c.Config.Labels) != nil {
			return "", errors.New("gateway storage initializer identity changed")
		}
		// Never read a different volume through an otherwise correctly labelled helper.
		if ve == nil && (len(c.Mounts) != 1 || c.Mounts[0].Name != s.Volume() || c.Mounts[0].Destination != v.Volume.Mountpoint) {
			return "", errors.New("gateway storage initializer mount changed")
		}
	}
	missing := ve != nil || ne != nil || ie != nil
	if missing && id != "" {
		return "", errors.New("bound gateway storage dependency is missing; recreation forbidden")
	}
	if missing && !create {
		if ve != nil && ne != nil && ie != nil {
			return "", nil
		}
		return "", ErrPartial
	}
	if create && missing {
		if err = d.ensureImage(ctx, s); err != nil {
			return "", err
		}
		if err = d.ensureNetwork(ctx, s); err != nil {
			return "", err
		}
		if ve != nil {
			if _, err = d.API.VolumeCreate(ctx, client.VolumeCreateOptions{Name: s.Volume(), Driver: "local", Labels: s.labels()}); err != nil {
				return "", errors.New("gateway volume create outcome unknown; retain intent and reconcile")
			}
			v, err = d.API.VolumeInspect(ctx, s.Volume(), client.VolumeInspectOptions{})
			if err != nil || verifyVolume(s, v.Volume) != nil {
				return "", errors.New("created gateway volume is unobservable")
			}
		}
	}
	// Initialization can be interrupted after credentials were generated. The
	// original initializer is never rerun after successful exit, avoiding rekeying.
	if create && (missing || i.Container.State.Status == "created") {
		if err = d.initializeGateway(ctx, s, &Observation{DataPath: v.Volume.Mountpoint}); err != nil {
			return "", err
		}
		return d.GatewayStorage(ctx, s, id, false)
	}
	if i.Container.State.Status == "created" && id == "" && !create {
		return "", ErrPartial
	}
	if i.Container.State.Running || i.Container.State.ExitCode != 0 {
		return "", errors.New("gateway credential initialization is incomplete")
	}
	path := v.Volume.Mountpoint
	b, err := d.ReadFile(ctx, i.Container.ID, path+"/gateway.toml", 128<<10)
	if errdefs.IsNotFound(err) && create && id == "" {
		if err = d.initializeGateway(ctx, s, &Observation{DataPath: path}); err != nil {
			return "", err
		}
		return d.GatewayStorage(ctx, s, id, false)
	}
	if errdefs.IsNotFound(err) && id == "" && !create {
		return "", ErrPartial
	}
	if err != nil || !bytes.Equal(b, s.GatewayConfig(path)) {
		return "", errors.New("gateway storage configuration changed or is unobservable")
	}
	pub, err := d.ReadFile(ctx, i.Container.ID, path+"/tls/jwt/public.pem", 128<<10)
	if err != nil || len(pub) == 0 {
		return "", errors.New("gateway signing identity is unobservable")
	}
	if _, err = d.credentialKey(ctx, s, i.Container.ID, path, id != "", create); err != nil {
		return "", err
	}
	h := sha256.Sum256(pub)
	got := strings.Join([]string{info.Info.ID, v.Volume.Name, v.Volume.CreatedAt, n.Network.ID, hex.EncodeToString(h[:])}, "/")
	if id != "" && id != got {
		return "", errors.New("gateway storage durable identity changed")
	}
	return got, nil
}
