//! The phone's side of the link with Komori PC: a client that pairs with the code the PC shows
//! and afterwards accepts only the certificate it paired with, and the requests it makes.
#![cfg_attr(desktop, allow(dead_code))]

use std::{
    io::Write,
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::CryptoProvider,
    pki_types::{CertificateDer, ServerName, UnixTime},
    DigitallySignedStruct, SignatureScheme,
};
use serde::de::DeserializeOwned;

use super::protocol::{
    self, decode, encode, Hello, PairFinish, PairStart, PairStarted, Paired, RemoteDictionary,
    RemoteLibrary,
};

/// A plain EPUB file name from the PC's listing, never a path.
pub(crate) fn safe_file_name(name: &str) -> String {
    let name: String = name
        .chars()
        .filter(|character| {
            !matches!(character, '/' | '\\' | ':' | '\0') && !character.is_control()
        })
        .collect();
    let name = name.trim().trim_start_matches('.').to_owned();
    if name.is_empty() {
        "Book.epub".into()
    } else if name.to_lowercase().ends_with(".epub") {
        name
    } else {
        format!("{name}.epub")
    }
}

/// Accepts the one certificate the phone paired with, or, while pairing, whichever certificate
/// the PC shows first, for the proofs to confirm.
#[derive(Debug)]
struct Pinned {
    expected: Option<[u8; 32]>,
    seen: Mutex<Option<[u8; 32]>>,
    /// Whether a certificate was refused, which a failed request reports as another PC.
    refused: std::sync::atomic::AtomicBool,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let fingerprint = protocol::fingerprint(end_entity.as_ref());
        let mut seen = self
            .seen
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let known = self.expected.or(*seen);
        if known.is_some_and(|known| known != fingerprint) {
            self.refused
                .store(true, std::sync::atomic::Ordering::SeqCst);
            return Err(rustls::Error::General("not the paired PC".into()));
        }
        *seen = Some(fingerprint);
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Err(rustls::Error::General("TLS 1.3 only".into()))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// Why a request to the PC failed, as the phone's screens tell it.
#[derive(Debug, PartialEq)]
pub(crate) enum LinkError {
    /// No answer at that address and port.
    Unreachable,
    /// The PC answered with another certificate than the one paired with.
    NotThePc,
    /// The code was wrong.
    WrongCode,
    /// The PC no longer knows this phone.
    NotPaired,
    /// The PC is another version of Komori.
    OtherVersion,
    /// The book or dictionary is no longer on the PC.
    NotFound,
    Failed(String),
}

impl LinkError {
    /// The code the frontend translates.
    pub(crate) fn code(&self) -> String {
        match self {
            Self::Unreachable => "unreachable".into(),
            Self::NotThePc => "notThePc".into(),
            Self::WrongCode => "wrongCode".into(),
            Self::NotPaired => "notPaired".into(),
            Self::OtherVersion => "otherVersion".into(),
            Self::NotFound => "notFound".into(),
            Self::Failed(message) => message.clone(),
        }
    }
}

/// What the phone keeps after pairing.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Pairing {
    pub(crate) pc_name: String,
    pub(crate) fingerprint: [u8; 32],
    pub(crate) token: Vec<u8>,
    pub(crate) device: String,
}

/// How long a request may take in all, so a PC that stops answering is never waited on forever.
const QUICK: Duration = Duration::from_secs(10);
const LISTING: Duration = Duration::from_secs(30);
const SYNCING: Duration = Duration::from_secs(120);

pub(crate) struct Client {
    base: String,
    http: reqwest::Client,
    verifier: Arc<Pinned>,
    token: Option<String>,
}

fn sending_error(verifier: &Pinned, error: reqwest::Error) -> LinkError {
    if verifier.refused.load(std::sync::atomic::Ordering::SeqCst) {
        return LinkError::NotThePc;
    }
    if error.is_connect() || error.is_timeout() {
        LinkError::Unreachable
    } else {
        LinkError::Failed(error.to_string())
    }
}

