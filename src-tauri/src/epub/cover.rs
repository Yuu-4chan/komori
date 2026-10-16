use std::io::{Read, Seek};

use base64::{engine::general_purpose::STANDARD, Engine};
use roxmltree::{Document, Node, ParsingOptions};
use zip::ZipArchive;

pub(super) const MAX_COVER_BYTES: usize = 4 * 1024 * 1024;
const MAX_COVER_DOCUMENT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug)]
pub(crate) struct ResolvedCover {
    pub(crate) mime: String,
    pub(crate) bytes: Vec<u8>,
    pub(crate) discovery: &'static str,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CoverDiagnostic {
    Resolved(&'static str),
    NoCredibleEvidence,
    UnsupportedRepresentation,
    InvalidTarget,
    RejectedSafety,
}

impl CoverDiagnostic {
    pub(crate) fn code(self) -> &'static str {
        match self {
            Self::Resolved(method) => method,
            Self::NoCredibleEvidence => "no-credible-cover-evidence",
            Self::UnsupportedRepresentation => "unsupported-cover-representation",
            Self::InvalidTarget => "invalid-or-unreadable-cover-target",
            Self::RejectedSafety => "cover-rejected-by-safety-rules",
        }
    }
}

pub(crate) struct CoverResolution {
    pub(crate) cover: Option<ResolvedCover>,
    pub(crate) diagnostic: CoverDiagnostic,
}

#[derive(Clone, Copy)]
enum Evidence {
    Epub3,
    Epub2,
    Guide,
    ManifestName,
}

struct Candidate<'a> {
    href: &'a str,
    media_type: Option<&'a str>,
    evidence: Evidence,
}

