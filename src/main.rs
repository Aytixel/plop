mod entity;
mod service;

use std::{env, fs::File, io::BufReader};

use actix_cors::Cors;
use actix_files::Files;
use actix_web::{middleware, web::Data, App, HttpServer};
use anyhow::anyhow;
use fred::{
    prelude::{ClientLike, RedisClient},
    types::{PerformanceConfig, ReconnectPolicy, RedisConfig},
};
use rustls::{Certificate, PrivateKey, ServerConfig};
use rustls_pemfile::{certs, pkcs8_private_keys};
use sea_orm::{Database, DatabaseConnection};

pub trait AnyhowResult<T>: Sized {
    fn anyhow(self) -> anyhow::Result<T>;
}

impl<T, E> AnyhowResult<T> for Result<T, E>
where
    E: Into<anyhow::Error>,
{
    fn anyhow(self) -> anyhow::Result<T> {
        self.map_err(|error| error.into())
    }
}

pub struct AppState {
    db_connection: DatabaseConnection,
    redis_client: RedisClient,
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();

    let host = env::var("HOST").expect("HOST is not set in .env file");
    let port = env::var("PORT").expect("PORT is not set in .env file");

    let db_url = env::var("DATABASE_URL").expect("DATABASE_URL is not set in .env file");
    let redis_url = env::var("REDIS_URL").expect("REDIS_URL is not set in .env file");

    let db_connection = Database::connect(db_url).await?;
    let redis_config = RedisConfig::from_url(&redis_url)?;
    let redis_performance = PerformanceConfig::default();
    let redis_policy = ReconnectPolicy::default();
    let redis_client = RedisClient::new(redis_config, Some(redis_performance), Some(redis_policy));

    redis_client.connect();
    redis_client.wait_for_connect().await?;

    let state = Data::new(AppState {
        db_connection,
        redis_client,
    });

    HttpServer::new(move || {
        let cors = Cors::default().allow_any_origin();

        App::new()
            .app_data(state.clone())
            .wrap(cors)
            .wrap(middleware::Compress::default())
            .service(service::get_video)
            .service(service::put_video)
            .service(service::post_video)
            .service(
                Files::new("/", "./static/")
                    .use_etag(true)
                    .index_file("html/index.html"),
            )
    })
    .bind_rustls(format!("{host}:{port}"), load_rustls_config()?)?
    .run()
    .await
    .anyhow()
}

fn load_rustls_config() -> anyhow::Result<ServerConfig> {
    let config = ServerConfig::builder()
        .with_safe_defaults()
        .with_no_client_auth();
    let cert_chain = certs(&mut BufReader::new(File::open("cert/cert.pem")?))?
        .into_iter()
        .map(Certificate)
        .collect();
    let mut keys: Vec<PrivateKey> =
        pkcs8_private_keys(&mut BufReader::new(File::open("cert/key.pem")?))?
            .into_iter()
            .map(PrivateKey)
            .collect();

    if keys.is_empty() {
        return Err(anyhow!("Could not locate PKCS 8 private keys."));
    }

    config.with_single_cert(cert_chain, keys.remove(0)).anyhow()
}
