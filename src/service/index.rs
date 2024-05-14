use std::env;

use actix_web::{get, web::Data, HttpResponse, Responder};
use serde_json::json;

use crate::AppState;

#[get("/")]
async fn get(data: Data<AppState<'_>>) -> impl Responder {
    HttpResponse::Ok().body(data.handlebars.render("index", &json!({ 
        "clerk": {
            "publishable_key": env::var("CLERK_PUBLISHABLE_KEY").expect("CLERK_PUBLISHABLE_KEY is not set in .env file"),
            "app_name": env::var("CLERK_APP_NAME").expect("CLERK_APP_NAME is not set in .env file")
        }
    })).unwrap())
}