struct CandidateResult {
    mime: &'static str,
    bytes: Vec<u8>,
    document: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CandidateFailure {
    InvalidTarget,
    UnsupportedRepresentation,
    RejectedSafety,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum EntryReadError {
    Missing,
    Unreadable,
    TooLarge,
}

pub(super) fn discover<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    package_path: &str,
    package: &Document<'_>,
) -> CoverResolution {
    let package_directory = package_path
        .rsplit_once('/')
        .map_or("", |(directory, _)| directory);
    let manifest_items: Vec<_> = package
        .descendants()
        .filter(|node| node.tag_name().name() == "item")
        .collect();
    let mut candidates = Vec::new();

    for item in &manifest_items {
        if has_property(*item, "cover-image") {
            if let Some(href) = item.attribute("href") {
                candidates.push(Candidate {
                    href,
                    media_type: item.attribute("media-type"),
                    evidence: Evidence::Epub3,
                });
            }
        }
    }

    for cover_id in package.descendants().filter_map(|node| {
        (node.tag_name().name() == "meta"
            && node
                .attribute("name")
                .is_some_and(|name| name.eq_ignore_ascii_case("cover")))
        .then(|| node.attribute("content"))
        .flatten()
    }) {
        let cover_id = cover_id.trim_start_matches('#');
        if let Some(item) = manifest_items
            .iter()
            .find(|item| item.attribute("id") == Some(cover_id))
        {
            if let Some(href) = item.attribute("href") {
                candidates.push(Candidate {
                    href,
                    media_type: item.attribute("media-type"),
                    evidence: Evidence::Epub2,
                });
            }
        }
    }

    for reference in package.descendants().filter(|node| {
        node.tag_name().name() == "reference"
            && node.attribute("type").is_some_and(|value| {
                value
                    .split_whitespace()
                    .any(|part| part.eq_ignore_ascii_case("cover"))
            })
    }) {
        if let Some(href) = reference.attribute("href") {
            candidates.push(Candidate {
                href,
                media_type: manifest_items
                    .iter()
                    .find(|item| item.attribute("href") == Some(href))
                    .and_then(|item| item.attribute("media-type")),
                evidence: Evidence::Guide,
            });
        }
    }

    for item in manifest_items {
        if strong_cover_name(item) {
            if let Some(href) = item.attribute("href") {
                candidates.push(Candidate {
                    href,
                    media_type: item.attribute("media-type"),
                    evidence: Evidence::ManifestName,
                });
            }
        }
    }

    if candidates.is_empty() {
        return CoverResolution {
            cover: None,
            diagnostic: CoverDiagnostic::NoCredibleEvidence,
        };
    }

    let mut strongest_failure = CandidateFailure::InvalidTarget;
    for candidate in candidates {
        match resolve_candidate(
            archive,
            package_directory,
            candidate.href,
            candidate.media_type,
        ) {
            Ok(resolved) => {
                let discovery = discovery_name(candidate.evidence, resolved.document);
                return CoverResolution {
                    cover: Some(ResolvedCover {
                        mime: resolved.mime.to_string(),
                        bytes: resolved.bytes,
                        discovery,
                    }),
                    diagnostic: CoverDiagnostic::Resolved(discovery),
                };
            }
            Err(failure) => strongest_failure = merge_failure(strongest_failure, failure),
        }
    }

    CoverResolution {
        cover: None,
        diagnostic: match strongest_failure {
            CandidateFailure::InvalidTarget => CoverDiagnostic::InvalidTarget,
            CandidateFailure::UnsupportedRepresentation => {
                CoverDiagnostic::UnsupportedRepresentation
            }
            CandidateFailure::RejectedSafety => CoverDiagnostic::RejectedSafety,
        },
    }
}

fn resolve_candidate<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    base: &str,
    href: &str,
    media_type: Option<&str>,
) -> Result<CandidateResult, CandidateFailure> {
    if href.trim_start().to_ascii_lowercase().starts_with("data:") {
        return decode_data_image(href).map(|(mime, bytes)| CandidateResult {
            mime,
            bytes,
            document: true,
        });
    }

    let paths = archive_path_candidates(base, href);
    if paths.is_empty() {
        return Err(CandidateFailure::InvalidTarget);
    }
    let mut strongest_failure = CandidateFailure::InvalidTarget;
    for path in paths {
        let is_document = document_hint(&path, media_type);
        let limit = if is_document {
            MAX_COVER_DOCUMENT_BYTES
        } else {
            MAX_COVER_BYTES
        };
        let bytes = match read_cover_entry(archive, &path, limit) {
            Ok(bytes) => bytes,
            Err(EntryReadError::TooLarge) => {
                strongest_failure =
                    merge_failure(strongest_failure, CandidateFailure::RejectedSafety);
                continue;
            }
            Err(EntryReadError::Missing | EntryReadError::Unreadable) => continue,
        };
        if let Some(mime) = image_mime(&bytes) {
            return Ok(CandidateResult {
                mime,
                bytes,
                document: false,
            });
        }
        if bytes.is_empty() {
            continue;
        }
        let document_bytes = trim_after_document_root(&bytes);
        if declares_entity(document_bytes) {
            strongest_failure = merge_failure(strongest_failure, CandidateFailure::RejectedSafety);
            continue;
        }
        let text = String::from_utf8_lossy(document_bytes);
        let Ok(document) = super::xml::parse(
            &text,
            ParsingOptions {
                allow_dtd: true,
                ..ParsingOptions::default()
            },
        ) else {
            if !is_document {
                strongest_failure = merge_failure(
                    strongest_failure,
                    CandidateFailure::UnsupportedRepresentation,
                );
            }
            continue;
        };
        let document_directory = path.rsplit_once('/').map_or("", |(directory, _)| directory);
        let mut found_image_reference = false;
        for image_href in document.descendants().filter_map(image_reference) {
            found_image_reference = true;
            match resolve_image_reference(archive, document_directory, image_href) {
                Ok((mime, bytes)) => {
                    return Ok(CandidateResult {
                        mime,
                        bytes,
                        document: true,
                    });
                }
                Err(failure) => strongest_failure = merge_failure(strongest_failure, failure),
            }
        }
        if !found_image_reference {
            strongest_failure = merge_failure(
                strongest_failure,
                CandidateFailure::UnsupportedRepresentation,
            );
        }
    }
    Err(strongest_failure)
}

