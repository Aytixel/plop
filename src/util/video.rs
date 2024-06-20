use std::collections::HashSet;

use actix_web::error::{ErrorInternalServerError, ErrorNotFound};
use fred::{
    clients::RedisClient,
    interfaces::KeysInterface,
    types::{Expiration, RedisValue},
};
use sea_orm::{ActiveEnum, DatabaseConnection, EntityTrait};
use uuid::Uuid;
use validator::ValidationError;

use crate::entity::{
    sea_orm_active_enums::VideoUploadState,
    video::{self, Model},
};

pub const VIDEO_REDIS_TIMEOUT: i64 = 3600;

pub async fn get_resolution_availability(
    uuid: &Uuid,
    resolution: u16,
    db_connection: &DatabaseConnection,
    redis_client: &RedisClient,
) -> actix_web::Result<()> {
    let key = format!("video:{uuid}:{resolution}");
    let availability = redis_client
        .get::<String, _>(&key)
        .await
        .unwrap_or("nil".to_string());

    if availability != "nil" {
        redis_client
            .expire::<RedisValue, _>(key, VIDEO_REDIS_TIMEOUT)
            .await
            .ok();

        if availability != VideoUploadState::Available.to_value().to_string() {
            return Err(ErrorNotFound("Unable to find a video with this resolution"));
        }

        Ok(())
    } else {
        find_video_by_resolution(
            &uuid,
            resolution_to_column(resolution)?,
            VideoUploadState::Available,
            db_connection,
            redis_client,
        )
        .await?;

        Ok(())
    }
}

pub async fn find_video(
    uuid: &Uuid,
    db_connection: &DatabaseConnection,
) -> actix_web::Result<video::Model> {
    video::Entity::find_by_id(uuid.clone())
        .one(db_connection)
        .await
        .map_err(|_| ErrorInternalServerError("Unable to find a video with this resolution"))?
        .ok_or_else(|| ErrorNotFound("Unable to find a video with this resolution"))
}

pub async fn find_video_by_resolution(
    uuid: &Uuid,
    resolution_column: video::Column,
    video_upload_state: VideoUploadState,
    db_connection: &DatabaseConnection,
    redis_client: &RedisClient,
) -> actix_web::Result<video::Model> {
    let video = find_video(uuid, db_connection).await?;
    let (resolution, resolution_video_upload_state) = match resolution_column {
        video::Column::State144p => (144, &video.state_144p),
        video::Column::State240p => (240, &video.state_240p),
        video::Column::State360p => (360, &video.state_360p),
        video::Column::State480p => (480, &video.state_480p),
        video::Column::State720p => (720, &video.state_720p),
        video::Column::State1080p => (1080, &video.state_1080p),
        video::Column::State1440p => (1440, &video.state_1440p),
        _ => unreachable!(),
    };

    redis_client
        .set::<RedisValue, _, _>(
            format!("video:{uuid}:{resolution}"),
            resolution_video_upload_state.to_value().to_string(),
            Some(Expiration::EX(VIDEO_REDIS_TIMEOUT)),
            None,
            false,
        )
        .await
        .ok();

    if resolution_video_upload_state != &video_upload_state {
        return Err(ErrorNotFound("Unable to find a video with this resolution"));
    }

    Ok(video)
}

pub fn get_resolutions<T: Fn(&VideoUploadState, &VideoUploadState) -> bool>(
    video: &Model,
    op: T,
    state: VideoUploadState,
) -> Vec<i32> {
    let mut resolutions = Vec::new();

    if op(&video.state_144p, &state) {
        resolutions.push(144);
    }
    if op(&video.state_240p, &state) {
        resolutions.push(240);
    }
    if op(&video.state_360p, &state) {
        resolutions.push(360);
    }
    if op(&video.state_480p, &state) {
        resolutions.push(480);
    }
    if op(&video.state_720p, &state) {
        resolutions.push(720);
    }
    if op(&video.state_1080p, &state) {
        resolutions.push(1080);
    }
    if op(&video.state_1440p, &state) {
        resolutions.push(1440);
    }

    resolutions
}

pub fn resolution_to_column(resolution: u16) -> actix_web::Result<video::Column> {
    match resolution {
        144 => Ok(video::Column::State144p),
        240 => Ok(video::Column::State240p),
        360 => Ok(video::Column::State360p),
        480 => Ok(video::Column::State480p),
        720 => Ok(video::Column::State720p),
        1080 => Ok(video::Column::State1080p),
        1440 => Ok(video::Column::State1440p),
        _ => unreachable!(),
    }
}

pub fn valid_resolution(resolution: u16) -> Result<(), ValidationError> {
    let resolutions = vec![144, 240, 360, 480, 720, 1080, 1440];

    if resolutions.contains(&resolution) {
        Ok(())
    } else {
        Err(ValidationError::new("Wrong resolution !"))
    }
}

pub fn valid_resolutions(resolutions: &HashSet<u16>) -> Result<(), ValidationError> {
    for resolution in resolutions {
        valid_resolution(*resolution)?;
    }

    Ok(())
}
