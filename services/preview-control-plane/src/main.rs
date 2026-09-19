use anyhow::Context;
use moke_preview_control_plane::{api, config::Config, AppState};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use tokio::net::TcpListener;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "moke_preview_control_plane=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer().json())
        .init();

    let config = Config::from_env().context("invalid control-plane configuration")?;
    let database = PgConnectOptions::new()
        .host(&config.database_host)
        .port(config.database_port)
        .username(&config.database_user)
        .password(&config.database_password)
        .database(&config.database_name);
    let pool = PgPoolOptions::new()
        .max_connections(config.database_max_connections)
        .connect_with(database)
        .await
        .context("connect to PostgreSQL")?;
    sqlx::migrate!()
        .run(&pool)
        .await
        .context("run database migrations")?;

    let state = AppState::new(pool, &config);
    let app = api::router(state);
    let listener = TcpListener::bind(config.bind_address)
        .await
        .context("bind HTTP listener")?;
    tracing::info!(address = %config.bind_address, "Preview control plane listening");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    .context("serve HTTP")?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("install Ctrl+C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
