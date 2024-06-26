mod entity;
mod service;
mod util;

use std::{env, fs::File, io::BufReader};

use actix_analytics::Analytics;
use actix_cors::Cors;
use actix_files::Files;
use actix_web::{middleware, web::Data, App, HttpServer};
use actix_web_validator5::JsonConfig;
use anyhow::anyhow;
use clerk_rs::{clerk::Clerk, ClerkConfiguration};
use fred::{
    prelude::{ClientLike, RedisClient},
    types::{PerformanceConfig, ReconnectPolicy, RedisConfig},
};
use gorse_rs::Gorse;
use handlebars::{
    Context, DirectorySourceOptions, Handlebars, Helper, HelperResult, Output, RenderContext,
};
use meilisearch_sdk::{client::Client, indexes::Index};
use rustls::ServerConfig;
use rustls_pemfile::{certs, private_key};
use sea_orm::{Database, DatabaseConnection};
use serde::{Deserialize, Serialize};
use serde_json::json;
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

#[derive(Serialize, Deserialize, Debug)]
pub struct MeilliDocument {
    id: String,
    #[serde(flatten)]
    value: serde_json::Value,
}

pub struct AppState<'a> {
    db_connection: DatabaseConnection,
    redis_client: RedisClient,
    gorse_client: Gorse,
    meillisearch_client: Client,
    video_index: Index,
    handlebars: Handlebars<'a>,
    clerk: Clerk,
}

#[tokio::main(flavor = "multi_thread")]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();

    let host = env::var("HOST").expect("HOST is not set in .env file");
    let port = env::var("PORT").expect("PORT is not set in .env file");
    let analytics_api_key =
        env::var("ANALYTICS_API_KEY").expect("ANALYTICS_API_KEY is not set in .env file");

    let db_url = env::var("DATABASE_URL").expect("DATABASE_URL is not set in .env file");
    let redis_url = env::var("REDIS_URL").expect("REDIS_URL is not set in .env file");
    let gorse_url = {
        let url = env::var("GORSE_URL").expect("GORSE_URL is not set in .env file");

        match url.ends_with("/") {
            true => url,
            false => url + "/",
        }
    };
    let gorse_api_key = env::var("GORSE_API_KEY").expect("GORSE_API_KEY is not set in .env file");
    let meillisearch_url =
        env::var("MEILLISEARCH_URL").expect("MEILLISEARCH_URL is not set in .env file");
    let meillisearch_api_key =
        env::var("MEILLISEARCH_API_KEY").expect("GORSE_API_KEY is not set in .env file");

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

    let gorse_client = Gorse::new(gorse_url, gorse_api_key);
    let meillisearch_client = Client::new(meillisearch_url, Some(meillisearch_api_key))?;

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
    let clerk_script = handlebars.render(
        "clerk-script",
        &json!({
            "publishable_key": env::var("CLERK_PUBLISHABLE_KEY").expect("CLERK_PUBLISHABLE_KEY is not set in .env file"),
            "app_name": env::var("CLERK_APP_NAME").expect("CLERK_APP_NAME is not set in .env file")
        }),
    )?;

    handlebars.register_helper(
        "clerk-script",
        Box::new(
            move |_: &Helper,
                  _: &Handlebars,
                  _: &Context,
                  _: &mut RenderContext,
                  output: &mut dyn Output|
                  -> HelperResult {
                output.write(&clerk_script)?;

                Ok(())
            },
        ),
    );

    let state = Data::new(AppState {
        db_connection,
        redis_client,
        gorse_client,
        video_index: meillisearch_client.index("video"),
        meillisearch_client,
        handlebars,
        clerk,
    });

    HttpServer::new(move || {
        let cors = Cors::default().allow_any_origin();

        App::new()
            .app_data(state.clone())
            .app_data(JsonConfig::default().limit(131072))
            .wrap(Analytics::new(analytics_api_key.clone()))
            .wrap(cors)
            .wrap(middleware::DefaultHeaders::new().add(("Cache-Control", "max-age=31536000")))
            .wrap(middleware::NormalizePath::trim())
            .wrap(middleware::Compress::default())
            .service(service::index::get)
            .service(service::like::uuid::post)
            .service(service::like::uuid::delete)
            .service(service::results::get)
            .service(service::share::uuid::post)
            .service(service::thumbnail::uuid::get)
            .service(service::together::uuid::get)
            .service(service::upload::get)
            .service(service::upload::put)
            .service(service::upload::delete)
            .service(service::upload::uuid::resolution::post)
            .service(service::video::uuid::resolution::get)
            .service(service::video::uuid::resolution::start_timestamp::end_timestamp::get)
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
