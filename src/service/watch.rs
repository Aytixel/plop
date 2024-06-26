use std::time::{Duration, SystemTime};

use ::uuid::Uuid;
use actix_web::HttpRequest;
use actix_web::{
    error::{ErrorInternalServerError, ErrorNotFound},
    get,
    web::Data,
    HttpResponse, Responder,
};
use actix_web_validator5::Path;
use chrono::{DateTime, Utc};
use gorse_rs::Feedback;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde::Deserialize;
use serde_json::json;
use tokio::fs::metadata;
use validator::Validate;

use crate::{
    entity::{like, sea_orm_active_enums::VideoUploadState, video},
    util::{
        channel::get_channel_info, get_authentication_data, get_gorse_user_id,
        video::get_resolutions,
    },
    AppState,
};

pub mod uuid {
    use futures::future::join;

    use super::*;

    #[derive(Deserialize, Validate, Debug)]
    struct GetWatch {
        uuid: Uuid,
    }

    #[get("/watch/{uuid}")]
    async fn get(
        request: HttpRequest,
        params: Path<GetWatch>,
        data: Data<AppState<'_>>,
    ) -> actix_web::Result<impl Responder> {
        let jwt = get_authentication_data(&request, &data.clerk).await;
        let user_id = get_gorse_user_id(&request, &jwt).await;
        let recommendation_timestamp =
            (DateTime::<Utc>::from(SystemTime::now()) + Duration::new(3600, 0)).to_rfc3339();

        let (_, db) = join(
            data.gorse_client.insert_feedback(&vec![Feedback {
                feedback_type: "open".to_string(),
                user_id: user_id,
                item_id: params.uuid.to_string(),
                timestamp: recommendation_timestamp,
            }]),
            video::Entity::find_by_id(params.uuid).one(&data.db_connection),
        )
        .await;

        let video = db
            .map_err(|_| ErrorInternalServerError("Unable to find a video with this resolution"))?
            .ok_or_else(|| ErrorNotFound("Unable to find a video with this resolution"))?;
        let channel_info =
            get_channel_info(&video.user_id, &data.clerk, &data.redis_client).await?;
        let resolutions =
            get_resolutions(&video, VideoUploadState::eq, VideoUploadState::Available);
        let mut lengths = Vec::new();
        let mut bitrates = Vec::new();

        for resolution in resolutions.iter() {
            let length = metadata(format!("./video/{}/{}.webm", resolution, params.uuid))
                .await?
                .len();

            lengths.push(length);
            bitrates.push(length as f64 / video.duration)
        }

        const DEFAULT_META_DESCRIPTION: &str =
            "Apparemment pas de spoil par ici donc pas de description.";
        let (tags, tags_short) = match video.tags.clone().map(|tags| {
            let split = tags.split(",").map(str::to_string);

            (
                split.clone().collect::<Vec<String>>(),
                split.take(3).collect::<Vec<String>>(),
            )
        }) {
            Some((tags, tags_short)) => (Some(tags), Some(tags_short)),
            None => (None, None),
        };
        let liked = match jwt {
            Some(jwt) => like::Entity::find()
                .filter(like::Column::Uuid.eq(params.uuid))
                .filter(like::Column::UserId.eq(jwt.sub))
                .one(&data.db_connection)
                .await
                .map(|like| like.is_some())
                .unwrap_or(false),
            None => false,
        };

        Ok(
            HttpResponse::Ok()
                .insert_header(("Cache-Control", "no-store"))
                .insert_header(("Content-type", "text/html; charset=utf-8"))
                .body(
                    data.handlebars
                        .render(
                            "watch",
                            &json!({
                                "title": video.title,
                                "tags": tags,
                                "tags_short": tags_short,
                                "description": video.description,
                                "meta_description": video.description.map_or(DEFAULT_META_DESCRIPTION.to_string(), |mut description| {
                                    if description.is_empty() {
                                        DEFAULT_META_DESCRIPTION.to_string()
                                    } else if description.len() > 100 {
                                        description.truncate(100);
                                        description + "..."
                                    } else {
                                        description
                                    }
                                }),
                                "framerate": video.framerate,
                                "duration": video.duration,
                                "timestamp": video.timestamp.format("%Y-%m-%dT%H:%M:%S%.fZ").to_string(),
                                "uuid": video.uuid,
                                "resolutions": resolutions,
                                "lengths": lengths,
                                "bitrates": bitrates,
                                "has_audio": video.has_audio,
                                "views": video.views,
                                "likes": video.likes,
                                "liked": liked,
                                "channel_username": channel_info.username,
                                "channel_profil_picture": channel_info.profil_picture,
                            }),
                        )
                        .unwrap(),
                )
        )
    }
}
