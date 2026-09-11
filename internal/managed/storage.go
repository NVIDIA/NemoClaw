// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package managed

import (
	"context"
	"errors"
	"regexp"

	"github.com/containerd/errdefs"
	"github.com/moby/moby/client"
)

const StorageKind = "inference_storage"

type Storage struct{ Name, Owner, Generation, Engine string }

func (s Storage) labels() map[string]string {
	return map[string]string{OwnerLabel: s.Owner, GenerationLabel: s.Generation}
}

func (d *Docker) Storage(ctx context.Context, s Storage, id string, create bool) (string, error) {
	if !regexp.MustCompile(`^nc-[a-f0-9]{16}-inference-data$`).MatchString(s.Name) || !regexp.MustCompile(`^[a-f0-9-]{36}$`).MatchString(s.Owner) || !regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(s.Generation) {
		return "", errors.New("storage lacks explicit ownership and generation")
	}
	info, err := d.API.Info(ctx, client.InfoOptions{})
	if err != nil || info.Info.ID == "" {
		return "", errors.New("storage engine identity unavailable")
	}
	v, err := d.API.VolumeInspect(ctx, s.Name, client.VolumeInspectOptions{})
	if errdefs.IsNotFound(err) {
		if id != "" {
			return "", errors.New("bound model storage is absent; recreation forbidden")
		}
		if !create {
			return "", nil
		}
		if _, err = d.API.VolumeCreate(ctx, client.VolumeCreateOptions{Name: s.Name, Driver: "local", Labels: s.labels()}); err != nil {
			return "", errors.New("storage create outcome unknown; retain intent and reconcile")
		}
		v, err = d.API.VolumeInspect(ctx, s.Name, client.VolumeInspectOptions{})
	}
	if err != nil {
		return "", errors.New("model storage observation failed; absence unconfirmed")
	}
	if err = verifyLabels(s.labels(), v.Volume.Labels); err != nil {
		return "", err
	}
	if v.Volume.CreatedAt == "" || v.Volume.Driver != "local" || len(v.Volume.Options) != 0 || v.Volume.Name != s.Name {
		return "", errors.New("model storage configuration drifted")
	}
	got := info.Info.ID + "/" + v.Volume.Name + "/" + v.Volume.CreatedAt
	if id != "" && id != got {
		return "", errors.New("model storage durable identity changed")
	}
	return got, nil
}

// ReplaceContainer removes only the verified inference process container.
// Persistent storage has its own immutable resource and deletion is forbidden.
func (d *Docker) ReplaceContainer(ctx context.Context, s Spec, id string) error {
	if s.Kind != ServiceKind || id == "" {
		return errors.New("only a bound inference container may be replaced")
	}
	o, err := d.Observe(ctx, s, id)
	if err != nil {
		return err
	}
	if o == nil {
		return errors.New("replacement identity is unobservable")
	}
	if o.Running {
		if _, err = d.API.ContainerStop(ctx, o.ContainerID, client.ContainerStopOptions{Timeout: new(60)}); err != nil {
			return errors.New("inference stop outcome unknown; data retained")
		}
	}
	if _, err = d.API.ContainerRemove(ctx, o.ContainerID, client.ContainerRemoveOptions{}); err != nil {
		return errors.New("inference container removal outcome unknown; storage retained")
	}
	return nil
}
