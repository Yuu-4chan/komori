pub(crate) mod cover;
pub(crate) mod details;
pub(crate) mod xml;

use std::{fs::File, io::Read};

use zip::ZipArchive;

pub(crate) use cover::{CoverDiagnostic, ResolvedCover};
pub(crate) use details::BookDetails;

const MAX_XML_BYTES: usize = 2 * 1024 * 1024;

pub(crate) struct EpubMetadata {
    pub(crate) title: Option<String>,
    pub(crate) author: Option<String>,
    pub(crate) cover: Option<ResolvedCover>,
    pub(crate) cover_diagnostic: CoverDiagnostic,
    pub(crate) details: BookDetails,
}

pub(crate) fn read(source: File) -> Result<EpubMetadata, String> {
    let mut archive = open_archive(source)?;
    let (package_path, package) = read_package(&mut archive)?;
    let document = parse_package(&package)?;
    check_structure(&archive, &package_path, &document)?;
    let metadata_node = document
        .descendants()
        .find(|node| node.tag_name().name() == "metadata");
    let title = metadata_node
        .and_then(|metadata| field(metadata, "title"))
        .and_then(|title| crate::title_cleaning::clean(&title));
    let author = metadata_node.and_then(|metadata| field(metadata, "creator"));
    let cover_resolution = cover::discover(&mut archive, &package_path, &document);
    let (text, words) = details::text_statistics(&mut archive, &package_path, &document);
    let details = BookDetails {
        package: details::package_details(&document),
        text,
        words,
    };

    Ok(EpubMetadata {
        title,
        author,
        cover: cover_resolution.cover,
        cover_diagnostic: cover_resolution.diagnostic,
        details,
    })
}

/// The book's language, series, and text counts alone, for books imported before Komori read
/// them.
pub(crate) fn read_details(source: File) -> Result<BookDetails, String> {
    let mut archive = open_archive(source)?;
    let (package_path, package) = read_package(&mut archive)?;
    let document = parse_package(&package)?;
    let (text, words) = details::text_statistics(&mut archive, &package_path, &document);
    Ok(BookDetails {
        package: details::package_details(&document),
        text,
        words,
    })
}

/// Checks the archive, container, and package document without resolving or decoding a cover.
/// Reader content access checks each archive version it serves this way once, before listing
/// its entries.
pub(crate) fn validate_archive<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
) -> Result<(), String> {
    let (package_path, package) = read_package(archive)?;
    check_structure(archive, &package_path, &parse_package(&package)?)
}

/// Requires the least a Reader can open: a `package` root with a manifest and a spine, and at
/// least one spine item naming a manifest item whose file is in the archive.
fn check_structure<R: Read + std::io::Seek>(
    archive: &ZipArchive<R>,
    package_path: &str,
    document: &roxmltree::Document<'_>,
) -> Result<(), String> {
    let invalid = || crate::failure::EPUB_INVALID_PACKAGE.to_string();
    let root = document.root_element();
    if root.tag_name().name() != "package" {
        return Err(invalid());
    }
    let child = |name: &str| {
        root.children()
            .find(|node| node.is_element() && node.tag_name().name() == name)
    };
    let (Some(manifest), Some(spine)) = (child("manifest"), child("spine")) else {
        return Err(invalid());
    };
    let base = package_path.rsplit_once('/').map_or("", |(base, _)| base);
    let readable = |idref: &str| {
        manifest
            .children()
            .filter(|node| node.tag_name().name() == "item")
            .filter(|item| item.attribute("id") == Some(idref))
            .filter_map(|item| item.attribute("href"))
            .any(|href| {
                cover::archive_path_candidates(base, href)
                    .iter()
                    .any(|path| entry_exists(archive, path))
            })
    };
    spine
        .children()
        .filter(|node| node.tag_name().name() == "itemref")
        .filter_map(|itemref| itemref.attribute("idref"))
        .any(readable)
        .then_some(())
        .ok_or_else(invalid)
}

fn open_archive(source: File) -> Result<ZipArchive<File>, String> {
    ZipArchive::new(source).map_err(|_| crate::failure::EPUB_NOT_ARCHIVE.to_string())
}

