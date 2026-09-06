//! Bounded loopback HTTP transport. No parser pool, keep-alive, or body draining.
//! tiny_http is used only for Method/Header/response formatting, never sockets.
use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::time::{Duration, Instant};

pub(super) const REQUEST_DEADLINE: Duration = Duration::from_secs(5);
const MAX_HEADERS: usize = 16 * 1024;

pub(super) struct DeadlineStream {
    stream: TcpStream,
    deadline: Option<Instant>,
    remaining: usize,
}
impl DeadlineStream {
    pub fn new(stream: TcpStream, timeout: Duration, remaining: usize) -> Self {
        Self {
            stream,
            deadline: Some(Instant::now() + timeout),
            remaining,
        }
    }
    pub fn finish_handshake(&mut self) -> io::Result<()> {
        self.deadline = None;
        self.stream.set_read_timeout(None)
    }
    fn budget(&self) -> io::Result<()> {
        if let Some(deadline) = self.deadline {
            let time = deadline
                .checked_duration_since(Instant::now())
                .filter(|t| !t.is_zero())
                .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "连接读取截止时间已到"))?;
            self.stream.set_read_timeout(Some(time))?;
            self.stream.set_write_timeout(Some(time))?;
        }
        Ok(())
    }
}
impl std::ops::Deref for DeadlineStream {
    type Target = TcpStream;
    fn deref(&self) -> &TcpStream {
        &self.stream
    }
}
impl Read for DeadlineStream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.budget()?;
        if self.deadline.is_some() && self.remaining == 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "握手数据超过限额",
            ));
        }
        let limit = if self.deadline.is_some() {
            buf.len().min(self.remaining)
        } else {
            buf.len()
        };
        let n = self.stream.read(&mut buf[..limit])?;
        self.remaining = self.remaining.saturating_sub(n);
        Ok(n)
    }
}
impl Write for DeadlineStream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.budget()?;
        self.stream.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.stream.flush()
    }
}

