use std::{
    collections::{HashMap, HashSet},
    io::SeekFrom,
};

use ::uuid::Uuid;
use actix_web::{
    delete,
    error::ErrorInternalServerError,
    get,
    http::header,
    post, put,
    web::{Data, Header, Payload},
    HttpRequest, HttpResponse, Responder,
};
use actix_web_validator5::{Json, Path};
use data_url::DataUrl;
use file_format::FileFormat;
use fred::{
    interfaces::KeysInterface,
    types::{Expiration, RedisValue},
};
use futures::future::{join, join3};
use gorse_rs::Item;
use sea_orm::{
    ActiveEnum, ActiveModelTrait, ColumnTrait, EntityTrait, ModelTrait, QueryFilter, QueryOrder,
    Set,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::{
    fs::{create_dir_all, remove_file, OpenOptions},
    io::{AsyncSeekExt, AsyncWriteExt},
};
use tokio_stream::StreamExt;
use validator::Validate;
use video::ActiveModel;

use crate::{
    entity::{sea_orm_active_enums::VideoUploadState, video},
    util::{
        get_authentication_data,
        video::{
            find_video, find_video_by_resolution, get_resolutions, resolution_to_column,
            valid_resolution, valid_resolutions, VIDEO_REDIS_TIMEOUT,
        },
    },
    AppState, MeilliDocument,
};

#[get("/upload")]
async fn get(request: HttpRequest, data: Data<AppState<'_>>) -> actix_web::Result<impl Responder> {
    let Some(jwt) = get_authentication_data(&request, &data.clerk).await else {
        return Ok(HttpResponse::TemporaryRedirect()
            .insert_header(("Location", "/"))
            .finish());
    };

    let videos: Vec<Value> = video::Entity::find()
        .filter(video::Column::UserId.eq(jwt.sub))
        .order_by_desc(video::Column::Timestamp)
        .all(&data.db_connection)
        .await
        .map_err(|_| ErrorInternalServerError("Unable to find a videos"))?
        .into_iter()
        .map(|video| {
            json!({
                "uuid": video.uuid,
                "title": video.title,
                "views": video.views,
                "timestamp": video.timestamp.format("%Y-%m-%dT%H:%M:%S%.fZ").to_string(),
                "duration": video.duration,
                "resolutions": [
                    {
                        "resolution": 144,
                        "state": video.state_144p.into_value().as_str(),
                    },
                    {
                        "resolution": 240,
                        "state": video.state_240p.into_value().as_str(),
                    },
                    {
                        "resolution": 360,
                        "state": video.state_360p.into_value().as_str(),
                    },
                    {
                        "resolution": 480,
                        "state": video.state_480p.into_value().as_str(),
                    },
                    {
                        "resolution": 720,
                        "state": video.state_720p.into_value().as_str(),
                    },
                    {
                        "resolution": 1080,
                        "state": video.state_1080p.into_value().as_str(),
                    },
                    {
                        "resolution": 1440,
                        "state": video.state_1440p.into_value().as_str(),
                    },
                ],
            })
        })
        .collect();

    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .insert_header(("Content-type", "text/html; charset=utf-8"))
        .body(
            data.handlebars
                .render(
                    "upload",
                    &json!({
                        "videos": videos
                    }),
                )
                .unwrap(),
        ))
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
    request: HttpRequest,
    payload: Json<PutVideo>,
    data: Data<AppState<'_>>,
) -> actix_web::Result<impl Responder> {
    let Some(jwt) = get_authentication_data(&request, &data.clerk).await else {
        return Ok(HttpResponse::Unauthorized().body("User not logged in"));
    };

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
        tags: Set(payload.tags.clone().map(|tags| {
            tags.split(&[',', ' '][..])
                .filter_map(|tag| {
                    let tag = tag.trim();

                    (!str::is_empty(tag)).then(|| tag)
                })
                .map(str::to_string)
                .collect::<Vec<String>>()
                .join(",")
        })),
        state_144p: Set(has_resolution(144)),
        state_240p: Set(has_resolution(240)),
        state_360p: Set(has_resolution(360)),
        state_480p: Set(has_resolution(480)),
        state_720p: Set(has_resolution(720)),
        state_1080p: Set(has_resolution(1080)),
        state_1440p: Set(has_resolution(1440)),
        has_audio: Set(payload.has_audio),
        user_id: Set(jwt.sub),
        ..Default::default()
    };

    let (video, _) = join(
        video.insert(&data.db_connection),
        create_dir_all("./thumbnail/".to_string()),
    )
    .await;

    video.map_err(|_| ErrorInternalServerError("Unable to insert new video"))?;

    if let Ok(mut file) = OpenOptions::new()
        .write(true)
        .create(true)
        .open(format!("./thumbnail/{}.webp", uuid))
        .await
    {
        file.write(&thumbnail_data).await.ok();
    }

    Ok(HttpResponse::Ok().body(uuid.to_string()))
}

#[derive(Deserialize, Validate, Debug)]
struct DeleteVideo {
    uuids: Vec<Uuid>,
}