impl Client {
    /// A client for the PC at `address:port`; `pinned` is the certificate paired with, if any.
    pub(crate) fn new(
        address: &str,
        port: u16,
        pinned: Option<[u8; 32]>,
        token: Option<&[u8]>,
    ) -> Result<Self, LinkError> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let verifier = Arc::new(Pinned {
            expected: pinned,
            seen: Mutex::new(None),
            refused: Default::default(),
            provider: provider.clone(),
        });
        let config = rustls::ClientConfig::builder_with_provider(provider)
            .with_protocol_versions(&[&rustls::version::TLS13])
            .map_err(|error| LinkError::Failed(error.to_string()))?
            .dangerous()
            .with_custom_certificate_verifier(verifier.clone())
            .with_no_client_auth();
        let http = reqwest::Client::builder()
            .tls_backend_preconfigured(config)
            .no_proxy()
            .connect_timeout(Duration::from_secs(5))
            .read_timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent(concat!("Komori/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|error| LinkError::Failed(error.to_string()))?;
        let host = match address.parse::<std::net::IpAddr>() {
            Ok(std::net::IpAddr::V6(v6)) => format!("[{v6}]"),
            _ => address.to_owned(),
        };
        Ok(Self {
            base: format!("https://{host}:{port}"),
            http,
            verifier,
            token: token.map(encode),
        })
    }

    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let request = self.http.request(method, format!("{}{path}", self.base));
        match &self.token {
            Some(token) => request.bearer_auth(token),
            None => request,
        }
    }

    async fn send(&self, request: reqwest::RequestBuilder) -> Result<reqwest::Response, LinkError> {
        let response = request
            .send()
            .await
            .map_err(|error| sending_error(&self.verifier, error))?;
        match response.status().as_u16() {
            200 => Ok(response),
            401 => Err(LinkError::NotPaired),
            403 => {
                let body: serde_json::Value = response.json().await.unwrap_or_default();
                Err(if body["error"] == "wrongCode" {
                    LinkError::WrongCode
                } else {
                    LinkError::NotPaired
                })
            }
            404 => Err(LinkError::NotFound),
            status => Err(LinkError::Failed(format!("The PC answered {status}."))),
        }
    }

    async fn json<T: DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<T, LinkError> {
        self.send(request)
            .await?
            .json()
            .await
            .map_err(|error| LinkError::Failed(error.to_string()))
    }

    pub(crate) async fn hello(&self) -> Result<Hello, LinkError> {
        let hello: Hello = self
            .json(
                self.request(reqwest::Method::GET, "/v1/hello")
                    .timeout(QUICK),
            )
            .await?;
        if hello.protocol != protocol::PROTOCOL {
            return Err(LinkError::OtherVersion);
        }
        Ok(hello)
    }

    /// Pairs with the code the PC shows, as `device`.
    pub(crate) async fn pair(&self, code: &str, device: &str) -> Result<Pairing, LinkError> {
        let hello = self.hello().await?;
        let (state, message) = protocol::start_phone(code);
        let started: PairStarted = self
            .json(
                self.request(reqwest::Method::POST, "/v1/pair/start")
                    .json(&PairStart {
                        message: encode(&message),
                        device: device.to_owned(),
                    }),
            )
            .await?;
        let answer = decode(&started.message)
            .ok_or_else(|| LinkError::Failed("The PC's answer is malformed.".into()))?;
        let key = state
            .finish(&answer)
            .map_err(|_| LinkError::Failed("The PC's answer is malformed.".into()))?;
        // The certificate every request so far met; the proofs bind the pairing to it.
        let fingerprint = self
            .verifier
            .seen
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .ok_or(LinkError::Unreachable)?;
        let paired: Paired = self
            .json(
                self.request(reqwest::Method::POST, "/v1/pair/finish")
                    .json(&PairFinish {
                        session: started.session,
                        proof: encode(&protocol::phone_proof(&key, &fingerprint)),
                    }),
            )
            .await?;
        let proven = decode(&paired.proof)
            .is_some_and(|proof| protocol::pc_proof_matches(&key, &fingerprint, &proof));
        let token = decode(&paired.token).filter(|token| token.len() == 32);
        match (proven, token) {
            (true, Some(token)) => Ok(Pairing {
                pc_name: hello.name,
                fingerprint,
                token,
                device: paired.device,
            }),
            _ => Err(LinkError::NotThePc),
        }
    }

