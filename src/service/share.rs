use std::time::SystemTime;

use ::uuid::Uuid;
use actix_web::{post, web::Data, HttpRequest, HttpResponse, Responder};
use actix_web_validator5::Path;
use chrono::{DateTime, Utc};
use gorse_rs::Feedback;
use serde::Deserialize;
use validator::Validate;

use crate::{
    util::{get_authentication_data, get_gorse_user_id, DEFAULT_GORSE_USER_ID},
    AppState,
};

pub mod uuid {
    use super::*;

    #[derive(Deserialize, Validate, Debug)]
    struct PostShare {
        uuid: Uuid,
    }

    #[post("/share/{uuid}")]
    async fn post(
        request: HttpRequest,
        params: Path<PostShare>,
        data: Data<AppState<'_>>,
    ) -> actix_web::Result<impl Responder> {
        let jwt = get_authentication_data(&request, &data.clerk).await;
        let user_id = get_gorse_user_id(&request, &jwt).await;

        data.gorse_client
            .insert_feedback(&vec![
                Feedback {
                    feedback_type: "share".to_string(),
                    user_id,
                    item_id: params.uuid.to_string(),
                    timestamp: DateTime::<Utc>::from(SystemTime::now()).to_rfc3339(),
                },
                Feedback {
                    feedback_type: "share".to_string(),
                    user_id: DEFAULT_GORSE_USER_ID.to_string(),
                    item_id: params.uuid.to_string(),
                    timestamp: DateTime::<Utc>::from(SystemTime::now()).to_rfc3339(),
                },
            ])
            .await
            .ok();

        Ok(HttpResponse::Ok())
    }
}