async fn delete_video(uuid: &Uuid, data: &Data<AppState<'_>>) -> actix_web::Result<()> {
    let video = find_video(uuid, &data.db_connection).await?;
    let resolutions = get_resolutions(&video, VideoUploadState::ne, VideoUploadState::Unavailable);

    remove_file(format!("./thumbnail/{uuid}.webp")).await.ok();

    for resolution in &resolutions {
        remove_file(format!("./video/{resolution}/{uuid}.webm"))
            .await
            .ok();
    }

    let _ = join3(
        data.redis_client.del::<RedisValue, _>(
            resolutions
                .iter()
                .map(|resolution| format!("video:{uuid}:{resolution}"))
                .collect::<Vec<String>>(),
        ),
        data.gorse_client.delete_item(&uuid.to_string()),
        video.delete(&data.db_connection),
    )
    .await;

    Ok(())
}

#[delete("/upload")]
async fn delete(
    payload: Json<DeleteVideo>,
    data: Data<AppState<'_>>,
) -> actix_web::Result<impl Responder> {
    let mut uuids = Vec::new();
    let mut errors = HashMap::new();

    for uuid in &payload.uuids {
        match delete_video(uuid, &data).await {
            Ok(_) => uuids.push(uuid),
            Err(error) => {
                errors.insert(uuid, error.to_string());
            }
        }
    }

    data.video_index
        .delete_documents(&uuids)
        .await
        .map_err(|_| ErrorInternalServerError("Unable to remove videos from the search base"))?
        .wait_for_completion(&data.meillisearch_client, None, None)
        .await
        .map_err(|_| ErrorInternalServerError("Unable to remove videos from the search base"))?;

    Ok(HttpResponse::Ok().json(json!({
        "uuids": uuids,
        "errors": errors,
    })))
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
            request: HttpRequest,
            params: Path<PostVideo>,
            mut payload: Payload,
            data: Data<AppState<'_>>,
            range_header_option: Option<Header<header::Range>>,
        ) -> actix_web::Result<impl Responder> {
            let Some(jwt) = get_authentication_data(&request, &data.clerk).await else {
                return Ok(HttpResponse::Unauthorized().body("User not logged in"));
            };

            let resolution_column = resolution_to_column(params.resolution)?;
            let video = find_video_by_resolution(
                &params.uuid,
                resolution_column,
                VideoUploadState::Uploading,
                &data.db_connection,
                &data.redis_client,
            )
            .await?;

            if video.user_id != jwt.sub {
                return Ok(
                    HttpResponse::Forbidden().body("You cannot upload in place of another user")
                );
            }

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
                    let tags: Vec<String> = video.tags.clone().map_or(Vec::new(), |tags| {
                        tags.split(",").map(str::to_string).collect()
                    });

                    data.video_index
                        .add_documents(
                            &[MeilliDocument {
                                id: video.uuid.to_string(),
                                value: json!({
                                    "title": video.title,
                                    "description": video.description,
                                    "tags": tags,
                                    "views": video.views,
                                    "likes": video.likes,
                                    "duration": video.duration,
                                    "timestamp": video.timestamp,
                                    "user_id": video.user_id,
                                }),
                            }],
                            Some("id"),
                        )
                        .await
                        .map_err(|_| {
                            ErrorInternalServerError("Unable to add video to the search base")
                        })?
                        .wait_for_completion(&data.meillisearch_client, None, None)
                        .await
                        .map_err(|_| {
                            ErrorInternalServerError("Unable to add video to the search base")
                        })?;

                    let mut labels: Vec<String> = tags
                        .clone()
                        .iter()
                        .map(|tag| format!("tag:{tag}"))
                        .collect();

                    labels.extend_from_slice(&[
                        format!("title:{}", video.title),
                        format!("duration:{}", video.duration),
                        format!("channel:{}", video.user_id),
                    ]);

                    data.gorse_client
                        .insert_item(&Item {
                            item_id: video.uuid.to_string(),
                            is_hidden: false,
                            labels: labels,
                            categories: Vec::new(),
                            timestamp: video.timestamp.to_string(),
                            comment: video.description.clone().unwrap_or_default(),
                        })
                        .await
                        .map_err(|_| {
                            ErrorInternalServerError(
                                "Unable to add video to the recommendation base",
                            )
                        })?;

                    VideoUploadState::Available
                } else {
                    remove_file(&path).await.ok();

                    VideoUploadState::Unavailable
                };

                let mut video = ActiveModel::from(video);
                let video_upload_state_string = video_upload_state.to_value().to_string();

                video.set(resolution_column, video_upload_state.into());

                let (video, _) = join(
                    video.update(&data.db_connection),
                    data.redis_client.set::<RedisValue, _, _>(
                        format!("video:{}:{}", params.uuid, params.resolution),
                        video_upload_state_string,
                        Some(Expiration::EX(VIDEO_REDIS_TIMEOUT)),
                        None,
                        false,
                    ),
                )
                .await;

                video.map_err(|_| ErrorInternalServerError("Unable to end the video file"))?;
            }

            Ok(HttpResponse::Ok().finish())
        }
    }
}
