// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[cfg(windows)]
mod native {
    use std::os::windows::ffi::OsStrExt;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::ptr::null;

    const PRODUCT_UPGRADE_CODE: &str = "{F635B342-DCE7-4C83-9AEC-50CB714E5F00}";
    const INSTALLED_DEFAULT: i32 = 5;
    const NO_MORE_ITEMS: u32 = 259;

    type MsiHandle = u32;

    #[link(name = "msi")]
    unsafe extern "system" {
        fn MsiEnumRelatedProductsW(
            upgrade_code: *const u16,
            reserved: u32,
            index: u32,
            product_code: *mut u16,
        ) -> u32;
        fn MsiQueryProductStateW(product_code: *const u16) -> i32;
        fn MsiGetProductInfoW(
            product_code: *const u16,
            property: *const u16,
            value: *mut u16,
            size: *mut u32,
        ) -> u32;
        fn MsiOpenDatabaseW(
            database_path: *const u16,
            persistence: *const u16,
            database: *mut MsiHandle,
        ) -> u32;
        fn MsiDatabaseOpenViewW(
            database: MsiHandle,
            query: *const u16,
            view: *mut MsiHandle,
        ) -> u32;
        fn MsiViewExecute(view: MsiHandle, record: MsiHandle) -> u32;
        fn MsiViewFetch(view: MsiHandle, record: *mut MsiHandle) -> u32;
        fn MsiRecordGetStringW(
            record: MsiHandle,
            field: u32,
            value: *mut u16,
            size: *mut u32,
        ) -> u32;
        fn MsiCloseHandle(handle: MsiHandle) -> u32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
    }

    struct Handle(MsiHandle);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe { MsiCloseHandle(self.0) };
        }
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn text(buffer: &[u16]) -> Result<String, String> {
        let end = buffer
            .iter()
            .position(|value| *value == 0)
            .ok_or_else(|| "Windows Installer returned an unterminated value.".to_owned())?;
        String::from_utf16(&buffer[..end])
            .map_err(|_| "Windows Installer returned invalid text.".to_owned())
    }

    fn local_package(product_code: &str) -> Result<PathBuf, String> {
        let mut buffer = vec![0u16; 32_768];
        let mut size = (buffer.len() - 1) as u32;
        let status = unsafe {
            MsiGetProductInfoW(
                wide(product_code).as_ptr(),
                wide("LocalPackage").as_ptr(),
                buffer.as_mut_ptr(),
                &mut size,
            )
        };
        if status != 0 || size == 0 || size as usize >= buffer.len() {
            return Err("Windows Installer could not locate a related runtime package.".into());
        }
        let value = PathBuf::from(text(&buffer)?);
        if !value.is_absolute() || !value.is_file() {
            return Err("A related runtime package has no fixed local package.".into());
        }
        Ok(value)
    }

    fn runtime_id(product_code: &str) -> Result<String, String> {
        let package = local_package(product_code)?;
        let mut database = 0;
        let status = unsafe {
            MsiOpenDatabaseW(
                package
                    .as_os_str()
                    .encode_wide()
                    .chain(std::iter::once(0))
                    .collect::<Vec<_>>()
                    .as_ptr(),
                null(),
                &mut database,
            )
        };
        if status != 0 || database == 0 {
            return Err("A related runtime package could not be inspected.".into());
        }
        let database = Handle(database);
        let query = wide("SELECT `Value` FROM `Property` WHERE `Property`='NemoClawRuntimeId'");
        let mut view = 0;
        if unsafe { MsiDatabaseOpenViewW(database.0, query.as_ptr(), &mut view) } != 0 || view == 0
        {
            return Err("A related runtime identity could not be queried.".into());
        }
        let view = Handle(view);
        if unsafe { MsiViewExecute(view.0, 0) } != 0 {
            return Err("A related runtime identity query could not execute.".into());
        }
        let mut record = 0;
        if unsafe { MsiViewFetch(view.0, &mut record) } != 0 || record == 0 {
            return Err("A related runtime package has no sealed identity.".into());
        }
        let record = Handle(record);
        let mut buffer = [0u16; 65];
        let mut size = buffer.len() as u32;
        if unsafe { MsiRecordGetStringW(record.0, 1, buffer.as_mut_ptr(), &mut size) } != 0 {
            return Err("A related runtime identity could not be read.".into());
        }
        let value = text(&buffer)?;
        if !super::valid_runtime_id(&value) {
            return Err("A related runtime package has an invalid sealed identity.".into());
        }
        Ok(value)
    }

    fn related_products() -> Result<Vec<(String, String)>, String> {
        let upgrade_code = wide(PRODUCT_UPGRADE_CODE);
        let mut products = Vec::new();
        for index in 0..32 {
            let mut code = [0u16; 39];
            let status = unsafe {
                MsiEnumRelatedProductsW(upgrade_code.as_ptr(), 0, index, code.as_mut_ptr())
            };
            if status == NO_MORE_ITEMS {
                return Ok(products);
            }
            if status != 0 {
                return Err("Windows Installer could not enumerate related runtimes.".into());
            }
            let code = text(&code)?;
            if !super::valid_product_code(&code) {
                return Err("Windows Installer returned an invalid related product code.".into());
            }
            if unsafe { MsiQueryProductStateW(wide(&code).as_ptr()) } == INSTALLED_DEFAULT {
                products.push((code.clone(), runtime_id(&code)?));
            }
        }
        Err("The related runtime product list exceeds its bound.".into())
    }

    fn msiexec() -> Result<PathBuf, String> {
        let mut buffer = vec![0u16; 32_768];
        let size = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
        if size == 0 || size as usize >= buffer.len() {
            return Err("The Windows system directory could not be resolved.".into());
        }
        buffer[size as usize] = 0;
        let path = PathBuf::from(text(&buffer)?).join("msiexec.exe");
        if !path.is_file() {
            return Err("Windows Installer is unavailable.".into());
        }
        Ok(path)
    }

    pub(super) fn prepare_upgrade(target_runtime: &str) -> Result<(), String> {
        if !super::valid_runtime_id(target_runtime) {
            return Err("The target runtime identity is invalid.".into());
        }
        let products = related_products()?;
        let stale = super::stale_products(target_runtime, &products)?;
        if stale.is_empty() {
            return Ok(());
        }
        let executable = msiexec()?;
        for product_code in stale {
            let status = Command::new(&executable)
                .args([
                    "/x",
                    product_code,
                    "/qn",
                    "/norestart",
                    "NEMOCLAW_BUNDLE_MANAGED_RUNTIME=1",
                    "REBOOT=ReallySuppress",
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map_err(|_| "A legacy runtime uninstall could not start.".to_owned())?;
            if !matches!(status.code(), Some(0 | 3010)) {
                return Err("A legacy runtime uninstall did not complete.".into());
            }
        }
        Ok(())
    }
}

fn valid_runtime_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_product_code(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 38
        && bytes[0] == b'{'
        && bytes[37] == b'}'
        && [9, 14, 19, 24].iter().all(|index| bytes[*index] == b'-')
        && bytes[1..37]
            .iter()
            .enumerate()
            .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit())
}

