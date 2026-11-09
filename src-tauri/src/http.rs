//! Komori's HTTP client, for word audio and, on the phone, the starter dictionaries. TLS uses
//! rustls with ring; on the PC it checks certificates with the system's own store. Android's
//! needs Java set up from the app, so the phone checks them against Mozilla's roots instead.

use reqwest::ClientBuilder;

/// A client builder with Komori's user agent and certificate check; callers set the timeouts
/// and redirects their requests allow.
pub(crate) fn builder() -> ClientBuilder {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let builder = ClientBuilder::new().user_agent(concat!(
        "Komori/",
        env!("CARGO_PKG_VERSION"),
        " (https://github.com/Yuu-4chan/komori)"
    ));
    #[cfg(target_os = "android")]
    let builder = builder.tls_certs_only(
        webpki_root_certs::TLS_SERVER_ROOT_CERTS
            .iter()
            .filter_map(|root| reqwest::Certificate::from_der(root.as_ref()).ok()),
    );
    builder
}
