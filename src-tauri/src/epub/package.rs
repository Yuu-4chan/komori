//! Finding and reading an EPUB's package document. Kept apart from the rest of the EPUB reader so
//! the Explorer thumbnail handler finds a book's cover exactly as the Library does.

use std::io::Read;

use zip::ZipArchive;

pub(crate) const MAX_XML_BYTES: usize = 2 * 1024 * 1024;

pub(crate) fn read_package<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
) -> Result<(String, String), String> {
    let container = read_entry(archive, "META-INF/container.xml", MAX_XML_BYTES)
        .map_err(|_| crate::failure::EPUB_NO_CONTAINER.to_string())?;
    let container = std::str::from_utf8(&container)
        .map_err(|_| crate::failure::EPUB_BAD_CONTAINER.to_string())?;
    let document = super::xml::parse(container, roxmltree::ParsingOptions::default())
        .map_err(|_| crate::failure::EPUB_BAD_CONTAINER.to_string())?;
    let package_href = document
        .descendants()
        .find(|node| node.tag_name().name() == "rootfile")
        .and_then(|node| node.attribute("full-path"))
        .ok_or_else(|| crate::failure::EPUB_NO_PACKAGE.to_string())?;
    let package_path = super::cover::archive_path_candidates("", package_href)
        .into_iter()
        .find(|path| entry_exists(archive, path))
        .ok_or_else(|| crate::failure::EPUB_NO_PACKAGE.to_string())?;

    let package = read_entry_flexible(archive, &package_path, MAX_XML_BYTES)
        .map_err(|_| crate::failure::EPUB_UNREADABLE_PACKAGE.to_string())?;
    let package =
        String::from_utf8(package).map_err(|_| crate::failure::EPUB_INVALID_PACKAGE.to_string())?;
    Ok((package_path, recover_package(package)?))
}

// Some converted books declare dc on individual fields but omit it on a later field.
// Retry only that known namespace, on the package root, then require strict XML again.
pub(crate) fn recover_package(package: String) -> Result<String, String> {
    match super::xml::parse(&package, roxmltree::ParsingOptions::default()) {
        Ok(_) => Ok(package),
        Err(super::xml::XmlError::Parse(roxmltree::Error::UnknownNamespace(prefix, _)))
            if prefix == "dc" =>
        {
            let mut repaired = package;
            if let Some(at) = repaired.find("<package").map(|at| at + "<package".len()) {
                if repaired
                    .as_bytes()
                    .get(at)
                    .is_some_and(|byte| byte.is_ascii_whitespace() || *byte == b'>')
                {
                    repaired.insert_str(at, " xmlns:dc=\"http://purl.org/dc/elements/1.1/\"");
                }
            }
            let document = parse_package(&repaired)?;
            if document.root_element().tag_name().name() != "package" {
                return Err(crate::failure::EPUB_INVALID_PACKAGE.into());
            }
            Ok(repaired)
        }
        Err(_) => Err(crate::failure::EPUB_BROKEN_PACKAGE.into()),
    }
}

pub(crate) fn parse_package(package: &str) -> Result<roxmltree::Document<'_>, String> {
    super::xml::parse(package, roxmltree::ParsingOptions::default())
        .map_err(|_| crate::failure::EPUB_INVALID_PACKAGE.to_string())
}

pub(crate) fn entry_exists<R: Read + std::io::Seek>(
    archive: &ZipArchive<R>,
    requested: &str,
) -> bool {
    archive
        .file_names()
        .any(|name| name == requested || name.eq_ignore_ascii_case(requested))
}

pub(crate) fn read_entry_flexible<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    requested: &str,
    limit: usize,
) -> Result<Vec<u8>, String> {
    let actual_name = archive
        .file_names()
        .find(|name| *name == requested)
        .or_else(|| {
            archive
                .file_names()
                .find(|name| name.eq_ignore_ascii_case(requested))
        })
        .map(str::to_owned)
        .ok_or_else(|| "EPUB entry is missing.".to_string())?;
    read_entry(archive, &actual_name, limit)
}

fn read_entry<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
    name: &str,
    limit: usize,
) -> Result<Vec<u8>, String> {
    let entry = archive.by_name(name).map_err(|error| error.to_string())?;
    if entry.size() > limit as u64 {
        return Err("EPUB entry exceeds the safe size limit.".into());
    }
    let mut bytes = Vec::new();
    entry
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > limit {
        return Err("EPUB entry exceeds the safe size limit.".into());
    }
    Ok(bytes)
}
