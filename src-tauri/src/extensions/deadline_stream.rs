//! Enforce the same absolute deadline on every underlying socket operation,
//! including repeated reads inside HTTP/WebSocket parsers.
use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::ops::Deref;
use std::time::Instant;

pub(super) struct DeadlineStream {
    stream: TcpStream,
    deadline: Option<Instant>,
}

impl DeadlineStream {
    pub(super) fn new(stream: TcpStream, deadline: Instant) -> Self {
        Self {
            stream,
            deadline: Some(deadline),
        }
    }

    pub(super) fn clear_deadline(&mut self) -> io::Result<()> {
        self.stream.set_read_timeout(None)?;
        self.stream.set_write_timeout(None)?;
        self.deadline = None;
        Ok(())
    }

    pub(super) fn set_deadline(&mut self, deadline: Instant) {
        self.deadline = Some(deadline);
    }

    pub(super) fn check_deadline(&self) -> io::Result<()> {
        self.prepare(false)
    }

    fn prepare(&self, writing: bool) -> io::Result<()> {
        if let Some(deadline) = self.deadline {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .filter(|duration| !duration.is_zero())
                .ok_or_else(|| {
                    let _ = self.stream.shutdown(Shutdown::Both);
                    io::Error::new(io::ErrorKind::TimedOut, "connection deadline expired")
                })?;
            if writing {
                self.stream.set_write_timeout(Some(remaining))?;
            } else {
                self.stream.set_read_timeout(Some(remaining))?;
            }
        }
        Ok(())
    }
}

impl Deref for DeadlineStream {
    type Target = TcpStream;
    fn deref(&self) -> &TcpStream {
        &self.stream
    }
}

impl Read for DeadlineStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.prepare(false)?;
        self.stream.read(buffer)
    }
}

impl Write for DeadlineStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.prepare(true)?;
        self.stream.write(buffer)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.prepare(true)?;
        self.stream.flush()
    }
}
