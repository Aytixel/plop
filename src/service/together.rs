use ::uuid::Uuid;
use actix_web::{get, web::Data, HttpResponse, Responder};
use actix_web_validator5::Path;
use serde::Deserialize;
use serde_json::json;
use validator::Validate;

use crate::AppState;

pub mod uuid {
    use super::*;

    #[derive(Deserialize, Validate, Debug)]
    struct GetTogether {
        uuid: Uuid,
    }

    #[get("/together/{uuid}")]
    async fn get(
        params: Path<GetTogether>,
        data: Data<AppState<'_>>,
    ) -> actix_web::Result<impl Responder> {
        Ok(HttpResponse::Ok()
            .insert_header(("Cache-Control", "no-store"))
            .insert_header(("Content-type", "text/html; charset=utf-8"))
            .body(
                data.handlebars
                    .render(
                        "together",
                        &json!({
                            "uuid": params.uuid
                        }),
                    )
                    .unwrap(),
            ))
    }
}
