//! The bit of HTTP the app needs.
//!
//! Only one host is ever talked to — the local API — so a TcpStream and a
//! hand-written request are enough. A client library for this would be a
//! dependency for nothing.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

/// A POST to the local API. Returns status code and body.
///
/// `client` lands in `X-Soloops-Client`: the API records per client when it
/// was last seen, and the app must not look like the MCP server.
pub fn post(
    port: u16,
    token: &str,
    client: &str,
    path: &str,
    body: &str,
) -> Result<(u16, String), String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream =
        TcpStream::connect_timeout(&addr, Duration::from_secs(2)).map_err(|err| err.to_string())?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));

    let request = format!(
        "POST {path} HTTP/1.0\r\n\
         Host: localhost\r\n\
         Authorization: Bearer {token}\r\n\
         X-Soloops-Client: {client}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|err| err.to_string())?;

    let mut raw = String::new();
    stream
        .read_to_string(&mut raw)
        .map_err(|err| err.to_string())?;

    let status = raw
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|code| code.parse().ok())
        .ok_or_else(|| {
            format!(
                "unverstaendliche Antwort: {}",
                raw.lines().next().unwrap_or("")
            )
        })?;

    // Header and body are separated by an empty line; everything after the
    // first one belongs to the body.
    let body = raw
        .split_once("\r\n\r\n")
        .or_else(|| raw.split_once("\n\n"))
        .map(|(_, rest)| rest.to_string())
        .unwrap_or_default();

    Ok((status, body))
}
