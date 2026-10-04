//! One request per connection. Admission precedes parsing; rejected requests
//! close without draining a peer-controlled body. tiny_http only formats replies.
use super::deadline_stream::DeadlineStream;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tiny_http::{HTTPVersion, Header, Method, Response};

pub(super) const MAX_CONNECTIONS: usize = 32;
pub(super) const MAX_BODY_BYTES: usize = 1024 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(5);

struct ConnectionSlot(Arc<AtomicUsize>);
impl Drop for ConnectionSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Release);
    }
}

fn acquire(active: &Arc<AtomicUsize>) -> Option<ConnectionSlot> {
    active
        .fetch_update(Ordering::Acquire, Ordering::Relaxed, |count| {
            (count < MAX_CONNECTIONS).then_some(count + 1)
        })
        .ok()
        .map(|_| ConnectionSlot(active.clone()))
}

pub(super) struct Request {
    reader: BufReader<DeadlineStream>,
    method: Method,
    url: String,
    version: HTTPVersion,
    headers: Vec<Header>,
    length: Option<usize>,
    continued: bool,
}

impl Request {
    pub(super) fn method(&self) -> &Method {
        &self.method
    }
    pub(super) fn url(&self) -> &str {
        &self.url
    }
    pub(super) fn headers(&self) -> &[Header] {
        &self.headers
    }
    pub(super) fn body_length(&self) -> Option<usize> {
        self.length
    }
    pub(super) fn as_reader(&mut self) -> io::Result<impl Read + '_> {
        if !self.continued
            && self.headers.iter().any(|header| {
                header.field.equiv("Expect")
                    && header.value.as_str().eq_ignore_ascii_case("100-continue")
            })
        {
            // The API calls this only after authentication and length checks.
            self.reader
                .get_mut()
                .write_all(b"HTTP/1.1 100 Continue\r\n\r\n")?;
            self.continued = true;
        }
        Ok(self.reader.by_ref().take(self.length.unwrap_or(0) as u64))
    }

    pub(super) fn respond<R: Read>(mut self, response: Response<R>) -> io::Result<()> {
        // Routing may wait for a reader command for up to 30s. Reply writes
        // get their own small budget; request reads never reset their deadline.
        self.reader
            .get_mut()
            .set_deadline(Instant::now() + RESPONSE_TIMEOUT);
        response.raw_print(
            self.reader.get_mut(),
            self.version,
            &self.headers,
            self.method == Method::Head,
            None,
        )?;
        self.reader.get_mut().flush()
        // Drop closes the socket. There is deliberately no body-draining Drop.
    }
}

fn reject(stream: &mut DeadlineStream, status: u16, code: &str) {
    stream.set_deadline(Instant::now() + RESPONSE_TIMEOUT);
    let response = Response::from_string(format!("{{\"code\":\"{code}\"}}"))
        .with_status_code(status)
        .with_header(Header::from_bytes("Content-Type", "application/json").unwrap());
    let _ = response.raw_print(stream, HTTPVersion(1, 1), &[], false, None);
}

