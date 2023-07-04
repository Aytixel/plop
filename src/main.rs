use std::{
    fs::File,
    io::{self, BufReader, Error, ErrorKind},
};

use actix_cors::Cors;
use actix_files::Files;
use actix_web::{middleware, App, HttpServer};
use rustls::{Certificate, PrivateKey, ServerConfig};
use rustls_pemfile::{certs, pkcs8_private_keys};

#[tokio::main]
async fn main() -> io::Result<()> {
    HttpServer::new(|| {
        let cors = Cors::default().allow_any_origin();

        App::new()
            .wrap(cors)
            .wrap(middleware::Compress::default())
            .service(Files::new("/", "./static/").index_file("html/index.html"))
    })
    .bind_rustls("127.0.0.1:8080", load_rustls_config()?)?
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

    Ok(config
        .with_single_cert(cert_chain, keys.remove(0))
        .map_err(|error| Error::new(ErrorKind::InvalidData, error.to_string()))?)
}
