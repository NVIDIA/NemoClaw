// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package managed

import (
	"context"
	"encoding/json/v2"
	"errors"
	"time"

	"github.com/NVIDIA/NemoClaw/internal/snapshot"
	"github.com/NVIDIA/NemoClaw/internal/spark"
	"github.com/containerd/errdefs"
	"github.com/moby/moby/client"
)

type Status struct {
	Phase   string    `json:"phase"`
	Detail  string    `json:"detail"`
	Updated time.Time `json:"updated"`
	PID     int       `json:"pid"`
}

func (d *Docker) Status(ctx context.Context, o *Observation) (Status, error) {
	var s Status
	b, err := d.ReadFile(ctx, o.ContainerID, "/data/status.json", 128<<10)
	if errdefs.IsNotFound(err) && time.Since(o.StartedAt) < 30*time.Second {
		return Status{Phase: "initializing"}, nil
	}
	if err != nil {
		return s, errors.New("inference runtime status observation failed")
	}
	if json.Unmarshal(b, &s) != nil || s.Updated.IsZero() {
		return s, errors.New("inference runtime status is incomplete")
	}
	if s.Updated.Before(o.StartedAt) {
		return Status{Phase: "initializing"}, nil
	}
	switch s.Phase {
	case "initializing", "downloading", "preparing", "loading", "ready", "stopped":
		return s, nil
	}
	return s, errors.New("unknown inference runtime status")
}

func (d *Docker) VerifyArtifacts(ctx context.Context, o *Observation) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	m := spark.ModelManifest()
	dir := "/data/models/" + m.Revision
	b, err := d.ReadFile(ctx, o.ContainerID, dir+"/.nemoclaw-complete.json", 1<<20)
	if err != nil {
		return errors.New("complete model snapshot is unobservable")
	}
	var receipt snapshot.Receipt
	if json.Unmarshal(b, &receipt) != nil || receipt.Manifest != m.Key() || len(receipt.Files) != len(m.Files) {
		return errors.New("model snapshot receipt conflicts with immutable pin")
	}
	for i, f := range receipt.Files {
		if f.File != m.Files[i] {
			return errors.New("model snapshot manifest changed")
		}
		if err = d.verifyFile(ctx, o.ContainerID, dir, f); err != nil {
			return err
		}
	}
	dir = "/data/prepared/" + spark.PreparationKey()
	b, err = d.ReadFile(ctx, o.ContainerID, dir+"/complete.json", 1<<20)
	if err != nil {
		return errors.New("complete PLE preparation is unobservable")
	}
	var prep spark.Preparation
	if json.Unmarshal(b, &prep) != nil || prep.Key != spark.PreparationKey() || len(prep.Files) != 2 || prep.Files[0].Name != spark.PreparedFile || prep.Files[1].Name != spark.PreparedFile+".json" {
		return errors.New("packed PLE provenance conflicts with pinned preparation")
	}
	for _, f := range prep.Files {
		if err = d.verifyFile(ctx, o.ContainerID, dir, f); err != nil {
			return err
		}
	}
	return nil
}

func (d *Docker) verifyFile(ctx context.Context, id, dir string, f snapshot.VerifiedFile) error {
	s, err := d.API.ContainerStatPath(ctx, id, client.ContainerStatPathOptions{Path: dir + "/" + f.Name})
	if err != nil {
		return errors.New("verified artifact observation failed; absence of runtime unconfirmed")
	}
	if f.Size <= 0 || len(f.SHA256) != 64 || !s.Stat.Mode.IsRegular() || s.Stat.Size != f.Size || s.Stat.Mtime.UnixNano() != f.Modified {
		return errors.New("verified artifact changed; retained for inspection")
	}
	return nil
}
