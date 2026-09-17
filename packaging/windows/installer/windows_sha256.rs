// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::runtime_transaction::Error;
use std::ffi::c_void;
type Handle = *mut c_void;
#[link(name = "bcrypt")]
unsafe extern "system" {
    fn BCryptOpenAlgorithmProvider(
        handle: *mut Handle,
        algorithm: *const u16,
        implementation: *const u16,
        flags: u32,
    ) -> i32;
    fn BCryptCloseAlgorithmProvider(handle: Handle, flags: u32) -> i32;
    fn BCryptGetProperty(
        handle: Handle,
        property: *const u16,
        output: *mut u8,
        bytes: u32,
        written: *mut u32,
        flags: u32,
    ) -> i32;
    fn BCryptCreateHash(
        algorithm: Handle,
        hash: *mut Handle,
        object: *mut u8,
        object_bytes: u32,
        secret: *const u8,
        secret_bytes: u32,
        flags: u32,
    ) -> i32;
    fn BCryptHashData(hash: Handle, input: *const u8, bytes: u32, flags: u32) -> i32;
    fn BCryptFinishHash(hash: Handle, output: *mut u8, bytes: u32, flags: u32) -> i32;
    fn BCryptDestroyHash(hash: Handle) -> i32;
}
struct Algorithm(Handle);
impl Drop for Algorithm {
    fn drop(&mut self) {
        unsafe {
            BCryptCloseAlgorithmProvider(self.0, 0);
        }
    }
}
pub struct Sha256 {
    handle: Handle,
    _object: Vec<u8>,
    _algorithm: Algorithm,
}
impl Drop for Sha256 {
    fn drop(&mut self) {
        unsafe {
            BCryptDestroyHash(self.handle);
        }
    }
}
impl Sha256 {
    pub fn new() -> Result<Self, Error> {
        let name = "SHA256\0".encode_utf16().collect::<Vec<_>>();
        let mut raw = std::ptr::null_mut();
        if unsafe { BCryptOpenAlgorithmProvider(&mut raw, name.as_ptr(), std::ptr::null(), 0) } < 0
        {
            return Err(Error::Native("hash-algorithm"));
        }
        let algorithm = Algorithm(raw);
        let property = "ObjectLength\0".encode_utf16().collect::<Vec<_>>();
        let mut length = 0u32;
        let mut written = 0u32;
        if unsafe {
            BCryptGetProperty(
                raw,
                property.as_ptr(),
                (&mut length as *mut u32).cast(),
                4,
                &mut written,
                0,
            )
        } < 0
            || written != 4
            || length == 0
            || length > 1024 * 1024
        {
            return Err(Error::Native("hash-object"));
        }
        let mut object = vec![0u8; length as usize];
        let mut hash = std::ptr::null_mut();
        if unsafe {
            BCryptCreateHash(
                raw,
                &mut hash,
                object.as_mut_ptr(),
                length,
                std::ptr::null(),
                0,
                0,
            )
        } < 0
        {
            return Err(Error::Native("hash-create"));
        }
        Ok(Self {
            handle: hash,
            _object: object,
            _algorithm: algorithm,
        })
    }
    pub fn update(&mut self, bytes: &[u8]) -> Result<(), Error> {
        if bytes.len() > u32::MAX as usize
            || unsafe { BCryptHashData(self.handle, bytes.as_ptr(), bytes.len() as u32, 0) } < 0
        {
            return Err(Error::Native("hash-update"));
        }
        Ok(())
    }
    pub fn finish(self) -> Result<String, Error> {
        let mut digest = [0u8; 32];
        if unsafe { BCryptFinishHash(self.handle, digest.as_mut_ptr(), 32, 0) } < 0 {
            return Err(Error::Native("hash-finish"));
        }
        Ok(digest.iter().map(|v| format!("{v:02x}")).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_sha256_matches_known_empty_and_split_input_vectors() {
        assert_eq!(
            Sha256::new().unwrap().finish().unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        let mut hash = Sha256::new().unwrap();
        hash.update(b"a").unwrap();
        hash.update(b"bc").unwrap();
        assert_eq!(
            hash.finish().unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
