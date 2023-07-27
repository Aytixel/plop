mod entity;
mod service;

use std::{
    env,
    fs::File,
    io::{self, BufReader, Error, ErrorKind},
};

use actix_cors::Cors;
use actix_files::Files;
use actix_web::{middleware, web::Data, App, HttpServer};
use redis::{aio::MultiplexedConnection, Client};
use rustls::{Certificate, PrivateKey, ServerConfig};
use rustls_pemfile::{certs, pkcs8_private_keys};
use sea_orm::{Database, DatabaseConnection};

#[derive(Clone)]
pub struct AppState {
    db_connection: DatabaseConnection,
    redis_connection: MultiplexedConnection,
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> io::Result<()> {
    dotenvy::dotenv().ok();

    let host = env::var("HOST").expect("HOST is not set in .env file");
    let port = env::var("PORT").expect("PORT is not set in .env file");

    let db_host = env::var("DATABASE_HOST").expect("DATABASE_HOST is not set in .env file");
    let db_port = env::var("DATABASE_PORT").expect("DATABASE_PORT is not set in .env file");

    let db_user = env::var("DATABASE_USER").expect("DATABASE_USER is not set in .env file");
    let db_password =
        env::var("DATABASE_PASSWORD").expect("DATABASE_PASSWORD is not set in .env file");
    let db_name = env::var("DATABASE_NAME").expect("DATABASE_NAME is not set in .env file");

    let redis_host = env::var("REDIS_HOST").expect("REDIS_HOST is not set in .env file");
    let redis_port = env::var("REDIS_PORT").expect("REDIS_PORT is not set in .env file");

    let db_connection = Database::connect(format!(
        "postgresql://{db_user}:{db_password}@{db_host}:{db_port}/{db_name}"
    ))
    .await
    .unwrap();
    let redis_client = Client::open(format!("redis://{redis_host}:{redis_port}")).unwrap();
    let redis_connection = redis_client
        .get_multiplexed_tokio_connection()
        .await
        .unwrap();
    let state = AppState {
        db_connection,
        redis_connection,
    };

    HttpServer::new(move || {
        let cors = Cors::default().allow_any_origin();

        App::new()
            .app_data(Data::new(state.clone()))
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
}

fn load_rustls_config() -> io::Result<ServerConfig> {
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
        return Err(Error::new(
            ErrorKind::NotFound,
            "Could not locate PKCS 8 private keys.",
        ));
    }

    config
        .with_single_cert(cert_chain, keys.remove(0))
        .map_err(|error| Error::new(ErrorKind::InvalidData, error.to_string()))
}
