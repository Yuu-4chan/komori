//! The little HTTP/1.1 the PC's device server speaks inside TLS: one bounded request per
//! connection, answered and closed.

use std::io::{self, Read, Write};

/// The most a request's line and headers may take.
const HEAD_LIMIT: usize = 16 * 1024;
/// The most a request's body may take; only pairing sends one.
const BODY_LIMIT: usize = 64 * 1024;

#[derive(Debug)]
pub(crate) struct Request {
    pub(crate) method: String,
    pub(crate) path: String,
    pub(crate) authorization: Option<String>,
    pub(crate) body: Vec<u8>,
}

#[derive(Debug, PartialEq)]
pub(crate) enum ReadError {
    /// The connection closed or failed before a whole request.
    Closed,
    /// Not a request Komori answers.
    Malformed,
    TooLarge,
}

pub(crate) fn read_request(stream: &mut impl Read) -> Result<Request, ReadError> {
    let mut head = Vec::with_capacity(1024);
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if head.len() >= HEAD_LIMIT {
            return Err(ReadError::TooLarge);
        }
        match stream.read(&mut byte) {
            Ok(0) | Err(_) => return Err(ReadError::Closed),
            Ok(_) => head.push(byte[0]),
        }
    }
    let head = std::str::from_utf8(&head).map_err(|_| ReadError::Malformed)?;
    let mut lines = head.split("\r\n");
    let mut start = lines.next().ok_or(ReadError::Malformed)?.split(' ');
    let (Some(method), Some(path), Some(version)) = (start.next(), start.next(), start.next())
    else {
        return Err(ReadError::Malformed);
    };
    if !version.starts_with("HTTP/1.") || !path.starts_with('/') {
        return Err(ReadError::Malformed);
    }
    let mut length = 0usize;
    let mut authorization = None;
    for line in lines.filter(|line| !line.is_empty()) {
        let (name, value) = line.split_once(':').ok_or(ReadError::Malformed)?;
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-length") {
            length = value.parse().map_err(|_| ReadError::Malformed)?;
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            // Komori's phone sends lengths; anything chunked is not from it.
            return Err(ReadError::Malformed);
        } else if name.eq_ignore_ascii_case("authorization") {
            authorization = value.strip_prefix("Bearer ").map(str::to_owned);
        }
    }
    if length > BODY_LIMIT {
        return Err(ReadError::TooLarge);
    }
    let mut body = vec![0u8; length];
    stream
        .read_exact(&mut body)
        .map_err(|_| ReadError::Closed)?;
    Ok(Request {
        method: method.to_owned(),
        path: path.to_owned(),
        authorization,
        body,
    })
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        413 => "Payload Too Large",
        _ => "Internal Server Error",
    }
}

fn write_head(stream: &mut impl Write, status: u16, kind: &str, length: u64) -> io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status} {}\r\nContent-Type: {kind}\r\nContent-Length: {length}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        reason(status)
    )
}

pub(crate) fn respond(
    stream: &mut impl Write,
    status: u16,
    kind: &str,
    body: &[u8],
) -> io::Result<()> {
    write_head(stream, status, kind, body.len() as u64)?;
    stream.write_all(body)?;
    stream.flush()
}

pub(crate) fn respond_json(
    stream: &mut impl Write,
    status: u16,
    value: &impl serde::Serialize,
) -> io::Result<()> {
    let body = serde_json::to_vec(value).map_err(io::Error::other)?;
    respond(stream, status, "application/json", &body)
}

/// Answers with `length` bytes read from `source`.
pub(crate) fn respond_stream(
    stream: &mut impl Write,
    kind: &str,
    length: u64,
    source: &mut impl Read,
) -> io::Result<()> {
    write_head(stream, 200, kind, length)?;
    let copied = io::copy(&mut source.take(length), stream)?;
    if copied != length {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "the file ended early",
        ));
    }
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_request_with_its_token_and_body() {
        let mut input: &[u8] =
            b"POST /v1/pair/start HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer abc\r\nContent-Length: 2\r\n\r\n{}";
        let request = read_request(&mut input).unwrap();
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/v1/pair/start");
        assert_eq!(request.authorization.as_deref(), Some("abc"));
        assert_eq!(request.body, b"{}");
    }

    #[test]
    fn refuses_what_is_not_a_bounded_request() {
        let mut chunked: &[u8] = b"POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n";
        assert_eq!(
            read_request(&mut chunked).unwrap_err(),
            ReadError::Malformed
        );
        let big = format!(
            "POST / HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
            BODY_LIMIT + 1
        );
        assert_eq!(
            read_request(&mut big.as_bytes()).unwrap_err(),
            ReadError::TooLarge
        );
        let long = format!("GET /{} HTTP/1.1\r\n\r\n", "a".repeat(HEAD_LIMIT));
        assert_eq!(
            read_request(&mut long.as_bytes()).unwrap_err(),
            ReadError::TooLarge
        );
        let mut cut: &[u8] = b"GET / HTTP/1.1\r\n";
        assert_eq!(read_request(&mut cut).unwrap_err(), ReadError::Closed);
        let mut absolute: &[u8] = b"GET http://x/ HTTP/1.1\r\n\r\n";
        assert_eq!(
            read_request(&mut absolute).unwrap_err(),
            ReadError::Malformed
        );
    }
}
