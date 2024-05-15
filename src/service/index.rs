use actix_web::{get, web::Data, HttpResponse, Responder};
use serde_json::json;

use crate::AppState;

#[get("/")]
async fn get(data: Data<AppState<'_>>) -> impl Responder {
    HttpResponse::Ok().body(
        data.handlebars
            .render(
                "index",
                &json!({
                    "clerk": data.clerk_config,
                }),
            )
            .unwrap(),
    )
}
