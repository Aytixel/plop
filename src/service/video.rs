use std::{
    fs::File,
    io::{Seek, SeekFrom},
    time::SystemTime,
};

use ::uuid::Uuid;
use actix_files::NamedFile;
use actix_web::{
    error::{ErrorInternalServerError, ErrorRangeNotSatisfiable},
    get,
    http::StatusCode,
    web::Data,
    HttpRequest, HttpResponse, Responder,
};
use actix_web_validator5::Path;
use chrono::{DateTime, Utc};
use fred::{
    prelude::KeysInterface,
    types::{Expiration, RedisValue},
};
use futures::future::join;
use gorse_rs::Feedback;
use sea_orm::{ActiveModelTrait, EntityTrait};
use serde::Deserialize;
use serde_json::json;
use tokio::task::yield_now;
use validator::Validate;
use webm_iterable::{
    matroska_spec::{Master, MatroskaSpec, SimpleBlock},
    WebmIterator, WebmWriter,
};

use crate::{
    entity::video,
    util::{
        get_authentication_data, get_gorse_user_id,
        video::{find_video, VIDEO_REDIS_TIMEOUT},
        video::{get_resolution_availability, valid_resolution},
        DEFAULT_GORSE_USER_ID,
    },
    AppState, MeilliDocument,
};

pub mod uuid {
    use super::*;

    pub mod resolution {
        use super::*;

        #[derive(Deserialize, Validate, Debug)]
        struct GetVideo {
            uuid: Uuid,
            #[validate(custom(function = "valid_resolution"))]
            resolution: u16,
        }

        #[get("/video/{uuid}/{resolution}")]
        pub async fn get(
            request: HttpRequest,
            params: Path<GetVideo>,
            data: Data<AppState<'_>>,
        ) -> actix_web::Result<impl Responder> {
            get_resolution_availability(
                &params.uuid,
                params.resolution,
                &data.db_connection,
                &data.redis_client,
            )
            .await?;

            Ok(NamedFile::open(format!(
                "./video/{}/{}.webm",
                params.resolution, params.uuid
            ))
            .map(|file| file.use_etag(false).use_last_modified(false))
            .map_err(|_| ErrorInternalServerError("Unable to open the file"))?
            .into_response(&request)
            .customize()
            .insert_header(("Cache-Control", "max-age=2592000")))
        }

        pub mod start_timestamp {
            use super::*;

            pub mod end_timestamp {
                use super::*;

                #[derive(Deserialize, Validate, Debug)]
                struct GetVideo {
                    uuid: Uuid,
                    #[validate(custom(function = "valid_resolution"))]
                    resolution: u16,
                    start_timestamp: u64,
                    end_timestamp: u64,
                }