pub(super) struct Request {
    stream: DeadlineStream,
    method: tiny_http::Method,
    url: String,
    headers: Vec<tiny_http::Header>,
    remaining: usize,
}
impl Request {
    pub fn read_headers(stream: TcpStream) -> Result<Self, (TcpStream, u16)> {
        Self::read_headers_with_timeout(stream, REQUEST_DEADLINE)
    }
    fn read_headers_with_timeout(
        stream: TcpStream,
        timeout: Duration,
    ) -> Result<Self, (TcpStream, u16)> {
        let mut stream = DeadlineStream::new(stream, timeout, MAX_HEADERS + 1024 * 1024);
        let result = (|| {
            // Byte reads avoid pre-reading even small bodies before authentication.
            let mut bytes = Vec::with_capacity(1024);
            while !bytes.ends_with(b"\r\n\r\n") {
                if bytes.len() == MAX_HEADERS {
                    return Err(431);
                }
                let mut byte = [0];
                stream.read_exact(&mut byte).map_err(|e| match e.kind() {
                    io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock => 408u16,
                    _ => 400u16,
                })?;
                bytes.push(byte[0]);
            }
            let mut raw_headers = [httparse::EMPTY_HEADER; 64];
            let mut parsed = httparse::Request::new(&mut raw_headers);
            parsed.parse(&bytes).map_err(|_| 400u16)?;
            if parsed.version != Some(1) {
                return Err(505);
            }
            let method = parsed.method.ok_or(400u16)?.parse().map_err(|_| 400u16)?;
            let url = parsed.path.ok_or(400u16)?.to_owned();
            if !url.starts_with('/') {
                return Err(400u16);
            }
            let mut length = None;
            let mut headers = Vec::new();
            for h in parsed.headers.iter() {
                // Deliberately require Content-Length for bodies; reject ambiguous framing.
                if h.name.eq_ignore_ascii_case("transfer-encoding") {
                    return Err(400u16);
                }
                if h.name.eq_ignore_ascii_case("expect") {
                    return Err(417);
                }
                if h.name.eq_ignore_ascii_case("content-length") {
                    if length.is_some()
                        || h.value.is_empty()
                        || !h.value.iter().all(u8::is_ascii_digit)
                    {
                        return Err(400u16);
                    }
                    let n = std::str::from_utf8(h.value)
                        .map_err(|_| 400u16)?
                        .parse::<usize>()
                        .map_err(|_| 413u16)?;
                    if n > 1024 * 1024 {
                        return Err(413u16);
                    }
                    length = Some(n);
                }
                headers.push(
                    tiny_http::Header::from_bytes(h.name.as_bytes(), h.value)
                        .map_err(|_| 400u16)?,
                );
            }
            Ok((method, url, headers, length.unwrap_or(0)))
        })();
        match result {
            Ok((method, url, headers, remaining)) => Ok(Self {
                stream,
                method,
                url,
                headers,
                remaining,
            }),
            Err(status) => Err((stream.stream, status)),
        }
    }
    pub fn headers(&self) -> &[tiny_http::Header] {
        &self.headers
    }
    pub fn method(&self) -> &tiny_http::Method {
        &self.method
    }
    pub fn url(&self) -> &str {
        &self.url
    }
    pub fn body_length(&self) -> Option<usize> {
        Some(self.remaining)
    }
    pub fn as_reader(&mut self) -> &mut Self {
        self
    }
    pub fn respond(
        self,
        response: tiny_http::Response<std::io::Cursor<Vec<u8>>>,
    ) -> io::Result<()> {
        // HTTP/1.0 framing plus actual shutdown; never drain an unauthenticated body.
        let mut stream = self.stream.stream;
        stream.set_write_timeout(Some(Duration::from_secs(2)))?;
        let result =
            response.raw_print(&mut stream, tiny_http::HTTPVersion(1, 0), &[], false, None);
        let _ = stream.shutdown(Shutdown::Both);
        result
    }
}
impl Read for Request {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.remaining == 0 {
            return Ok(0);
        }
        let len = buf.len().min(self.remaining);
        let read = self.stream.read(&mut buf[..len])?;
        if read == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "请求体不完整"));
        }
        self.remaining -= read;
        Ok(read)
    }
}
pub(super) fn reject(mut stream: TcpStream, status: u16) {
    let _ = stream.set_write_timeout(Some(Duration::from_millis(200)));
    let body = format!("{{\"code\":\"HTTP_{status}\",\"error\":\"请求被传输限制拒绝\"}}");
    let _ = write!(stream, "HTTP/1.1 {status} Rejected\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    let _ = stream.shutdown(Shutdown::Both);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;
    fn pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        (client, listener.accept().unwrap().0)
    }
    #[test]
    fn rejects_oversize_and_unauthed_without_draining_body() {
        for (length, expected) in [(1_048_577, 413u16), (1024, 401)] {
            let (mut client, server) = pair();
            let worker = thread::spawn(move || match Request::read_headers(server) {
                Ok(request) => request
                    .respond(tiny_http::Response::from_string("unauthorized").with_status_code(401))
                    .unwrap(),
                Err((stream, status)) => reject(stream, status),
            });
            client
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            write!(
                client,
                "POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: {length}\r\n\r\n"
            )
            .unwrap();
            let mut response = String::new();
            client.read_to_string(&mut response).unwrap();
            assert!(response.contains(&expected.to_string()), "{response}");
            worker.join().unwrap();
        }
    }
    #[test]
    fn total_deadline_covers_slow_headers_and_slow_body() {
        for body in [false, true] {
            let (mut client, server) = pair();
            let start = Instant::now();
            let worker = thread::spawn(move || {
                let parsed = Request::read_headers_with_timeout(server, Duration::from_millis(180));
                if body {
                    let mut request = parsed.ok().unwrap();
                    assert!(request.read_to_end(&mut Vec::new()).is_err());
                } else {
                    assert!(matches!(parsed, Err((_, 408u16))));
                }
            });
            if body {
                client
                    .write_all(b"POST / HTTP/1.1\r\nContent-Length: 999\r\n\r\n")
                    .unwrap();
            }
            for _ in 0..8 {
                thread::sleep(Duration::from_millis(40));
                if client.write_all(b"a").is_err() {
                    break;
                }
            }
            worker.join().unwrap();
            assert!(start.elapsed() < Duration::from_secs(1));
        }
    }
}