fn stale_products<'a>(
    target_runtime: &str,
    products: &'a [(String, String)],
) -> Result<Vec<&'a str>, String> {
    if !valid_runtime_id(target_runtime) {
        return Err("The target runtime identity is invalid.".into());
    }
    let mut result = Vec::new();
    for (product, runtime) in products {
        if !valid_product_code(product) || !valid_runtime_id(runtime) {
            return Err("A related runtime identity is invalid.".into());
        }
        if runtime != target_runtime {
            result.push(product.as_str());
        }
    }
    Ok(result)
}

#[cfg(windows)]
pub(crate) fn prepare_upgrade(target_runtime: &str) -> Result<(), String> {
    native::prepare_upgrade(target_runtime)
}

#[cfg(test)]
mod tests {
    use super::{stale_products, valid_product_code, valid_runtime_id};

    fn id(value: char) -> String {
        std::iter::repeat_n(value, 64).collect()
    }

    #[test]
    fn only_different_sealed_runtimes_are_selected() {
        let current = id('a');
        let old = id('b');
        let products = vec![
            (
                "{11111111-1111-1111-1111-111111111111}".into(),
                current.clone(),
            ),
            ("{22222222-2222-2222-2222-222222222222}".into(), old),
        ];
        assert_eq!(
            stale_products(&current, &products).unwrap(),
            vec!["{22222222-2222-2222-2222-222222222222}"]
        );
    }

    #[test]
    fn identities_are_bounded_before_product_mutation() {
        assert!(valid_runtime_id(&id('f')));
        assert!(!valid_runtime_id(&id('A')));
        assert!(valid_product_code("{ABCDEF01-2345-6789-abcd-EF0123456789}"));
        assert!(!valid_product_code("{ABCDEF01-2345-6789-abcd-EF012345678}"));
        let products = vec![("not-a-product".into(), id('b'))];
        assert!(stale_products(&id('a'), &products).is_err());
    }
}
