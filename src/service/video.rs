use std::{collections::HashSet, io::SeekFrom};

use ::uuid::Uuid;
use actix_files::NamedFile;
use actix_web::{
    error::{ErrorInternalServerError, ErrorNotFound},
    get,
    http::header,
    post, put,
    web::{Data, Header, Payload},
    HttpRequest, Responder,
};
use actix_web_validator::{Json, Path};
use ammonia::clean_text;
use fred::{
    prelude::KeysInterface,
    types::{Expiration, RedisValue},
};
use sea_orm::{ActiveModelTrait, EntityTrait, Set};
use serde::Deserialize;
use tokio::{
    fs::{create_dir_all, OpenOptions},
    io::{AsyncSeekExt, AsyncWriteExt},
};
use tokio_stream::StreamExt;
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

#[put("/video")]
async fn put(
    payload: Json<PutVideo>,
    data: Data<AppState<'_>>,
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
        title: Set(clean_text(&payload.title)),
        description: Set(payload
            .description
            .as_ref()
            .map(|description| clean_text(description))),
        duration: Set(payload.duration),
        framerate: Set(payload.framerate as i16),
        tags: Set(payload
            .tags
            .as_ref()
            .map(|description| clean_text(description))),
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

pub mod uuid {
    use super::*;

    pub mod resolution {
        use super::*;

        fn get_resolution(resolution: u16) -> actix_web::Result<video::Column> {
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

        const VIDEO_REDIS_TIMEOUT: i64 = 3600;

        async fn find_video(
            uuid: Uuid,
            resolution_column: video::Column,
            video_upload_state: VideoUploadState,
            data: &Data<AppState<'_>>,
        ) -> actix_web::Result<video::ActiveModel> {
            let video = video::Entity::find_by_id(uuid)
                .one(&data.db_connection)
                .await
                .map_err(|_| {
                    ErrorInternalServerError("Unable to find a video with this resolution")
                })?
                .ok_or_else(|| ErrorNotFound("Unable to find a video with this resolution"))?;

            let (resolution, resolution_video_upload_state) = match resolution_column {
                video::Column::State144p => (144, video.state_144p.clone()),
                video::Column::State240p => (240, video.state_240p.clone()),
                video::Column::State360p => (360, video.state_360p.clone()),
                video::Column::State480p => (480, video.state_480p.clone()),
                video::Column::State720p => (720, video.state_720p.clone()),
                video::Column::State1080p => (1080, video.state_1080p.clone()),
                video::Column::State1440p => (1440, video.state_1440p.clone()),
                _ => unreachable!(),
            };

            data.redis_client
                .set::<RedisValue, _, _>(
                    format!("video:{}:{}", uuid, resolution),
                    resolution_video_upload_state.to_string(),
                    Some(Expiration::EX(VIDEO_REDIS_TIMEOUT)),
                    None,
                    false,
                )
                .await
                .ok();

            if resolution_video_upload_state != video_upload_state {
                return Err(ErrorNotFound("Unable to find a video with this resolution"));
            }

            Ok(video.into())
        }

        #[derive(Deserialize, Validate, Debug)]
        struct GetVideo {
            uuid: Uuid,
            #[validate(custom = "valid_resolution")]
            resolution: u16,
        }

        #[get("/video/{uuid}/{resolution}")]
        async fn get(
            request: HttpRequest,
            params: Path<GetVideo>,
            data: Data<AppState<'_>>,
        ) -> actix_web::Result<impl Responder> {
            let resolution_column = get_resolution(params.resolution)?;
            let mut is_cached = false;
            let video_key = format!("video:{}:{}", params.uuid, params.resolution);

            if let Ok(availability) = data.redis_client.get::<String, _>(&video_key).await {
                if availability != "nil" {
                    is_cached = true;

                    data.redis_client
                        .expire::<RedisValue, _>(video_key, VIDEO_REDIS_TIMEOUT)
                        .await
                        .ok();

                    if availability != VideoUploadState::Available.to_string() {
                        return Err(ErrorNotFound("Unable to find a video with this resolution"));
                    }
                }
            }

            if !is_cached {
                find_video(
                    params.uuid,
                    resolution_column,
                    VideoUploadState::Available,
                    &data,
                )
                .await?;
            }

            Ok(NamedFile::open(format!(
                "./video/{}/{}.webm",
                params.resolution, params.uuid
            ))
            .map_err(|_| ErrorInternalServerError("Unable open the video file"))?
            .into_response(&request))
        }

        #[derive(Deserialize, Validate, Debug)]
        struct PostVideo {
            uuid: Uuid,
            #[validate(custom = "valid_resolution")]
            resolution: u16,
        }

        #[post("/video/{uuid}/{resolution}")]
        async fn post(
            params: Path<PostVideo>,
            mut payload: Payload,
            data: Data<AppState<'_>>,
            range_header_option: Option<Header<header::Range>>,
        ) -> actix_web::Result<impl Responder> {
            let resolution_column = get_resolution(params.resolution)?;
            let mut video = find_video(
                params.uuid,
                resolution_column,
                VideoUploadState::Uploading,
                &data,
            )
            .await?;

            create_dir_all(format!("./video/{}/", params.resolution))
                .await
                .ok();

            let mut file = OpenOptions::new()
                .write(true)
                .create(true)
                .open(format!(
                    "./video/{}/{}.webm",
                    params.resolution, params.uuid
                ))
                .await
                .map_err(|_| ErrorInternalServerError("Unable to write data"))?;
            let mut has_data = false;
            let mut has_seeked = false;

            if let Some(range_header) = range_header_option {
                if let header::Range::Bytes(range_vec) = range_header.0 {
                    if let Some(header::ByteRangeSpec::From(starting_byte)) = range_vec.get(0) {
                        file.seek(SeekFrom::Start(*starting_byte))
                            .await
                            .map_err(|_| {
                                ErrorInternalServerError("Unable to seek to the specified range")
                            })?;
                        has_seeked = true;
                    }
                }
            }

            while let Some(bytes_result) = payload.next().await {
                if !has_seeked {
                    break;
                }

                has_data = true;
                file.write(&bytes_result?)
                    .await
                    .map_err(|_| ErrorInternalServerError("Unable to write data"))?;
            }

            if !has_data {
                data.redis_client
                    .set::<RedisValue, _, _>(
                        format!("video:{}:{}", params.uuid, params.resolution),
                        VideoUploadState::Available.to_string(),
                        Some(Expiration::EX(VIDEO_REDIS_TIMEOUT)),
                        None,
                        false,
                    )
                    .await
                    .ok();
                video.set(resolution_column, VideoUploadState::Available.into());
                video
                    .update(&data.db_connection)
                    .await
                    .map_err(|_| ErrorInternalServerError("Unable to end the video file"))?;
            }

            Ok("")
        }
    }
}
