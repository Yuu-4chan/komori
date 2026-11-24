//! The cover a thumbnail shows, and the DLL itself loaded as Explorer loads it, without
//! registering it.

use std::io::{Cursor, Write};

use image::{ImageFormat, Rgba, RgbaImage};
use zip::{write::SimpleFileOptions, ZipWriter};

const CONTAINER: &str = r#"<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"#;

/// An EPUB whose package names `cover` (a file under OEBPS) as its cover image.
fn epub(cover: Option<(&str, &[u8])>) -> Vec<u8> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default();
    zip.start_file("mimetype", options).unwrap();
    zip.write_all(b"application/epub+zip").unwrap();
    zip.start_file("META-INF/container.xml", options).unwrap();
    zip.write_all(CONTAINER.as_bytes()).unwrap();
    let item = cover.map_or(String::new(), |(name, _)| {
        format!(
            r#"<item id="cover" href="{name}" media-type="image/png" properties="cover-image"/>"#
        )
    });
    let package = format!(
        r#"<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Book</dc:title></metadata>
  <manifest><item id="text" href="text.xhtml" media-type="application/xhtml+xml"/>{item}</manifest>
  <spine><itemref idref="text"/></spine>
</package>"#
    );
    zip.start_file("OEBPS/content.opf", options).unwrap();
    zip.write_all(package.as_bytes()).unwrap();
    zip.start_file("OEBPS/text.xhtml", options).unwrap();
    zip.write_all(b"<html xmlns=\"http://www.w3.org/1999/xhtml\"><body><p>Text</p></body></html>")
        .unwrap();
    if let Some((name, bytes)) = cover {
        zip.start_file(format!("OEBPS/{name}"), options).unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

/// A 300 by 450 red cover whose top-left 30 pixels are transparent.
fn cover_png() -> Vec<u8> {
    let image = RgbaImage::from_fn(300, 450, |x, y| {
        if x < 30 && y < 30 {
            Rgba([0, 0, 0, 0])
        } else {
            Rgba([200, 20, 20, 255])
        }
    });
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, ImageFormat::Png).unwrap();
    bytes.into_inner()
}

#[test]
fn fits_the_cover_within_the_size_asked_and_draws_transparency_on_white() {
    let book = epub(Some(("cover.png", &cover_png())));
    let thumbnail = komori_thumbnails::cover_thumbnail(Cursor::new(&book), 96).unwrap();
    assert_eq!((thumbnail.width, thumbnail.height), (64, 96));
    assert_eq!(thumbnail.pixels.len(), 64 * 96 * 3);
    assert_eq!(&thumbnail.pixels[..3], &[255, 255, 255]);
    let middle = (48 * 64 + 32) * 3;
    let [r, g, b] = thumbnail.pixels[middle..middle + 3] else {
        unreachable!()
    };
    assert!(r > 180 && g < 40 && b < 40, "{r} {g} {b}");

    let large = komori_thumbnails::cover_thumbnail(Cursor::new(&book), 900).unwrap();
    assert_eq!((large.width, large.height), (600, 900));
}

#[test]
fn gives_no_thumbnail_for_what_it_cannot_read() {
    let thumbnail = |bytes: &[u8]| komori_thumbnails::cover_thumbnail(Cursor::new(bytes), 256);
    assert!(thumbnail(b"not an archive").is_none());
    assert!(thumbnail(&epub(None)).is_none());
    assert!(thumbnail(&epub(Some(("cover.png", b"\x89PNG\r\n\x1a\nbroken")))).is_none());

    // Wider than any cover the Library decodes.
    let wide = RgbaImage::new(13_000, 1);
    let mut bytes = Cursor::new(Vec::new());
    wide.write_to(&mut bytes, ImageFormat::Png).unwrap();
    assert!(thumbnail(&epub(Some(("cover.png", &bytes.into_inner())))).is_none());

    let mut no_container = ZipWriter::new(Cursor::new(Vec::new()));
    no_container
        .start_file("cover.png", SimpleFileOptions::default())
        .unwrap();
    no_container.write_all(&cover_png()).unwrap();
    assert!(thumbnail(&no_container.finish().unwrap().into_inner()).is_none());
}

#[cfg(windows)]
mod dll {
    use std::{ffi::c_void, path::PathBuf, ptr::null_mut};

