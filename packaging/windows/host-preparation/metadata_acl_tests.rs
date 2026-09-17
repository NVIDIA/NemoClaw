// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn ace(sid: usize, mask: u32, flags: u8, kind: u8) -> Vec<u8> {
    let mut value = vec![kind, flags, 24, 0];
    value.extend_from_slice(&mask.to_le_bytes());
    value.extend_from_slice(&REQUIRED_SIDS[sid]);
    value
}

fn descriptor(aces: &[Vec<u8>], control: u16) -> Descriptor {
    let mut bytes = vec![1, 0];
    bytes.extend_from_slice(&control.to_le_bytes());
    bytes.extend_from_slice(&[0; 12]);
    bytes.extend_from_slice(&20u32.to_le_bytes());
    let size = 8 + aces.iter().map(Vec::len).sum::<usize>();
    bytes.extend_from_slice(&[2, 0]);
    bytes.extend_from_slice(&(size as u16).to_le_bytes());
    bytes.extend_from_slice(&(aces.len() as u16).to_le_bytes());
    bytes.extend_from_slice(&[0, 0]);
    for item in aces {
        bytes.extend_from_slice(item);
    }
    Descriptor::parse(bytes).unwrap()
}

#[test]
fn missing_tuples_add_only_the_two_exact_metadata_aces() {
    let before = descriptor(&[], 0x8004);
    let plan = before.plan().unwrap();
    assert_eq!(plan.additions, 2);
    assert_eq!(
        plan.aces,
        vec![ace(0, METADATA_MASK, 0, 0), ace(1, METADATA_MASK, 0, 0)]
    );
    assert_eq!(
        hex(&plan.aces[0]),
        "0000180088001200010200000000000f0200000001000000"
    );
    assert_eq!(plan.acl.len(), 56);
}

#[test]
fn exact_prepared_state_is_byte_preserving() {
    let before = descriptor(
        &[ace(0, METADATA_MASK, 0, 0), ace(1, METADATA_MASK, 0, 0)],
        0x9404,
    );
    let plan = before.plan().unwrap();
    assert_eq!(plan.additions, 0);
    assert_eq!(plan.acl, before.acl);
    before.verify(&plan, &before).unwrap();
}

#[test]
fn partial_preparation_adds_only_the_missing_trustee() {
    let before = descriptor(&[ace(1, METADATA_MASK, 0, 0)], 0x8004);
    let plan = before.plan().unwrap();
    assert_eq!(plan.additions, 1);
    assert_eq!(
        plan.aces,
        vec![ace(1, METADATA_MASK, 0, 0), ace(0, METADATA_MASK, 0, 0)]
    );
}

#[test]
fn conflicting_second_trustee_refuses_the_whole_plan() {
    let before = descriptor(&[ace(1, METADATA_MASK | 1, 0, 0)], 0x8004);
    assert_eq!(before.plan(), Err("conflicting-metadata-ace"));
}

#[test]
fn inheritable_or_denying_target_ace_is_not_equivalent() {
    for item in [ace(0, METADATA_MASK, 3, 0), ace(0, METADATA_MASK, 0, 1)] {
        assert_eq!(
            descriptor(&[item], 0x8004).plan(),
            Err("conflicting-metadata-ace")
        );
    }
}

#[test]
fn unsupported_explicit_ace_refuses_before_mutation() {
    assert_eq!(
        descriptor(&[ace(0, METADATA_MASK, 0, 9)], 0x8004).plan(),
        Err("unsupported-explicit-ace")
    );
}

#[test]
fn existing_explicit_and_inherited_ace_bytes_keep_their_order() {
    let mut explicit = ace(0, 0x80, 0, 0);
    explicit[12] = 5;
    let inherited = ace(0, 0x80, 0x13, 0);
    let before = descriptor(&[explicit.clone(), inherited.clone()], 0x8004);
    let plan = before.plan().unwrap();
    assert_eq!(
        plan.aces,
        vec![
            explicit,
            ace(0, METADATA_MASK, 0, 0),
            ace(1, METADATA_MASK, 0, 0),
            inherited
        ]
    );
}

#[test]
fn duplicate_exact_existing_aces_are_not_rewritten() {
    let items = vec![
        ace(0, METADATA_MASK, 0, 0),
        ace(0, METADATA_MASK, 0, 0),
        ace(1, METADATA_MASK, 0, 0),
    ];
    let before = descriptor(&items, 0x8004);
    let plan = before.plan().unwrap();
    assert_eq!(plan.additions, 0);
    assert_eq!(plan.aces, items);
}

#[test]
fn only_one_way_auto_inherited_bookkeeping_is_admitted_after_write() {
    let before = descriptor(&[], 0x8004);
    let plan = before.plan().unwrap();
    before
        .verify(&plan, &descriptor(&plan.aces, 0x8404))
        .unwrap();
    for bit in 0..16 {
        if bit != 10 {
            assert!(
                before
                    .verify(&plan, &descriptor(&plan.aces, 0x8004 | (1 << bit)))
                    .is_err()
                    || (0x8004 & (1 << bit)) != 0
            );
        }
    }
    let prepared = descriptor(&plan.aces, 0x8404);
    assert!(
        prepared
            .verify(&prepared.plan().unwrap(), &descriptor(&plan.aces, 0x8004))
            .is_err()
    );
}

#[test]
fn changed_owner_group_mask_and_order_are_rejected() {
    let before = descriptor(&[], 0x8004);
    let plan = before.plan().unwrap();
    let mut after = descriptor(&plan.aces, 0x8404);
    after.owner = Some(REQUIRED_SIDS[0].to_vec());
    assert!(before.verify(&plan, &after).is_err());
    after.owner = None;
    after.group = Some(REQUIRED_SIDS[0].to_vec());
    assert!(before.verify(&plan, &after).is_err());
    after.group = None;
    after.aces[0][4] ^= 1;
    assert!(before.verify(&plan, &after).is_err());
    let mut after = descriptor(&plan.aces, 0x8404);
    after.aces.swap(0, 1);
    assert!(before.verify(&plan, &after).is_err());
}

#[test]
fn observed_synthetic_protection_change_is_never_allowed() {
    let inherited = ace(0, 0x80, 0x13, 0);
    let before = descriptor(&[inherited], 0x8004);
    let plan = before.plan().unwrap();
    let mut after = descriptor(&plan.aces, 0x9004);
    for item in &mut after.aces {
        item[1] &= !0x10;
    }
    assert_eq!(
        before.verify(&plan, &after),
        Err("descriptor-identity-changed")
    );
}

#[test]
fn malformed_descriptor_and_ace_bounds_are_rejected() {
    assert!(Descriptor::parse(vec![0; 19]).is_err());
    let valid = descriptor(&[], 0x8004).bytes;
    let mut absent = valid.clone();
    absent[2] = 0;
    assert!(Descriptor::parse(absent).is_err());
    let mut bad_offset = valid.clone();
    bad_offset[16..20].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(Descriptor::parse(bad_offset).is_err());
    let mut count = valid;
    count[24..26].copy_from_slice(&1u16.to_le_bytes());
    assert!(Descriptor::parse(count).is_err());
}
