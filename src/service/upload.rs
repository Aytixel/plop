use std::{collections::HashSet, io::SeekFrom};

use ::uuid::Uuid;
use actix_web::{
    error::ErrorInternalServerError,
    get,
    http::header,
    post, put,
    web::{Data, Header, Payload},
    HttpResponse, Responder,
};
use actix_web_validator5::{Json, Path};
use data_url::DataUrl;
use file_format::FileFormat;
use fred::{
    interfaces::KeysInterface,
    types::{Expiration, RedisValue},
};
use sea_orm::{ActiveEnum, ActiveModelTrait, Set};
use serde::Deserialize;
use serde_json::json;
use tokio::{
    fs::{create_dir_all, remove_file, OpenOptions},
    io::{AsyncSeekExt, AsyncWriteExt},
};
use tokio_stream::StreamExt;
use validator::{Validate, ValidationError};

use crate::{
    entity::{sea_orm_active_enums::VideoUploadState, video},
    service::video::uuid::resolution::{find_video, get_resolution, VIDEO_REDIS_TIMEOUT},
    AppState,
};

use super::video::valid_resolution;

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
    #[validate(range(min = 0.0))]
    duration: f64,
    #[validate(range(min = 1, max = 60))]
    framerate: u8,
    #[validate(custom(function = "valid_resolutions"))]
    resolutions: HashSet<u16>,
    thumbnail: String,
    has_audio: bool,
}

#[put("/upload")]
async fn put(
    payload: Json<PutVideo>,
    data: Data<AppState<'_>>,
) -> actix_web::Result<impl Responder> {
    let thumbnail_data_url = DataUrl::process(&payload.thumbnail)
        .map_err(|_| ErrorInternalServerError("Unable to process thumbnail data"))?;
    let thumbnail_data = thumbnail_data_url
        .decode_to_vec()
        .map_err(|_| ErrorInternalServerError("Unable to extract thumbnail data"))?
        .0;

    if FileFormat::from_bytes(&thumbnail_data).media_type() != "image/webp" {
        return Err(ErrorInternalServerError("Wrong thumbnail mime type"));
    }

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
        has_audio: Set(payload.has_audio),
        ..Default::default()
    };

    video
        .insert(&data.db_connection)
        .await
        .map_err(|_| ErrorInternalServerError("Unable to insert new video"))?;

    create_dir_all("./thumbnail/".to_string()).await.ok();

    if let Ok(mut file) = OpenOptions::new()
        .write(true)
        .create(true)
        .open(format!("./thumbnail/{}.webp", uuid))
        .await
    {
        file.write(&thumbnail_data).await.ok();
    }

    Ok(uuid.to_string())
}

pub mod uuid {
    use super::*;

    pub mod resolution {
        use super::*;

        #[derive(Deserialize, Validate, Debug)]
        struct PostVideo {
            uuid: Uuid,
            #[validate(custom(function = "valid_resolution"))]
            resolution: u16,
        }

        #[post("/upload/{uuid}/{resolution}")]
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

            let path = format!("./video/{}/{}.webm", params.resolution, params.uuid);
            let mut file = OpenOptions::new()
                .write(true)
                .create(true)
                .open(&path)
                .await
                .map_err(|_| ErrorInternalServerError("Unable to open the file"))?;
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
                let video_file_format = FileFormat::from_file(&path)
                    .map_err(|_| ErrorInternalServerError("Unable to open the file"))?;
                let video_upload_state = if video_file_format.media_type() == "video/webm"
                    || video_file_format.media_type() == "application/x-ebml"
                {
                    VideoUploadState::Available
                } else {
                    remove_file(&path).await.ok();

                    VideoUploadState::Unavailable
                };

                data.redis_client
                    .set::<RedisValue, _, _>(
                        format!("video:{}:{}", params.uuid, params.resolution),
                        video_upload_state.to_value().to_string(),
                        Some(Expiration::EX(VIDEO_REDIS_TIMEOUT)),
                        None,
                        false,
                    )
                    .await
                    .ok();
                video.set(resolution_column, video_upload_state.into());
                video
                    .update(&data.db_connection)
                    .await
                    .map_err(|_| ErrorInternalServerError("Unable to end the video file"))?;
            }

            Ok("")
        }
    }
}