    use windows::{
        core::{Interface, GUID, HRESULT, HSTRING},
        Win32::{
            Foundation::{FreeLibrary, CLASS_E_CLASSNOTAVAILABLE, S_OK},
            Graphics::Gdi::{DeleteObject, GetObjectW, BITMAP, HBITMAP, HGDIOBJ},
            System::{
                Com::{CoInitializeEx, CoUninitialize, IClassFactory, COINIT_APARTMENTTHREADED},
                LibraryLoader::{GetProcAddress, LoadLibraryW},
            },
            UI::Shell::{
                IThumbnailProvider, PropertiesSystem::IInitializeWithStream, SHCreateMemStream,
                WTSAT_RGB, WTS_ALPHATYPE,
            },
        },
    };

    type GetClassObject =
        unsafe extern "system" fn(*const GUID, *const GUID, *mut *mut c_void) -> HRESULT;
    type CanUnloadNow = unsafe extern "system" fn() -> HRESULT;

    /// The DLL Cargo built beside this test.
    pub(super) fn path() -> PathBuf {
        let deps = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf();
        [
            deps.join("komori_thumbnails.dll"),
            deps.parent().unwrap().join("komori_thumbnails.dll"),
        ]
        .into_iter()
        .find(|path| path.exists())
        .expect("the thumbnail DLL is built with the tests")
    }

    #[test]
    fn makes_a_bitmap_of_the_cover_through_com_and_unloads_when_released() {
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap();
            let module = LoadLibraryW(&HSTRING::from(path().as_os_str())).unwrap();
            let get_class_object: GetClassObject = std::mem::transmute(
                GetProcAddress(module, windows::core::s!("DllGetClassObject")).unwrap(),
            );
            let can_unload: CanUnloadNow = std::mem::transmute(
                GetProcAddress(module, windows::core::s!("DllCanUnloadNow")).unwrap(),
            );

            let mut unknown = null_mut();
            let other = GUID::from_u128(0x1);
            assert_eq!(
                get_class_object(&other, &IClassFactory::IID, &mut unknown),
                CLASS_E_CLASSNOTAVAILABLE
            );
            assert!(unknown.is_null());

            get_class_object(&komori_thumbnails::CLSID, &IClassFactory::IID, &mut unknown)
                .ok()
                .unwrap();
            let book = super::epub(Some(("cover.png", &super::cover_png())));

            // Everything the DLL made lives in this block, so it can unload after.
            {
                let factory = IClassFactory::from_raw(unknown);
                let provider: IInitializeWithStream = factory.CreateInstance(None).unwrap();
                provider
                    .Initialize(&SHCreateMemStream(Some(&book)).unwrap(), 0)
                    .unwrap();
                let provider: IThumbnailProvider = provider.cast().unwrap();
                let mut bitmap = HBITMAP::default();
                let mut alpha = WTS_ALPHATYPE::default();
                provider.GetThumbnail(256, &mut bitmap, &mut alpha).unwrap();
                assert_eq!(alpha, WTSAT_RGB);
                let mut info = BITMAP::default();
                let written = GetObjectW(
                    HGDIOBJ(bitmap.0),
                    size_of::<BITMAP>() as i32,
                    Some((&raw mut info).cast()),
                );
                assert_eq!(written, size_of::<BITMAP>() as i32);
                assert_eq!(
                    (info.bmWidth, info.bmHeight, info.bmBitsPixel),
                    (171, 256, 32)
                );
                let pixels = std::slice::from_raw_parts(info.bmBits.cast::<u8>(), 171 * 256 * 4);
                assert_eq!(&pixels[..4], &[255, 255, 255, 255]);
                let middle = (128 * 171 + 85) * 4;
                assert!(
                    pixels[middle + 2] > 180 && pixels[middle + 1] < 40,
                    "{:?}",
                    &pixels[middle..middle + 4]
                );
                assert!(DeleteObject(HGDIOBJ(bitmap.0)).as_bool());

                // A file that is no book: no bitmap, and an error Explorer shows the icon for.
                let broken: IInitializeWithStream = factory.CreateInstance(None).unwrap();
                broken
                    .Initialize(&SHCreateMemStream(Some(b"not an archive")).unwrap(), 0)
                    .unwrap();
                let mut none = HBITMAP::default();
                assert!(broken
                    .cast::<IThumbnailProvider>()
                    .unwrap()
                    .GetThumbnail(256, &mut none, &mut alpha)
                    .is_err());
                assert!(none.is_invalid());
                // A provider takes one file.
                assert!(provider
                    .cast::<IInitializeWithStream>()
                    .unwrap()
                    .Initialize(&SHCreateMemStream(Some(&book)).unwrap(), 0)
                    .is_err());
                assert_ne!(can_unload(), S_OK);
            }
            assert_eq!(can_unload(), S_OK);
            FreeLibrary(module).unwrap();
            CoUninitialize();
        }
    }
}