fn parse(stream: TcpStream, deadline: Instant) -> Option<Request> {
    let mut reader = BufReader::with_capacity(4096, DeadlineStream::new(stream, deadline));
    let mut bytes = Vec::with_capacity(1024);
    // BufReader preserves any body bytes read together with the headers. Each
    // parser read is bounded even if the peer sends one byte at a time.
    loop {
        if bytes.len() == MAX_HEADER_BYTES {
            reject(reader.get_mut(), 431, "HEADERS_TOO_LARGE");
            return None;
        }
        let available = match reader.fill_buf() {
            Ok(bytes) if !bytes.is_empty() => bytes,
            _ => return None,
        };
        let mut consumed = 0;
        for byte in available.iter().take(MAX_HEADER_BYTES - bytes.len()) {
            bytes.push(*byte);
            consumed += 1;
            if bytes.ends_with(b"\r\n\r\n") {
                break;
            }
        }
        reader.consume(consumed);
        if bytes.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    let mut header_buffer = [httparse::EMPTY_HEADER; 64];
    let mut parsed = httparse::Request::new(&mut header_buffer);
    if !matches!(parsed.parse(&bytes), Ok(httparse::Status::Complete(_))) {
        reject(reader.get_mut(), 400, "INVALID_HEADERS");
        return None;
    }
    let method = parsed.method?.parse().ok()?;
    let url = parsed.path?.to_string();
    let version = HTTPVersion(1, parsed.version?);
    let mut headers = Vec::new();
    let mut length = None;
    for header in parsed.headers {
        if header.name.eq_ignore_ascii_case("Transfer-Encoding") {
            reject(reader.get_mut(), 411, "LENGTH_REQUIRED");
            return None;
        }
        if header.name.eq_ignore_ascii_case("Content-Length") {
            let value = std::str::from_utf8(header.value)
                .ok()
                .filter(|value| {
                    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
                })
                .and_then(|value| value.parse::<usize>().ok());
            let Some(value) = value else {
                reject(reader.get_mut(), 400, "INVALID_LENGTH");
                return None;
            };
            if length.is_some() {
                reject(reader.get_mut(), 400, "INVALID_LENGTH");
                return None;
            }
            if value > MAX_BODY_BYTES {
                reject(reader.get_mut(), 413, "PAYLOAD_TOO_LARGE");
                return None;
            }
            length = Some(value);
        }
        let Ok(header) = Header::from_bytes(header.name, header.value) else {
            reject(reader.get_mut(), 400, "INVALID_HEADERS");
            return None;
        };
        headers.push(header);
    }
    Some(Request {
        reader,
        method,
        url,
        version,
        headers,
        length,
        continued: false,
    })
}

pub(super) fn serve(listener: TcpListener, handler: impl Fn(Request) + Send + Sync + 'static) {
    serve_with_budget(
        listener,
        handler,
        REQUEST_TIMEOUT,
        Arc::new(AtomicUsize::new(0)),
    );
}

fn serve_with_budget(
    listener: TcpListener,
    handler: impl Fn(Request) + Send + Sync + 'static,
    timeout: Duration,
    active: Arc<AtomicUsize>,
) {
    let handler = Arc::new(handler);
    for stream in listener.incoming().flatten() {
        let deadline = Instant::now() + timeout;
        let Some(slot) = acquire(&active) else {
            // A single nonblocking write: overload cannot park the accept
            // thread or allocate another worker. If it would block, close.
            let _ = stream.set_nonblocking(true);
            let _ = (&stream).write(b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 22\r\n\r\n{\"code\":\"SERVER_BUSY\"}");
            continue;
        };
        let handler = handler.clone();
        std::thread::spawn(move || {
            let _slot = slot;
            if let Some(request) = parse(stream, deadline) {
                handler(request);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    fn fixture() -> (u16, Arc<AtomicUsize>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let active = Arc::new(AtomicUsize::new(0));
        let observed = active.clone();
        thread::spawn(move || {
            serve_with_budget(
                listener,
                |mut request| {
                    if !request.headers().iter().any(|header| {
                        header.field.equiv("X-Extension-Token")
                            && header.value.as_str() == "fixture"
                    }) {
                        request
                            .respond(Response::from_string("unauthorized").with_status_code(401))
                            .unwrap();
                        return;
                    }
                    let length = request.body_length().unwrap_or(0);
                    let mut body = Vec::new();
                    let complete = request
                        .as_reader()
                        .and_then(|mut reader| reader.read_to_end(&mut body))
                        .is_ok()
                        && body.len() == length;
                    let _ = request.respond(
                        Response::from_string("ok").with_status_code(if complete {
                            200
                        } else {
                            408
                        }),
                    );
                },
                Duration::from_millis(600),
                observed,
            )
        });
        (port, active)
    }

    fn connect(port: u16) -> TcpStream {
        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        stream
    }

    fn reply(stream: &mut TcpStream) -> String {
        let mut bytes = Vec::new();
        match stream.read_to_end(&mut bytes) {
            Ok(_) => {}
            // Closing without draining is allowed to reset a connection with
            // unread inbound bytes, but any reply received must be preserved.
            Err(error) if error.kind() == io::ErrorKind::ConnectionReset => {}
            Err(error) => panic!("reply did not finish: {error}"),
        }
        String::from_utf8(bytes).unwrap()
    }

    fn healthy(port: u16) {
        let mut stream = connect(port);
        stream
            .write_all(b"GET / HTTP/1.1\r\nHost: localhost\r\nX-Extension-Token: fixture\r\n\r\n")
            .unwrap();
        assert!(reply(&mut stream).starts_with("HTTP/1.1 200"));
    }

    #[test]
    fn rejection_closes_without_draining_and_frees_capacity() {
        let (port, active) = fixture();
        for (length, status) in [
            (1, 401),
            (1024, 401),
            (MAX_BODY_BYTES, 401),
            (MAX_BODY_BYTES + 1, 413),
        ] {
            let mut stream = connect(port);
            let started = Instant::now();
            write!(
                stream,
                "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: {length}\r\n\r\n"
            )
            .unwrap();
            let response = reply(&mut stream);
            assert!(
                response.starts_with(&format!("HTTP/1.1 {status}")),
                "{response}"
            );
            assert!(started.elapsed() < Duration::from_millis(500));
            healthy(port);
        }
        thread::sleep(Duration::from_millis(20));
        assert_eq!(active.load(Ordering::Acquire), 0);
    }

    #[test]
    fn admission_bounds_slow_headers_and_short_bodies_before_parsing() {
        let (port, active) = fixture();
        let mut stalled = Vec::new();
        for index in 0..MAX_CONNECTIONS {
            let mut stream = connect(port);
            if index < MAX_CONNECTIONS / 2 {
                stream.write_all(b"POST / HTTP/1.1\r\nHost:").unwrap();
            } else {
                write!(stream, "POST / HTTP/1.1\r\nHost: localhost\r\nX-Extension-Token: fixture\r\nContent-Length: {}\r\n\r\n", if index % 2 == 0 { 1 } else { 1024 }).unwrap();
            }
            stalled.push(stream);
        }
        let started = Instant::now();
        while active.load(Ordering::Acquire) < MAX_CONNECTIONS {
            assert!(started.elapsed() < Duration::from_millis(400));
            thread::sleep(Duration::from_millis(2));
        }
        let mut overflow = connect(port);
        assert!(reply(&mut overflow).starts_with("HTTP/1.1 503"));
        assert_eq!(active.load(Ordering::Acquire), MAX_CONNECTIONS);
        // The accept loop remains responsive even while all parser slots are full.
        let mut another = connect(port);
        assert!(reply(&mut another).starts_with("HTTP/1.1 503"));
        for stream in &mut stalled {
            let _ = reply(stream);
        }
        let started = Instant::now();
        while active.load(Ordering::Acquire) != 0 {
            assert!(started.elapsed() < Duration::from_secs(1));
            thread::sleep(Duration::from_millis(2));
        }
        healthy(port);
    }

    #[test]
    fn continuous_header_or_body_bytes_cannot_extend_the_read_deadline() {
        let (port, active) = fixture();
        for prefix in [b"POST / HTTP/1.1\r\nX-Slow: ".as_slice(),
            b"POST / HTTP/1.1\r\nHost: localhost\r\nX-Extension-Token: fixture\r\nContent-Length: 1024\r\n\r\n".as_slice()] {
            let mut stream = connect(port);
            stream.write_all(prefix).unwrap();
            let mut writer = stream.try_clone().unwrap();
            let sender = thread::spawn(move || {
                for _ in 0..40 {
                    thread::sleep(Duration::from_millis(25));
                    if writer.write_all(b"x").is_err() { break; }
                }
            });
            let started = Instant::now();
            let _ = reply(&mut stream);
            assert!(started.elapsed() < Duration::from_secs(1));
            sender.join().unwrap();
            healthy(port);
        }
        thread::sleep(Duration::from_millis(20));
        assert_eq!(active.load(Ordering::Acquire), 0);
    }

    #[test]
    fn framing_limits_and_expect_continue_have_bounded_responses() {
        let (port, _) = fixture();
        for (headers, status) in [
            ("Content-Length: 999999999999999999999999999999\r\n", 400),
            ("Content-Length: 1\r\nContent-Length: 1\r\n", 400),
            ("Transfer-Encoding: chunked\r\n", 411),
            ("Expect: 100-continue\r\nContent-Length: 1\r\n", 401),
        ] {
            let mut stream = connect(port);
            write!(
                stream,
                "POST / HTTP/1.1\r\nHost: localhost\r\n{headers}\r\n"
            )
            .unwrap();
            assert!(reply(&mut stream).starts_with(&format!("HTTP/1.1 {status}")));
        }
        let mut stream = connect(port);
        let oversized = format!(
            "GET / HTTP/1.1\r\nX-Large: {}",
            "x".repeat(MAX_HEADER_BYTES)
        );
        let _ = stream.write_all(oversized.as_bytes());
        assert!(reply(&mut stream).starts_with("HTTP/1.1 431"));
        healthy(port);
    }

    #[test]
    fn authenticated_expect_continue_and_complete_body_succeed() {
        let (port, _) = fixture();
        let mut stream = connect(port);
        stream.write_all(b"POST / HTTP/1.1\r\nHost: localhost\r\nX-Extension-Token: fixture\r\nExpect: 100-continue\r\nContent-Length: 3\r\n\r\n").unwrap();
        let mut interim = [0; 25];
        stream.read_exact(&mut interim).unwrap();
        assert_eq!(&interim, b"HTTP/1.1 100 Continue\r\n\r\n");
        stream.write_all(b"abc").unwrap();
        assert!(reply(&mut stream).starts_with("HTTP/1.1 200"));
    }

    #[test]
    fn complete_bodies_at_the_limit_and_buffered_with_headers_are_accepted() {
        let (port, _) = fixture();
        for length in [1, 1024, MAX_BODY_BYTES] {
            let mut stream = connect(port);
            let mut request = format!("POST / HTTP/1.1\r\nHost: localhost\r\nX-Extension-Token: fixture\r\nContent-Length: {length}\r\n\r\n").into_bytes();
            request.resize(request.len() + length, b'x');
            stream.write_all(&request).unwrap();
            assert!(reply(&mut stream).starts_with("HTTP/1.1 200"));
        }
        healthy(port);
    }
}
