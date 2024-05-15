mod entity;
mod service;

use std::{env, fs::File, io::BufReader};

use actix_cors::Cors;
use actix_files::Files;
use actix_web::{middleware, web::Data, App, HttpRequest, HttpServer};
use actix_web_validator5::JsonConfig;
use anyhow::anyhow;
use clerk_rs::{
    apis::{jwks_api::Jwks, sessions_api::Session},
    clerk::Clerk,
    models::session::Status,
    validators::actix::{validate_jwt, ClerkJwt},
    ClerkConfiguration,
};
use fred::{
    prelude::{ClientLike, RedisClient},
    types::{PerformanceConfig, ReconnectPolicy, RedisConfig},
};
use handlebars::{DirectorySourceOptions, Handlebars};
use rustls::ServerConfig;
use rustls_pemfile::{certs, private_key};
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

pub struct AppState<'a> {
    db_connection: DatabaseConnection,
    redis_client: RedisClient,
    handlebars: Handlebars<'a>,
    clerk: Clerk,
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
    let redis_client = RedisClient::new(
        redis_config,
        Some(redis_performance),
        None,
        Some(redis_policy),
    );

    redis_client.connect();
    redis_client.wait_for_connect().await?;

    let mut handlebars = Handlebars::new();

    handlebars.register_templates_directory(
        "./templates",
        DirectorySourceOptions {
            tpl_extension: ".hbs".to_string(),
            hidden: false,
            temporary: false,
        },
    )?;

    let clerk = Clerk::new(ClerkConfiguration::new(
        None,
        None,
        Some(env::var("CLERK_SECRET_KEY").expect("CLERK_SECRET_KEY is not set in .env file")),
        None,
    ));

    let state = Data::new(AppState {
        db_connection,
        redis_client,
        handlebars,
        clerk,
    });

    HttpServer::new(move || {
        let cors = Cors::default().allow_any_origin();

        App::new()
            .app_data(state.clone())
            .app_data(JsonConfig::default().limit(131072))
            .wrap(cors)
            .wrap(middleware::Compress::default())
            .wrap(middleware::DefaultHeaders::new().add(("Cache-Control", "max-age=2592000")))
            .service(service::index::get)
            .service(service::thumbnail::uuid::get)
            .service(service::upload::get)
            .service(service::upload::put)
            .service(service::upload::uuid::resolution::post)
            .service(service::video::uuid::resolution::get)
            .service(service::watch::uuid::get)
            .service(
                Files::new("/", "./static/")
                    .use_etag(false)
                    .use_last_modified(false),
            )
    })
    .bind_rustls_0_22(format!("{host}:{port}"), load_rustls_config()?)?
    .run()
    .await
    .anyhow()
}

pub async fn get_authentication_data(req: &HttpRequest, clerk: &Clerk) -> Option<ClerkJwt> {
    let Some(access_token) = req.cookie("__session") else {
        return None;
    };
    let Ok(jwks) = Jwks::get_jwks(clerk).await else {
        return None;
    };
    let Ok((_, jwt)) = validate_jwt(access_token.value(), jwks) else {
        return None;
    };

    Session::get_session(clerk, &jwt.sid)
        .await
        .ok()
        .map(|session| (session.status == Status::Active).then_some(jwt))
        .flatten()
}

fn load_rustls_config() -> anyhow::Result<ServerConfig> {
    let config = ServerConfig::builder().with_no_client_auth();
    let cert_chain = certs(&mut BufReader::new(File::open("cert/cert.pem")?))
        .filter_map(Result::ok)
        .collect();
    let key_option = private_key(&mut BufReader::new(File::open("cert/key.pem")?))?;

    if let Some(key) = key_option {
        config.with_single_cert(cert_chain, key).anyhow()
    } else {
        Err(anyhow!("Could not locate private key."))
    }
}
