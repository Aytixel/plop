use std::collections::HashSet;

use actix_web::{
    error::{ErrorInternalServerError, ErrorNotFound},
    get, post, put,
    web::{Data, Payload},
    HttpResponse, Responder,
};
use actix_web_validator::{Json, Path};
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, Set};
use serde::Deserialize;
use tokio::{
    fs::{create_dir_all, OpenOptions},
    io::AsyncWriteExt,
};
use tokio_stream::StreamExt;
use uuid::Uuid;
use validator::{Validate, ValidationError};

use crate::{
    entity::{sea_orm_active_enums::VideoUploadState, video},
    AppState,
};

fn valid_resolution(resolution: u16) -> Result<(), ValidationError> {
    let resolutions = vec![144, 240, 360, 480, 720, 1080, 1440];

    if resolutions.contains(&resolution) {
        Ok(())
    } else {
        Err(ValidationError::new("Wrong resolution !"))
    }
}

fn valid_resolutions(resolutions: &HashSet<u16>) -> Result<(), ValidationError> {
    for resolution in resolutions {
        valid_resolution(*resolution)?;
    }

    Ok(())
}

#[derive(Deserialize, Validate, Debug)]
struct GetVideo {
    uuid: Uuid,
    #[validate(custom = "valid_resolution")]
    resolution: u16,
}

#[derive(Deserialize, Validate, Debug)]
struct PutVideo {
    #[validate(length(min = 1, max = 100))]
    title: String,
    #[validate(length(min = 0, max = 5000))]
    description: Option<String>,
    #[validate(length(min = 0, max = 500))]
    tags: Option<String>,
    #[validate(range(min = 0))]
    duration: f64,
    #[validate(range(min = 1, max = 60))]
    framerate: u8,
    #[validate(custom = "valid_resolutions")]
    resolutions: HashSet<u16>,
}

#[derive(Deserialize, Validate, Debug)]
struct PostVideo {
    uuid: Uuid,
    #[validate(custom = "valid_resolution")]
    resolution: u16,
}

#[get("/video/{uuid}/{resolution}")]
async fn get_video(params: Path<GetVideo>) -> actix_web::Result<impl Responder> {
    Ok(HttpResponse::Ok().content_type("video/webm").finish())
}

#[put("/video")]
async fn put_video(
    payload: Json<PutVideo>,
    data: Data<AppState>,
) -> actix_web::Result<impl Responder> {
    let has_resolution = |resolution| {
        if payload.resolutions.contains(&resolution) {
            VideoUploadState::Uploading
        } else {
            VideoUploadState::Unavailable
        }
    };
    let uuid = Uuid::new_v4();
    let video = video::ActiveModel {
        uuid: Set(uuid),
        title: Set(payload.title.clone()),
        description: Set(payload.description.clone()),
        duration: Set(payload.duration),
        framerate: Set(payload.framerate as i16),
        tags: Set(payload.tags.clone()),
        state_144p: Set(has_resolution(144)),
        state_240p: Set(has_resolution(240)),
        state_360p: Set(has_resolution(360)),
        state_480p: Set(has_resolution(480)),
        state_720p: Set(has_resolution(720)),
        state_1080p: Set(has_resolution(1080)),
        state_1440p: Set(has_resolution(1440)),
        ..Default::default()
    };

    video
        .insert(&data.db_connection)
        .await
        .map_err(|_| ErrorInternalServerError("Unable to insert new video"))?;

    Ok(uuid.to_string())
}

#[post("/video/{uuid}/{resolution}")]
async fn post_video(
    params: Path<PostVideo>,
    mut payload: Payload,
    data: Data<AppState>,
) -> actix_web::Result<impl Responder> {
    let resolution_column = match params.resolution {
        144 => Ok(video::Column::State144p),
        240 => Ok(video::Column::State240p),
        360 => Ok(video::Column::State360p),
        480 => Ok(video::Column::State480p),
        720 => Ok(video::Column::State720p),
        1080 => Ok(video::Column::State1080p),
        1440 => Ok(video::Column::State1440p),
        _ => Err(ErrorNotFound("Wrong resolution")),
    }?;
    let mut video: video::ActiveModel = video::Entity::find_by_id(params.uuid)
        .filter(resolution_column.eq(VideoUploadState::Uploading))
        .one(&data.db_connection)
        .await
        .map_err(|_| ErrorInternalServerError("Unable to find a video with this resolution"))?
        .ok_or_else(|| ErrorNotFound("Unable to find a video with this resolution"))?
        .into();

    create_dir_all(format!("./video/{}/", params.resolution))
        .await
        .ok();

    let mut file = OpenOptions::new()
        .append(true)
        .create(true)
        .open(format!(
            "./video/{}/{}.webm",
            params.resolution, params.uuid
        ))
        .await
        .map_err(|_| ErrorInternalServerError("Unable to write data"))?;
    let mut has_data = false;

    while let Some(bytes_result) = payload.next().await {
        has_data = true;
        file.write(&bytes_result?)
            .await
            .map_err(|_| ErrorInternalServerError("Unable to write data"))?;
    }

    if !has_data {
        video.set(resolution_column, VideoUploadState::Available.into());
        video
            .update(&data.db_connection)
            .await
            .map_err(|_| ErrorInternalServerError("Unable to end the video file"))?;
    }

    Ok("")
}