                #[get("/video/{uuid}/{resolution}/{start_timestamp}/{end_timestamp}")]
                pub async fn get(
                    request: HttpRequest,
                    params: Path<GetVideo>,
                    data: Data<AppState<'_>>,
                ) -> actix_web::Result<impl Responder> {
                    if params.end_timestamp < params.start_timestamp {
                        return Err(ErrorRangeNotSatisfiable(
                            "End timestamp is lower than start timestamp",
                        ));
                    }

                    get_resolution_availability(
                        &params.uuid,
                        params.resolution,
                        &data.db_connection,
                        &data.redis_client,
                    )
                    .await?;

                    let video_timestamp_key =
                        format!("video:timestamp:{}:{}", params.uuid, params.resolution);
                    let last_frame_timestamp = match data
                        .redis_client
                        .get::<String, _>(&video_timestamp_key)
                        .await
                        .map(|timestamp| timestamp.parse::<u64>())
                    {
                        Ok(Ok(timestamp)) => {
                            data.redis_client
                                .expire::<RedisValue, _>(video_timestamp_key, VIDEO_REDIS_TIMEOUT)
                                .await
                                .ok();

                            timestamp
                        }
                        Ok(Err(_)) | Err(_) => {
                            let video = find_video(&params.uuid, &data.db_connection).await?;
                            let last_frame_timestamp = (video.duration.to_owned() * 1_000.0) as u64;

                            data.redis_client
                                .set::<RedisValue, _, _>(
                                    video_timestamp_key,
                                    last_frame_timestamp.to_string(),
                                    Some(Expiration::EX(VIDEO_REDIS_TIMEOUT)),
                                    None,
                                    false,
                                )
                                .await
                                .ok();

                            last_frame_timestamp
                        }
                    };

                    let mut input = File::open(format!(
                        "./video/{}/{}.webm",
                        params.resolution, params.uuid
                    ))
                    .map_err(|_| ErrorInternalServerError("Unable to read the file"))?;
                    let mut cluster_timestamp = 0u64;
                    let mut keyframes: Vec<u64> = WebmIterator::new(&mut input, &[])
                        .filter_map(|tag| match tag {
                            Ok(MatroskaSpec::SimpleBlock(ref block)) => {
                                let block = SimpleBlock::try_from(block).unwrap();

                                (block.keyframe && block.track == 1 && block.timestamp != 0).then(
                                    || {
                                        cluster_timestamp
                                            .saturating_add_signed(block.timestamp as i64)
                                    },
                                )
                            }
                            Ok(MatroskaSpec::Timestamp(timestamp)) => {
                                cluster_timestamp = timestamp;

                                None
                            }
                            Ok(MatroskaSpec::CueTime(keyframe)) => Some(keyframe),
                            _ => None,
                        })
                        .collect();

                    keyframes.push(last_frame_timestamp);

                    let start_timestamp = *keyframes
                        .iter()
                        .min_by_key(|keyframe| keyframe.abs_diff(params.start_timestamp))
                        .unwrap_or(&params.start_timestamp);
                    let end_timestamp = *keyframes
                        .iter()
                        .min_by_key(|keyframe| keyframe.abs_diff(params.end_timestamp))
                        .unwrap_or(&params.end_timestamp);

                    input.seek(SeekFrom::Start(0)).unwrap();

                    let tag_iterator =
                        WebmIterator::new(input, &[MatroskaSpec::Cues(Master::Start)]);
                    let mut buffer = Vec::new();
                    let mut tag_writer = WebmWriter::new(&mut buffer);
                    let mut first_cluster = true;
                    let mut cluster_timestamp = 0u64;
                    let mut keyframe_timestamp = 0u64;

                    for tag in tag_iterator {
                        if let Ok(tag) = tag {
                            match tag {
                                MatroskaSpec::SimpleBlock(ref block) => {
                                    let mut block = SimpleBlock::try_from(block).unwrap();
                                    let timestamp = cluster_timestamp
                                        .saturating_add_signed(block.timestamp as i64);

                                    if timestamp >= start_timestamp && timestamp <= end_timestamp {
                                        if block.keyframe && block.track == 1 {
                                            keyframe_timestamp = timestamp;

                                            if !first_cluster {
                                                yield_now().await;
                                                tag_writer
                                                    .write(&MatroskaSpec::Cluster(Master::End))
                                                    .unwrap();
                                            }

                                            first_cluster = false;

                                            yield_now().await;
                                            tag_writer
                                                .write(&MatroskaSpec::Cluster(Master::Start))
                                                .unwrap();
                                            yield_now().await;
                                            tag_writer
                                                .write(&MatroskaSpec::Timestamp(timestamp))
                                                .unwrap();
                                        }

                                        block.timestamp =
                                            timestamp.saturating_sub(keyframe_timestamp) as i16;

                                        yield_now().await;
                                        tag_writer.write(&MatroskaSpec::from(block)).unwrap();
                                    }
                                }
                                MatroskaSpec::Cluster(_) => {}
                                MatroskaSpec::Timestamp(timestamp) => cluster_timestamp = timestamp,
                                MatroskaSpec::Cues(_) => {
                                    tag_writer
                                        .write(&MatroskaSpec::Cluster(Master::End))
                                        .unwrap();
                                }
                                _ => tag_writer.write(&tag).unwrap(),
                            }
                        }
                    }

                    tag_writer.flush().unwrap();

                    {
                        // update views
                        let jwt = get_authentication_data(&request, &data.clerk).await;
                        let user_id = get_gorse_user_id(&request, &jwt).await;
                        let view_key = format!("view:{user_id}:{}", params.uuid);
                        let mut view_duration = params.end_timestamp - params.start_timestamp
                            + data
                                .redis_client
                                .get::<u64, _>(&view_key)
                                .await
                                .unwrap_or_default();
                        let view_threshold = last_frame_timestamp / 4 * 3;

                        if view_duration >= view_threshold {
                            view_duration -= view_threshold;

                            let (_, video) = join(
                                data.gorse_client.insert_feedback(&vec![
                                    Feedback {
                                        feedback_type: "view".to_string(),
                                        user_id,
                                        item_id: params.uuid.to_string(),
                                        timestamp: DateTime::<Utc>::from(SystemTime::now())
                                            .to_rfc3339(),
                                    },
                                    Feedback {
                                        feedback_type: "view".to_string(),
                                        user_id: DEFAULT_GORSE_USER_ID.to_string(),
                                        item_id: params.uuid.to_string(),
                                        timestamp: DateTime::<Utc>::from(SystemTime::now())
                                            .to_rfc3339(),
                                    },
                                ]),
                                video::Entity::find_by_id(params.uuid).one(&data.db_connection),
                            )
                            .await;

                            if let Ok(Some(video)) = video {
                                let views = video.views + 1;
                                let mut video = video::ActiveModel::from(video);

                                video.set(video::Column::Views, views.into());

                                let _ = join(
                                    data.video_index.add_or_update(
                                        &[MeilliDocument {
                                            id: params.uuid.to_string(),
                                            value: json!({
                                                "views": views
                                            }),
                                        }],
                                        Some("id"),
                                    ),
                                    video.update(&data.db_connection),
                                )
                                .await;
                            }
                        }

                        data.redis_client
                            .set::<RedisValue, _, _>(
                                view_key,
                                view_duration,
                                Some(Expiration::EX(VIDEO_REDIS_TIMEOUT)),
                                None,
                                false,
                            )
                            .await
                            .ok();
                        // update views
                    }

                    Ok(HttpResponse::with_body(StatusCode::OK, buffer)
                        .customize()
                        .insert_header(("Content-Type", "video/webm"))
                        .insert_header((
                            "X-Content-Range",
                            format!(
                                "{}-{}/{}",
                                start_timestamp,
                                end_timestamp,
                                last_frame_timestamp.max(end_timestamp)
                            ),
                        ))
                        .respond_to(&request))
                }
            }
        }
    }
}
