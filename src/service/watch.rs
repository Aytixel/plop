use ::uuid::Uuid;
use actix_web::{
    error::{ErrorInternalServerError, ErrorNotFound},
    get,
    web::Data,
    HttpResponse, Responder,
};
use actix_web_validator5::Path;
use sea_orm::EntityTrait;
use serde::Deserialize;
use serde_json::json;
use tokio::fs::metadata;
use validator::Validate;

use crate::{
    entity::{sea_orm_active_enums::VideoUploadState, video},
    AppState,
};

pub mod uuid {
    use super::*;

    #[derive(Deserialize, Validate, Debug)]
    struct GetWatch {
        uuid: Uuid,
    }

    #[get("/watch/{uuid}")]
    async fn get(
        params: Path<GetWatch>,
        data: Data<AppState<'_>>,
    ) -> actix_web::Result<impl Responder> {
        let video = video::Entity::find_by_id(params.uuid)
            .one(&data.db_connection)
            .await
            .map_err(|_| ErrorInternalServerError("Unable to find a video with this resolution"))?
            .ok_or_else(|| ErrorNotFound("Unable to find a video with this resolution"))?;
        let mut resolutions = Vec::new();

        if video.state_144p == VideoUploadState::Available {
            resolutions.push(144);
        }
        if video.state_240p == VideoUploadState::Available {
            resolutions.push(240);
        }
        if video.state_360p == VideoUploadState::Available {
            resolutions.push(360);
        }
        if video.state_480p == VideoUploadState::Available {
            resolutions.push(480);
        }
        if video.state_720p == VideoUploadState::Available {
            resolutions.push(720);
        }
        if video.state_1080p == VideoUploadState::Available {
            resolutions.push(1080);
        }
        if video.state_1440p == VideoUploadState::Available {
            resolutions.push(1440);
        }

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

        Ok(HttpResponse::Ok().insert_header(("Cache-Control", "no-cache")).body(
        data.handlebars
            .render(
                "watch",
                &json!({
                    "title": video.title,
                    "tags": video.tags.clone().map(|tags| tags.split(", ").map(str::to_string).collect::<Vec<String>>()),
                    "tags_short": video.tags.map(|tags| tags.split(", ").take(3).map(str::to_string).collect::<Vec<String>>()),
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
                    "vues": video.vues
                }),
            )
            .unwrap(),
    ))
    }
}