fn resolve_image_reference<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    base: &str,
    href: &str,
) -> Result<(&'static str, Vec<u8>), CandidateFailure> {
    if href.trim_start().to_ascii_lowercase().starts_with("data:") {
        return decode_data_image(href);
    }
    let paths = archive_path_candidates(base, href);
    if paths.is_empty() {
        return Err(CandidateFailure::InvalidTarget);
    }
    let mut strongest_failure = CandidateFailure::InvalidTarget;
    for path in paths {
        match read_cover_entry(archive, &path, MAX_COVER_BYTES) {
            Ok(bytes) => {
                if let Some(mime) = image_mime(&bytes) {
                    return Ok((mime, bytes));
                }
                strongest_failure = merge_failure(
                    strongest_failure,
                    CandidateFailure::UnsupportedRepresentation,
                );
            }
            Err(EntryReadError::TooLarge) => {
                strongest_failure =
                    merge_failure(strongest_failure, CandidateFailure::RejectedSafety)
            }
            Err(EntryReadError::Missing | EntryReadError::Unreadable) => {}
        }
    }
    Err(strongest_failure)
}

fn read_cover_entry<R: Read + Seek>(
    archive: &mut ZipArchive<R>,
    requested: &str,
    limit: usize,
) -> Result<Vec<u8>, EntryReadError> {
    let actual_name = archive
        .file_names()
        .find(|name| *name == requested)
        .or_else(|| {
            archive
                .file_names()
                .find(|name| name.eq_ignore_ascii_case(requested))
        })
        .map(str::to_owned)
        .ok_or(EntryReadError::Missing)?;
    let entry = archive
        .by_name(&actual_name)
        .map_err(|_| EntryReadError::Unreadable)?;
    if entry.size() > limit as u64 {
        return Err(EntryReadError::TooLarge);
    }
    let mut bytes = Vec::new();
    entry
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| EntryReadError::Unreadable)?;
    if bytes.len() > limit {
        return Err(EntryReadError::TooLarge);
    }
    Ok(bytes)
}

fn merge_failure(current: CandidateFailure, next: CandidateFailure) -> CandidateFailure {
    match (current, next) {
        (CandidateFailure::RejectedSafety, _) | (_, CandidateFailure::RejectedSafety) => {
            CandidateFailure::RejectedSafety
        }
        (CandidateFailure::UnsupportedRepresentation, _)
        | (_, CandidateFailure::UnsupportedRepresentation) => {
            CandidateFailure::UnsupportedRepresentation
        }
        _ => CandidateFailure::InvalidTarget,
    }
}

// The parser expands internal entities without an aggregate budget, so a small
// wrapper could expand to gigabytes. Cover wrappers have no use for entities.
fn declares_entity(bytes: &[u8]) -> bool {
    const DECLARATION: &[u8] = b"<!ENTITY";
    bytes
        .windows(DECLARATION.len())
        .any(|window| window.eq_ignore_ascii_case(DECLARATION))
}

fn trim_after_document_root(bytes: &[u8]) -> &[u8] {
    for closing in [b"</html>".as_slice(), b"</svg>".as_slice()] {
        if let Some(start) = bytes
            .windows(closing.len())
            .rposition(|window| window.eq_ignore_ascii_case(closing))
        {
            return &bytes[..start + closing.len()];
        }
    }
    bytes
}

fn has_property(node: Node<'_, '_>, expected: &str) -> bool {
    node.attribute("properties").is_some_and(|properties| {
        properties
            .split_whitespace()
            .any(|property| property.eq_ignore_ascii_case(expected))
    })
}

fn strong_cover_name(node: Node<'_, '_>) -> bool {
    node.attribute("id").is_some_and(is_cover_name)
        || node
            .attribute("href")
            .and_then(|href| {
                href.split(['?', '#'])
                    .next()
                    .and_then(|path| path.rsplit('/').next())
                    .and_then(|file| {
                        file.rsplit_once('.')
                            .map_or(Some(file), |(stem, _)| Some(stem))
                    })
            })
            .is_some_and(is_cover_name)
}

fn is_cover_name(value: &str) -> bool {
    let normalized: String = value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect();
    matches!(
        normalized.as_str(),
        "cover" | "coverimage" | "coverpage" | "frontcover"
    )
}

