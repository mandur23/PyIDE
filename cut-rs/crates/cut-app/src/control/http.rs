//! The little HTTP/1.1 the control server speaks (no dependency): a request's head and body read from a socket with
//! limits, and a response written whole. Keep-alive as HTTP/1.1 has it; `Content-Length` or chunked bodies.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::TcpStream;

/// The most a request's head may take (request line and headers).
const HEAD_LIMIT: usize = 16 * 1024;

/// A request's line and headers.
#[derive(Debug, Clone)]
pub struct Head {
    pub method: String,
    pub target: String,
    pub version: String,
    /// Names in lower case, in the order sent.
    pub headers: Vec<(String, String)>,
}

impl Head {
    /// The first header of this name (lower case).
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    /// Whether the connection ends after this request.
    pub fn closes(&self) -> bool {
        let conn = self.header("connection").unwrap_or_default().to_ascii_lowercase();
        conn.split(',').any(|x| x.trim() == "close") || (self.version == "HTTP/1.0" && !conn.contains("keep-alive"))
    }
}

/// What reading a request gave.
pub enum Got {
    Head(Head),
    /// The peer closed the connection (or sent nothing before the timeout).
    Closed,
    /// Not HTTP, or a head over the limit.
    Bad,
}

/// One line up to CRLF (or LF), within `budget` bytes.
fn line(r: &mut BufReader<TcpStream>, budget: &mut usize) -> io::Result<Option<String>> {
    let mut buf = Vec::new();
    loop {
        let avail = match r.fill_buf() {
            Ok(b) => b,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if avail.is_empty() {
            return Ok(None);
        }
        let (used, done) = match avail.iter().position(|&b| b == b'\n') {
            Some(i) => (i + 1, true),
            None => (avail.len(), false),
        };
        if used > *budget {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "head too large"));
        }
        *budget -= used;
        buf.extend_from_slice(&avail[..used]);
        r.consume(used);
        if done {
            while matches!(buf.last(), Some(b'\n' | b'\r')) {
                buf.pop();
            }
            return Ok(Some(String::from_utf8_lossy(&buf).into_owned()));
        }
    }
}

/// Reads the next request's head.
pub fn read_head(r: &mut BufReader<TcpStream>) -> Got {
    let mut budget = HEAD_LIMIT;
    let first = loop {
        match line(r, &mut budget) {
            Ok(Some(l)) if l.is_empty() => continue,
            Ok(Some(l)) => break l,
            Ok(None) => return Got::Closed,
            Err(e) if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => return Got::Closed,
            Err(e) if e.kind() == io::ErrorKind::InvalidData => return Got::Bad,
            Err(_) => return Got::Closed,
        }
    };
    let mut parts = first.split(' ');
    let (Some(method), Some(target), Some(version)) = (parts.next(), parts.next(), parts.next()) else {
        return Got::Bad;
    };
    if parts.next().is_some() || !version.starts_with("HTTP/1.") || method.is_empty() {
        return Got::Bad;
    }
    let mut headers = Vec::new();
    loop {
        match line(r, &mut budget) {
            Ok(Some(l)) if l.is_empty() => break,
            Ok(Some(l)) => {
                let Some((k, v)) = l.split_once(':') else { return Got::Bad };
                headers.push((k.trim().to_ascii_lowercase(), v.trim().to_owned()));
            }
            Ok(None) => return Got::Closed,
            Err(_) => return Got::Bad,
        }
    }
    Got::Head(Head { method: method.to_owned(), target: target.to_owned(), version: version.to_owned(), headers })
}

/// Why a body was not read.
pub enum BodyError {
    TooLarge,
    Bad,
}

/// The body of a request with `Content-Length` or chunked, at most `limit` bytes.
pub fn read_body(r: &mut BufReader<TcpStream>, head: &Head, limit: usize) -> Result<Vec<u8>, BodyError> {
    if head.header("transfer-encoding").is_some_and(|t| t.to_ascii_lowercase().contains("chunked")) {
        let mut out = Vec::new();
        let mut budget = HEAD_LIMIT;
        loop {
            let Ok(Some(size)) = line(r, &mut budget) else { return Err(BodyError::Bad) };
            let hex = size.split(';').next().unwrap_or_default().trim();
            let Ok(n) = usize::from_str_radix(hex, 16) else { return Err(BodyError::Bad) };
            if n == 0 {
                while let Ok(Some(l)) = line(r, &mut budget) {
                    if l.is_empty() {
                        break;
                    }
                }
                return Ok(out);
            }
            if out.len() + n > limit {
                return Err(BodyError::TooLarge);
            }
            let at = out.len();
            out.resize(at + n, 0);
            r.read_exact(&mut out[at..]).map_err(|_| BodyError::Bad)?;
            let mut crlf = [0u8; 2];
            r.read_exact(&mut crlf).map_err(|_| BodyError::Bad)?;
            budget = HEAD_LIMIT;
        }
    }
    let n = match head.header("content-length") {
        None => 0,
        Some(v) => v.trim().parse::<usize>().map_err(|_| BodyError::Bad)?,
    };
    if n > limit {
        return Err(BodyError::TooLarge);
    }
    let mut out = vec![0u8; n];
    r.read_exact(&mut out).map_err(|_| BodyError::Bad)?;
    Ok(out)
}

fn reason(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        _ => "Internal Server Error",
    }
}

/// Writes a whole response: JSON when `body` is given.
pub fn respond(
    w: &mut TcpStream,
    status: u16,
    headers: &[(&str, String)],
    body: Option<&str>,
    close: bool,
) -> io::Result<()> {
    let mut out = format!("HTTP/1.1 {status} {}\r\n", reason(status));
    for (k, v) in headers {
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    match body {
        Some(b) => out.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", b.len())),
        None => out.push_str("Content-Length: 0\r\n"),
    }
    out.push_str(if close { "Connection: close\r\n\r\n" } else { "Connection: keep-alive\r\n\r\n" });
    if let Some(b) = body {
        out.push_str(b);
    }
    w.write_all(out.as_bytes())?;
    w.flush()
}
