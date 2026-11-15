//! Foreground diagnostic: `cargo run --example browse -- [seconds]`.
//! Prints public discovery metadata only. No HTTP/TCP request is made.
use moke_discovery_desktop::{DiscoveryStatus, Session};
use std::time::{Duration, Instant};

fn main() {
    let seconds = std::env::args()
        .nth(1)
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(10)
        .min(120);
    let mut session = match Session::start() {
        Ok(session) => session,
        Err(error) => {
            eprintln!("discovery startup: {} ({})", error.code, error.message);
            std::process::exit(2);
        }
    };
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(seconds) {
        let snapshot = session.snapshot();
        println!(
            "{}ms {:?} rows={}",
            start.elapsed().as_millis(),
            snapshot.status,
            snapshot.rows.len()
        );
        for row in snapshot.rows {
            println!("{} {} conflict={}", row.id, row.name, row.conflict);
            for candidate in row.candidates {
                println!(
                    "  {} joinable={} sources={}",
                    candidate.base_url,
                    candidate.joinable,
                    candidate.sources.len()
                );
            }
        }
        if snapshot.status != DiscoveryStatus::Searching {
            break;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    if let Err(error) = session.stop() {
        eprintln!("discovery stop: {} ({})", error.code, error.message);
        std::process::exit(3);
    }
}