    pub(crate) async fn library(&self) -> Result<RemoteLibrary, LinkError> {
        self.json(
            self.request(reqwest::Method::GET, "/v1/library")
                .timeout(LISTING),
        )
        .await
    }

    /// The PC's state of these books and every session, for the phone to merge.
    pub(crate) async fn sync_pull(
        &self,
        request: &crate::sync::PullRequest,
    ) -> Result<crate::sync::PullResponse, LinkError> {
        self.json(
            self.request(reqwest::Method::POST, "/v1/sync/pull")
                .json(request)
                .timeout(SYNCING),
        )
        .await
    }

    /// What the PC lacks after the merge, written there all or nothing.
    pub(crate) async fn sync_push(
        &self,
        request: &crate::sync::PushRequest,
    ) -> Result<crate::sync::PushResponse, LinkError> {
        self.json(
            self.request(reqwest::Method::POST, "/v1/sync/push")
                .json(request)
                .timeout(SYNCING),
        )
        .await
    }

    pub(crate) async fn dictionaries(&self) -> Result<Vec<RemoteDictionary>, LinkError> {
        self.json(
            self.request(reqwest::Method::GET, "/v1/dictionaries")
                .timeout(LISTING),
        )
        .await
    }

    pub(crate) async fn cover(&self, book: &str) -> Result<(String, Vec<u8>), LinkError> {
        let response = self
            .send(
                self.request(reqwest::Method::GET, &format!("/v1/books/{book}/cover"))
                    .timeout(LISTING),
            )
            .await?;
        let kind = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("image/jpeg")
            .to_owned();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| LinkError::Failed(error.to_string()))?;
        Ok((kind, bytes.to_vec()))
    }

    /// Downloads `path` into `target`, through a `.part` file renamed once complete, telling
    /// `progress` the bytes received and the total.
    pub(crate) async fn download(
        &self,
        path: &str,
        target: &Path,
        mut progress: impl FnMut(u64, u64),
    ) -> Result<(), LinkError> {
        let mut response = self.send(self.request(reqwest::Method::GET, path)).await?;
        let total = response.content_length().unwrap_or(0);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| LinkError::Failed(error.to_string()))?;
        }
        let part = target.with_extension("part");
        let written = async {
            let mut file = std::fs::File::create(&part)?;
            let mut received = 0u64;
            progress(0, total);
            while let Some(chunk) = response.chunk().await.map_err(std::io::Error::other)? {
                file.write_all(&chunk)?;
                received += chunk.len() as u64;
                progress(received, total);
            }
            file.sync_all()?;
            if total != 0 && received != total {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "the download ended early",
                ));
            }
            Ok::<_, std::io::Error>(())
        }
        .await;
        if let Err(error) = written {
            let _ = std::fs::remove_file(&part);
            return Err(if error.kind() == std::io::ErrorKind::UnexpectedEof {
                LinkError::Unreachable
            } else {
                LinkError::Failed(error.to_string())
            });
        }
        std::fs::rename(&part, target).map_err(|error| {
            let _ = std::fs::remove_file(&part);
            LinkError::Failed(error.to_string())
        })
    }

    /// Tells the PC to forget this phone.
    pub(crate) async fn forget(&self) -> Result<(), LinkError> {
        self.send(self.request(reqwest::Method::DELETE, "/v1/device"))
            .await
            .map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::safe_file_name;

    #[test]
    fn a_pc_file_name_stays_a_plain_epub_name() {
        assert_eq!(safe_file_name("Alice.epub"), "Alice.epub");
        assert_eq!(safe_file_name("../../x/Alice"), "xAlice.epub");
        assert_eq!(safe_file_name(r"C:\a\b.EPUB"), "Cab.EPUB");
        assert_eq!(safe_file_name(".."), "Book.epub");
    }
}