fn image_reference<'input>(node: Node<'input, 'input>) -> Option<&'input str> {
    match node.tag_name().name().to_ascii_lowercase().as_str() {
        "img" => node.attribute("src"),
        "image" => node
            .attributes()
            .find(|attribute| matches!(attribute.name(), "href" | "src"))
            .map(|attribute| attribute.value()),
        _ => None,
    }
}

fn document_hint(path: &str, media_type: Option<&str>) -> bool {
    let extension = path
        .rsplit_once('.')
        .map(|(_, extension)| extension)
        .unwrap_or_default();
    matches!(
        extension.to_ascii_lowercase().as_str(),
        "xhtml" | "html" | "htm" | "svg" | "xml"
    ) || media_type.is_some_and(|media_type| {
        matches!(
            media_type.to_ascii_lowercase().as_str(),
            "application/xhtml+xml" | "text/html" | "image/svg+xml" | "application/xml"
        )
    })
}

fn discovery_name(evidence: Evidence, document: bool) -> &'static str {
    match (evidence, document) {
        (Evidence::Epub3, false) => "epub3-cover-image",
        (Evidence::Epub3, true) => "epub3-cover-document",
        (Evidence::Epub2, false) => "epub2-meta-cover",
        (Evidence::Epub2, true) => "epub2-meta-cover-document",
        (Evidence::Guide, false) => "package-guide-cover",
        (Evidence::Guide, true) => "package-guide-cover-document",
        (Evidence::ManifestName, false) => "manifest-named-cover",
        (Evidence::ManifestName, true) => "manifest-named-cover-document",
    }
}

pub(super) fn archive_path_candidates(base: &str, href: &str) -> Vec<String> {
    let raw = href
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .replace('\\', "/");
    let mut candidates = Vec::new();
    if let Some(decoded) = percent_decode(&raw) {
        if let Some(path) = normalize_archive_path(base, &decoded) {
            candidates.push(path);
        }
    }
    if let Some(path) = normalize_archive_path(base, &raw) {
        if !candidates.contains(&path) {
            candidates.push(path);
        }
    }
    candidates
}

fn normalize_archive_path(base: &str, href: &str) -> Option<String> {
    let mut parts: Vec<&str> = if href.starts_with('/') {
        Vec::new()
    } else {
        base.split('/').filter(|part| !part.is_empty()).collect()
    };
    for part in href.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            part if part.contains(':') || part.contains('\0') => return None,
            part => parts.push(part),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let high = hex(bytes[index + 1])?;
            let low = hex(bytes[index + 2])?;
            decoded.push((high << 4) | low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn decode_data_image(value: &str) -> Result<(&'static str, Vec<u8>), CandidateFailure> {
    let (header, payload) = value
        .split_once(',')
        .ok_or(CandidateFailure::UnsupportedRepresentation)?;
    if !header.to_ascii_lowercase().starts_with("data:image/")
        || !header.to_ascii_lowercase().ends_with(";base64")
    {
        return Err(CandidateFailure::UnsupportedRepresentation);
    }
    let bytes = STANDARD
        .decode(payload.trim())
        .map_err(|_| CandidateFailure::InvalidTarget)?;
    if bytes.len() > MAX_COVER_BYTES {
        return Err(CandidateFailure::RejectedSafety);
    }
    image_mime(&bytes)
        .map(|mime| (mime, bytes))
        .ok_or(CandidateFailure::UnsupportedRepresentation)
}

fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else if bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*") {
        Some("image/tiff")
    } else if bytes.get(4..12) == Some(b"ftypavif") || bytes.get(4..12) == Some(b"ftypavis") {
        Some("image/avif")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_resolution_decodes_and_stays_inside_archive() {
        assert_eq!(
            archive_path_candidates("OPS/Text", "../Images/Cover%20Art.bin"),
            ["OPS/Images/Cover Art.bin", "OPS/Images/Cover%20Art.bin"]
        );
        assert!(archive_path_candidates("OPS", "../../private.jpg").is_empty());
        assert!(archive_path_candidates("", "C:/private.jpg").is_empty());
    }

    #[test]
    fn fallback_names_require_specific_cover_evidence() {
        assert!(is_cover_name("cover-image"));
        assert!(is_cover_name("Front_Cover"));
        assert!(!is_cover_name("illustration01"));
        assert!(!is_cover_name("discover"));
    }
}
