//! The Library's EPUB package and cover code, shared as source.

use std::io::{Read, Seek};

use zip::ZipArchive;

#[allow(dead_code)]
#[path = "../../../src/epub/cover.rs"]
pub(crate) mod cover;
#[allow(dead_code)]
#[path = "../../../src/epub/package.rs"]
pub(crate) mod package;
#[allow(dead_code)]
#[path = "../../../src/epub/xml.rs"]
pub(crate) mod xml;

/// The bytes of the cover image the Library would show for the EPUB `source`.
pub(crate) fn cover_image<R: Read + Seek>(source: R) -> Option<Vec<u8>> {
    let mut archive = ZipArchive::new(source).ok()?;
    let (package_path, package) = package::read_package(&mut archive).ok()?;
    let document = package::parse_package(&package).ok()?;
    cover::discover(&mut archive, &package_path, &document)
        .cover
        .map(|cover| cover.bytes)
}