/// Real books through the built DLL: `KOMORI_THUMBNAIL_BOOKS` names a folder of EPUBs, read only,
/// and each thumbnail is saved as a PNG in `KOMORI_THUMBNAIL_OUT`.
#[cfg(windows)]
#[test]
#[ignore = "requires a folder of real books"]
fn real_books() {
    use std::{ffi::c_void, ptr::null_mut, time::Instant};

    use windows::{
        core::{Interface, GUID, HRESULT, HSTRING},
        Win32::{
            Graphics::Gdi::{DeleteObject, GetObjectW, BITMAP, HBITMAP, HGDIOBJ},
            System::{
                Com::{
                    CoInitializeEx, IClassFactory, COINIT_APARTMENTTHREADED, STGM_READ,
                    STGM_SHARE_DENY_NONE,
                },
                LibraryLoader::{GetProcAddress, LoadLibraryW},
            },
            UI::Shell::{
                IThumbnailProvider, PropertiesSystem::IInitializeWithStream,
                SHCreateStreamOnFileEx, WTS_ALPHATYPE,
            },
        },
    };

    type GetClassObject =
        unsafe extern "system" fn(*const GUID, *const GUID, *mut *mut c_void) -> HRESULT;
    let books = std::path::PathBuf::from(std::env::var("KOMORI_THUMBNAIL_BOOKS").unwrap());
    let out = std::path::PathBuf::from(std::env::var("KOMORI_THUMBNAIL_OUT").unwrap());
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap();
        let module = LoadLibraryW(&HSTRING::from(dll::path().as_os_str())).unwrap();
        let get_class_object: GetClassObject = std::mem::transmute(
            GetProcAddress(module, windows::core::s!("DllGetClassObject")).unwrap(),
        );
        let mut unknown = null_mut();
        get_class_object(&komori_thumbnails::CLSID, &IClassFactory::IID, &mut unknown)
            .ok()
            .unwrap();
        let factory = IClassFactory::from_raw(unknown);
        let mut entries: Vec<_> = std::fs::read_dir(&books)
            .unwrap()
            .flatten()
            .map(|entry| entry.path())
            .collect();
        entries.sort();
        for (index, book) in entries.iter().enumerate() {
            if book.extension().and_then(|e| e.to_str()) != Some("epub") {
                continue;
            }
            let started = Instant::now();
            let stream = SHCreateStreamOnFileEx(
                &HSTRING::from(book.as_os_str()),
                (STGM_READ | STGM_SHARE_DENY_NONE).0,
                0,
                false,
                None,
            )
            .unwrap();
            let provider: IInitializeWithStream = factory.CreateInstance(None).unwrap();
            provider.Initialize(&stream, STGM_READ.0).unwrap();
            let mut bitmap = HBITMAP::default();
            let mut alpha = WTS_ALPHATYPE::default();
            let result = provider.cast::<IThumbnailProvider>().unwrap().GetThumbnail(
                256,
                &mut bitmap,
                &mut alpha,
            );
            let elapsed = started.elapsed().as_millis();
            let name = book.file_name().unwrap().to_string_lossy();
            if result.is_err() {
                println!("{index:02} none {elapsed} ms {name}");
                continue;
            }
            let mut info = BITMAP::default();
            GetObjectW(
                HGDIOBJ(bitmap.0),
                size_of::<BITMAP>() as i32,
                Some((&raw mut info).cast()),
            );
            let (width, height) = (info.bmWidth as u32, info.bmHeight as u32);
            let bgra =
                std::slice::from_raw_parts(info.bmBits.cast::<u8>(), (width * height * 4) as usize);
            let rgb: Vec<u8> = bgra
                .as_chunks::<4>()
                .0
                .iter()
                .flat_map(|[b, g, r, _]| [*r, *g, *b])
                .collect();
            image::RgbImage::from_raw(width, height, rgb)
                .unwrap()
                .save(out.join(format!("{index:02}.png")))
                .unwrap();
            let _ = DeleteObject(HGDIOBJ(bitmap.0));
            println!("{index:02} {width}x{height} {elapsed} ms {name}");
        }
    }
}
