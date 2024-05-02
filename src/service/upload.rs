use actix_web::{get, web::Data, HttpResponse, Responder};
use serde_json::json;

use crate::AppState;

#[get("/upload")]
async fn get(data: Data<AppState<'_>>) -> impl Responder {
    HttpResponse::Ok().body(
        data.handlebars
            .render(
                "upload",
                &json!({
                    "width": 640,
                    "height": 360
                }),
            )
            .unwrap(),
    )
}