fn read_package<R: Read + std::io::Seek>(
    archive: &mut ZipArchive<R>,
) -> Result<(String, String), String> {
    let container = read_entry(archive, "META-INF/container.xml", MAX_XML_BYTES)
        .map_err(|_| crate::failure::EPUB_NO_CONTAINER.to_string())?;
    let container = std::str::from_utf8(&container)
        .map_err(|_| crate::failure::EPUB_BAD_CONTAINER.to_string())?;
    let document = xml::parse(container, roxmltree::ParsingOptions::default())
        .map_err(|_| crate::failure::EPUB_BAD_CONTAINER.to_string())?;
    let package_href = document
        .descendants()
        .find(|node| node.tag_name().name() == "rootfile")
        .and_then(|node| node.attribute("full-path"))
        .ok_or_else(|| crate::failure::EPUB_NO_PACKAGE.to_string())?;
    let package_path = cover::archive_path_candidates("", package_href)
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
fn recover_package(package: String) -> Result<String, String> {
    match xml::parse(&package, roxmltree::ParsingOptions::default()) {
        Ok(_) => Ok(package),
        Err(xml::XmlError::Parse(roxmltree::Error::UnknownNamespace(prefix, _)))
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

fn parse_package(package: &str) -> Result<roxmltree::Document<'_>, String> {
    xml::parse(package, roxmltree::ParsingOptions::default())
        .map_err(|_| crate::failure::EPUB_INVALID_PACKAGE.to_string())
}

fn field(node: roxmltree::Node<'_, '_>, name: &str) -> Option<String> {
    node.children()
        .find(|child| child.tag_name().name() == name)
        .and_then(|child| child.text())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

pub(super) fn entry_exists<R: Read + std::io::Seek>(
    archive: &ZipArchive<R>,
    requested: &str,
) -> bool {
    archive
        .file_names()
        .any(|name| name == requested || name.eq_ignore_ascii_case(requested))
}

pub(super) fn read_entry_flexible<R: Read + std::io::Seek>(
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, path::Path};
    use tempfile::tempdir;
    use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfixture";
    const JPEG: &[u8] = b"\xff\xd8\xfffixture";
    const START: &[u8] =
        br#"<html xmlns="http://www.w3.org/1999/xhtml"><body><p>Start</p></body></html>"#;

    fn validate(source: File) -> Result<(), String> {
        validate_archive(&mut open_archive(source)?)
    }

    #[test]
    #[ignore = "requires an explicit read-only corpus file list"]
    fn real_corpus_package_audit() {
        let list = std::env::var("KOMORI_EPUB_LIST").expect("set KOMORI_EPUB_LIST");
        let paths: Vec<String> = serde_json::from_slice(&std::fs::read(list).unwrap()).unwrap();
        let mut failures = 0;
        for (index, path) in paths.iter().enumerate() {
            if let Err(error) = validate(File::open(path).unwrap()) {
                failures += 1;
                println!("sample {index}: {error}");
            }
        }
        println!("packages: {}, refused: {failures}", paths.len());
    }

    fn fixture(path: &Path, package: &str, entries: &[(&str, &[u8])]) {
        let file = File::create(path).unwrap();
        let mut archive = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        archive
            .start_file("META-INF/container.xml", options)
            .unwrap();
        archive
            .write_all(
                br#"<?xml version="1.0"?><container><rootfiles><rootfile full-path="OPS/package.opf"/></rootfiles></container>"#,
            )
            .unwrap();
        archive.start_file("OPS/package.opf", options).unwrap();
        archive.write_all(package.as_bytes()).unwrap();
        archive.start_file("OPS/Text/start.xhtml", options).unwrap();
        archive.write_all(START).unwrap();
        for (name, bytes) in entries {
            archive.start_file(name, options).unwrap();
            archive.write_all(bytes).unwrap();
        }
        archive.finish().unwrap();
    }

    fn package(metadata: &str, manifest: &str, guide: &str) -> String {
        format!(
            r#"<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Fixture</dc:title>{metadata}</metadata><manifest><item id="start" href="Text/start.xhtml" media-type="application/xhtml+xml"/>{manifest}</manifest><spine><itemref idref="start"/></spine>{guide}</package>"#
        )
    }

    fn resolved(path: &Path) -> ResolvedCover {
        read(File::open(path).unwrap()).unwrap().cover.unwrap()
    }

    #[test]
    fn validation_checks_package_without_requiring_a_cover() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("coverless.epub");
        fixture(&path, &package("", "", ""), &[]);
        assert!(validate(File::open(&path).unwrap()).is_ok());

        let broken = directory.path().join("broken.epub");
        fixture(&broken, "<package><metadata>", &[]);
        assert!(validate(File::open(&broken).unwrap()).is_err());

        let not_zip = directory.path().join("plain.epub");
        std::fs::write(&not_zip, b"not an EPUB").unwrap();
        assert!(validate(File::open(&not_zip).unwrap()).is_err());
    }

    #[test]
    fn validation_and_import_require_a_package_with_a_readable_spine_item() {
        let directory = tempdir().unwrap();
        let item =
            r#"<item id="start" href="Text/start.xhtml" media-type="application/xhtml+xml"/>"#;
        let opened = |name: &str, package: &str| {
            let path = directory.path().join(name);
            fixture(&path, package, &[]);
            (
                validate(File::open(&path).unwrap()),
                read(File::open(&path).unwrap()).map(|_| ()),
            )
        };
        let refused = [
            ("arbitrary.epub", r#"<?xml version="1.0"?><note><to>Reader</to></note>"#.to_owned()),
            ("no-manifest.epub", r#"<package><metadata/><spine><itemref idref="start"/></spine></package>"#.to_owned()),
            ("no-spine.epub", format!("<package><metadata/><manifest>{item}</manifest></package>")),
            ("empty-spine.epub", format!("<package><metadata/><manifest>{item}</manifest><spine/></package>")),
            ("dangling.epub", format!(r#"<package><metadata/><manifest>{item}</manifest><spine><itemref idref="missing"/></spine></package>"#)),
            ("absent-file.epub", r#"<package><metadata/><manifest><item id="gone" href="Text/gone.xhtml"/></manifest><spine><itemref idref="gone"/></spine></package>"#.to_owned()),
            ("nested-spine.epub", format!(r#"<package><metadata/><manifest>{item}</manifest><extra><spine><itemref idref="start"/></spine></extra></package>"#)),
        ];
        for (name, package) in refused {
            let (validated, imported) = opened(name, &package);
            assert_eq!(
                validated.unwrap_err(),
                crate::failure::EPUB_INVALID_PACKAGE,
                "{name}"
            );
            assert_eq!(
                imported.unwrap_err(),
                crate::failure::EPUB_INVALID_PACKAGE,
                "{name}"
            );
        }
        let (validated, imported) = opened(
            "dangling-then-readable.epub",
            &format!(
                r#"<package><metadata/><manifest><item id="gone" href="gone.xhtml"/>{item}</manifest><spine><itemref idref="gone"/><itemref idref="start"/></spine></package>"#
            ),
        );
        assert!(validated.is_ok() && imported.is_ok());
        let (validated, imported) = opened(
            "encoded.epub",
            r#"<opf:package xmlns:opf="http://www.idpf.org/2007/opf"><opf:manifest><opf:item id="s" href="Text/%73tart.xhtml#top"/></opf:manifest><opf:spine><opf:itemref idref="s"/></opf:spine></opf:package>"#,
        );
        assert!(validated.is_ok() && imported.is_ok());
    }

    #[test]
    fn missing_dc_namespace_recovery_is_strict_and_bounded() {
        let original = "<package\nversion=\"3.0\"><metadata><dc:title xmlns:dc=\"http://purl.org/dc/elements/1.1/\">Title</dc:title><dc:language>ja</dc:language></metadata></package>";
        let recovered = recover_package(original.into()).unwrap();
        let doc = parse_package(&recovered).unwrap();
        assert_eq!(
            field(
                doc.descendants()
                    .find(|n| n.has_tag_name("metadata"))
                    .unwrap(),
                "title"
            )
            .as_deref(),
            Some("Title")
        );
        let valid = package("<dc:language>ja</dc:language>", "", "");
        assert_eq!(recover_package(valid.clone()).unwrap(), valid);
        for refused in [
            "<package version=\"3\"><metadata><unknown:title>Title</unknown:title></metadata></package>",
            "<package version=\"3\"><metadata><dc:title>Title</metadata></package>",
            "<!DOCTYPE package [<!ENTITY x SYSTEM 'file:///secret'>]><package version=\"3\"><dc:title>&x;</dc:title></package>",
        ] { assert!(recover_package(refused.into()).is_err()); }
        let directory = tempdir().unwrap();
        let path = directory.path().join("oversized.epub");
        let oversized = format!(
            "<package version=\"3\"><metadata><dc:title>{}</dc:title></metadata></package>",
            "a".repeat(MAX_XML_BYTES)
        );
        fixture(&path, &oversized, &[]);
        assert!(validate(File::open(&path).unwrap()).is_err());
    }

    #[test]
    fn epub3_direct_cover_allows_real_corpus_sized_payloads() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("large.epub");
        let mut image = Vec::from(JPEG);
        image.resize(3 * 1024 * 1024, 0);
        fixture(
            &path,
            &package(
                "",
                r#"<item id="art" href="Images/art.dat" media-type="application/octet-stream" properties="cover-image"/>"#,
                "",
            ),
            &[("OPS/Images/art.dat", &image)],
        );

        let metadata = read(File::open(&path).unwrap()).unwrap();
        assert_eq!(
            metadata.cover_diagnostic,
            CoverDiagnostic::Resolved("epub3-cover-image")
        );
        let cover = metadata.cover.unwrap();
        assert_eq!(cover.discovery, "epub3-cover-image");
        assert_eq!(cover.mime, "image/jpeg");
        assert_eq!(cover.bytes.len(), image.len());
    }

    #[test]
    fn epub2_metadata_resolves_nested_percent_encoded_case_mismatched_path() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("epub2.epub");
        fixture(
            &path,
            &package(
                r#"<meta name="cover" content="cover-art"/>"#,
                r#"<item id="cover-art" href="Text/../Images/Cover%20Art.bin" media-type="application/octet-stream"/>"#,
                "",
            ),
            &[("OPS/images/cover art.bin", JPEG)],
        );

        let cover = resolved(&path);
        assert_eq!(cover.discovery, "epub2-meta-cover");
        assert_eq!(cover.mime, "image/jpeg");
    }

    #[test]
    fn container_package_and_cover_refuse_an_element_past_the_attribute_limit() {
        const ATTRIBUTES: &str = r#" a="1" b="2" c="3" d="4" e="5""#;
        let directory = tempdir().unwrap();
        xml::with_attribute_limit(4, || {
            let container = directory.path().join("container.epub");
            let mut archive = ZipWriter::new(File::create(&container).unwrap());
            archive
                .start_file("META-INF/container.xml", SimpleFileOptions::default())
                .unwrap();
            write!(
                archive,
                r#"<container><rootfiles><rootfile full-path="OPS/package.opf"{ATTRIBUTES}/></rootfiles></container>"#
            )
            .unwrap();
            archive
                .start_file("OPS/package.opf", SimpleFileOptions::default())
                .unwrap();
            archive.write_all(package("", "", "").as_bytes()).unwrap();
            archive.finish().unwrap();
            assert_eq!(
                validate(File::open(&container).unwrap()).unwrap_err(),
                crate::failure::EPUB_BAD_CONTAINER
            );

            let wide_package = directory.path().join("package.epub");
            fixture(
                &wide_package,
                &package(&format!("<meta{ATTRIBUTES}/>"), "", ""),
                &[],
            );
            assert!(matches!(
                validate(File::open(&wide_package).unwrap())
                    .unwrap_err()
                    .as_str(),
                crate::failure::EPUB_INVALID_PACKAGE | crate::failure::EPUB_BROKEN_PACKAGE
            ));

            let manifest = r#"<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml" properties="cover-image"/><item id="art" href="Images/art.png" media-type="image/png"/>"#;
            for (name, image, found) in [
                ("plain.epub", String::new(), true),
                ("wide.epub", ATTRIBUTES.to_owned(), false),
            ] {
                let path = directory.path().join(name);
                let wrapper = format!(
                    r#"<?xml version="1.0"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><body><img src="Images/art.png"{image}/></body></html>"#
                );
                fixture(
                    &path,
                    &package("", manifest, ""),
                    &[
                        ("OPS/cover.xhtml", wrapper.as_bytes()),
                        ("OPS/Images/art.png", PNG),
                    ],
                );
                assert!(validate(File::open(&path).unwrap()).is_ok());
                let metadata = read(File::open(&path).unwrap()).unwrap();
                assert_eq!(metadata.cover.is_some(), found, "{name}");
            }
        });
    }

    #[test]
    fn guide_cover_unwraps_xhtml_image() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("guide.epub");
        fixture(
            &path,
            &package(
                "",
                r#"<item id="title" href="Text/title.xhtml" media-type="application/xhtml+xml"/><item id="art" href="Images/Cover Art.png" media-type="image/png"/>"#,
                r#"<guide><reference type="cover" href="Text/title.xhtml"/></guide>"#,
            ),
            &[
                (
                    "OPS/Text/title.xhtml",
                    br#"<?xml version="1.0"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><body><img src="../Images/Cover%20Art.png"/></body></html>"#,
                ),
                ("OPS/Images/Cover Art.png", PNG),
            ],
        );

        let cover = resolved(&path);
        assert_eq!(cover.discovery, "package-guide-cover-document");
        assert_eq!(cover.mime, "image/png");
    }

    #[test]
    fn ordinary_doctype_cover_wrapper_still_resolves() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("doctype.epub");
        fixture(
            &path,
            &package(
                "",
                r#"<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml" properties="cover-image"/><item id="art" href="Images/cover.png" media-type="image/png"/>"#,
                "",
            ),
            &[
                (
                    "OPS/cover.xhtml",
                    br#"<?xml version="1.0"?><!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><body><img src="Images/cover.png"/></body></html>"#,
                ),
                ("OPS/Images/cover.png", PNG),
            ],
        );

        let cover = resolved(&path);
        assert_eq!(cover.discovery, "epub3-cover-document");
        assert_eq!(cover.mime, "image/png");
    }

    #[test]
    fn cover_wrapper_declaring_entities_is_rejected_before_expansion() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("entities.epub");
        let wrapper = format!(
            r#"<?xml version="1.0"?><!DOCTYPE html [<!ENTITY e "synthetic">]><html xmlns="http://www.w3.org/1999/xhtml"><body><p>{}</p><img src="Images/art.png"/></body></html>"#,
            "&e;".repeat(64)
        );
        fixture(
            &path,
            &package(
                "",
                r#"<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml" properties="cover-image"/><item id="art" href="Images/art.png" media-type="image/png"/>"#,
                "",
            ),
            &[
                ("OPS/cover.xhtml", wrapper.as_bytes()),
                ("OPS/Images/art.png", PNG),
            ],
        );

        let metadata = read(File::open(path).unwrap()).unwrap();
        assert!(metadata.cover.is_none());
        assert_eq!(metadata.cover_diagnostic, CoverDiagnostic::RejectedSafety);
    }

    #[test]
    fn epub3_svg_wrapper_resolves_xlink_image_reference() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("svg.epub");
        fixture(
            &path,
            &package(
                "",
                r#"<item id="cover" href="cover.svg" media-type="image/svg+xml" properties="cover-image"/>"#,
                "",
            ),
            &[
                (
                    "OPS/cover.svg",
                    b"<?xml version=\"1.0\"?><svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\"><image xlink:href=\"Images/cover.jpg\"/></svg>\xfftrailing",
                ),
                ("OPS/Images/cover.jpg", JPEG),
            ],
        );

        let cover = resolved(&path);
        assert_eq!(cover.discovery, "epub3-cover-document");
        assert_eq!(cover.mime, "image/jpeg");
    }

    #[test]
    fn broken_epub3_candidate_falls_back_to_valid_epub2_metadata() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("fallback.epub");
        fixture(
            &path,
            &package(
                r#"<meta name="cover" content="raster"/>"#,
                r#"<item id="broken" href="cover.svg" media-type="image/svg+xml" properties="cover-image"/><item id="raster" href="Images/cover.jpg" media-type="image/jpeg"/>"#,
                "",
            ),
            &[("OPS/cover.svg", b""), ("OPS/Images/cover.jpg", JPEG)],
        );

        let cover = resolved(&path);
        assert_eq!(cover.discovery, "epub2-meta-cover");
    }

    #[test]
    fn strongly_named_cover_document_is_a_defensible_fallback() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("named.epub");
        fixture(
            &path,
            &package(
                "",
                r#"<item id="cover" href="Text/cover.xhtml" media-type="application/xhtml+xml"/><item id="image" href="Images/Cover.jpg" media-type="image/jpeg"/>"#,
                "",
            ),
            &[
                (
                    "OPS/Text/cover.xhtml",
                    br#"<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><section epub:type="cover"><img src="../Images/Cover.jpg"/></section></body></html>"#,
                ),
                ("OPS/Images/Cover.jpg", JPEG),
            ],
        );

        assert_eq!(resolved(&path).discovery, "manifest-named-cover-document");
    }

    #[test]
    fn arbitrary_first_illustration_is_not_used_as_cover() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("illustration.epub");
        fixture(
            &path,
            &package(
                "",
                r#"<item id="illustration01" href="Images/001.jpg" media-type="image/jpeg"/>"#,
                "",
            ),
            &[("OPS/Images/001.jpg", JPEG)],
        );

        let metadata = read(File::open(path).unwrap()).unwrap();
        assert!(metadata.cover.is_none());
        assert_eq!(
            metadata.cover_diagnostic,
            CoverDiagnostic::NoCredibleEvidence
        );
    }

    #[test]
    fn oversized_cover_is_rejected() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("oversized.epub");
        let mut image = Vec::from(PNG);
        image.resize(cover::MAX_COVER_BYTES + 1, 0);
        fixture(
            &path,
            &package(
                "",
                r#"<item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>"#,
                "",
            ),
            &[("OPS/cover.png", &image)],
        );

        let metadata = read(File::open(path).unwrap()).unwrap();
        assert!(metadata.cover.is_none());
        assert_eq!(metadata.cover_diagnostic, CoverDiagnostic::RejectedSafety);
    }

    #[test]
    fn css_background_cover_is_reported_as_unsupported_not_guessed() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("css-cover.epub");
        fixture(
            &path,
            &package(
                "",
                r#"<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml" properties="cover-image"/><item id="art" href="Images/art.jpg" media-type="image/jpeg"/>"#,
                "",
            ),
            &[
                (
                    "OPS/cover.xhtml",
                    br#"<html xmlns="http://www.w3.org/1999/xhtml"><head><style>body { background-image: url('Images/art.jpg'); }</style></head><body/></html>"#,
                ),
                ("OPS/Images/art.jpg", JPEG),
            ],
        );

        let metadata = read(File::open(path).unwrap()).unwrap();
        assert!(metadata.cover.is_none());
        assert_eq!(
            metadata.cover_diagnostic,
            CoverDiagnostic::UnsupportedRepresentation
        );
    }

    #[test]
    fn svg_only_cover_art_is_reported_as_unsupported() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("vector-cover.epub");
        fixture(
            &path,
            &package(
                "",
                r#"<item id="cover" href="cover.svg" media-type="image/svg+xml" properties="cover-image"/>"#,
                "",
            ),
            &[(
                "OPS/cover.svg",
                br##"<svg xmlns="http://www.w3.org/2000/svg"><rect width="100" height="160" fill="#123456"/></svg>"##,
            )],
        );

        let metadata = read(File::open(path).unwrap()).unwrap();
        assert!(metadata.cover.is_none());
        assert_eq!(
            metadata.cover_diagnostic,
            CoverDiagnostic::UnsupportedRepresentation
        );
    }

    #[test]
    fn missing_explicit_cover_target_is_reported_as_invalid() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("missing-cover.epub");
        fixture(
            &path,
            &package(
                "",
                r#"<item id="cover" href="Images/missing.jpg" media-type="image/jpeg" properties="cover-image"/>"#,
                "",
            ),
            &[],
        );

        let metadata = read(File::open(path).unwrap()).unwrap();
        assert!(metadata.cover.is_none());
        assert_eq!(metadata.cover_diagnostic, CoverDiagnostic::InvalidTarget);
    }
}
