use ::uuid::Uuid;
use actix_web::{
    delete, error::ErrorInternalServerError, post, web::Data, HttpRequest, HttpResponse, Responder,
};
use actix_web_validator5::Path;
use sea_orm::{ActiveModelTrait, Set};
use serde::Deserialize;
use validator::Validate;

use crate::{entity::like, util::get_authentication_data, AppState};

pub mod uuid {
    use super::*;

    #[derive(Deserialize, Validate, Debug)]
    struct PostLike {
        uuid: Uuid,
    }

    #[post("/like/{uuid}")]
    async fn post(
        request: HttpRequest,
        params: Path<PostLike>,
        data: Data<AppState<'_>>,
    ) -> actix_web::Result<impl Responder> {
        if let Some(jwt) = get_authentication_data(&request, &data.clerk).await {
            let like = like::ActiveModel {
                uuid: Set(params.uuid),
                user_id: Set(jwt.sub),
            };

            like.insert(&data.db_connection)
                .await
                .map_err(|_| ErrorInternalServerError("Unable to add like"))?;
        }

        Ok(HttpResponse::Ok())
    }

    #[derive(Deserialize, Validate, Debug)]
    struct DeleteLike {
        uuid: Uuid,
    }

    #[delete("/like/{uuid}")]
    async fn delete(
        request: HttpRequest,
        params: Path<DeleteLike>,
        data: Data<AppState<'_>>,
    ) -> actix_web::Result<impl Responder> {
        if let Some(jwt) = get_authentication_data(&request, &data.clerk).await {
            let like = like::ActiveModel {
                uuid: Set(params.uuid),
                user_id: Set(jwt.sub),
            };

            like.delete(&data.db_connection)
                .await
                .map_err(|_| ErrorInternalServerError("Unable to remove like"))?;
        }

        Ok(HttpResponse::Ok())
    }
}
