use std::{fs::File, io::Cursor, time::SystemTime};

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
use gorse_rs::Feedback;
use matroska_demuxer::{Frame, MatroskaFile, TrackType};
use serde::Deserialize;
use validator::Validate;
use webm::mux::{AudioCodecId, Segment, Track, VideoCodecId, Writer};

use crate::{
    util::{
        get_gorse_user_id,
        video::{find_video, VIDEO_REDIS_TIMEOUT},
        video::{get_resolution_availability, valid_resolution},
    },
    AppState,
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
                use sea_orm::{ActiveModelTrait, EntityTrait};
                use serde_json::Value;

                use crate::{entity::video, MeilliDocument};

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

                    let mut buffer = Vec::new();
                    let writer = Writer::new(Cursor::new(&mut buffer));
                    let mut segment = Segment::new(writer)
                        .ok_or(ErrorInternalServerError("Unable to create video segment"))?;
                    let mut file = MatroskaFile::open(
                        File::open(format!(
                            "./video/{}/{}.webm",
                            params.resolution, params.uuid
                        ))
                        .map_err(|_| ErrorInternalServerError("Unable to open the file"))?,
                    )
                    .map_err(|_| ErrorInternalServerError("Unable to read the file"))?;
                    let tracks = file.tracks();
                    let mut video_track = tracks
                        .iter()
                        .find(|track| track.track_type() == TrackType::Video)
                        .map(|track| {
                            let video = track.video().unwrap();
                            let video_track = segment.add_video_track(
                                video.pixel_width().get() as u32,
                                video.pixel_height().get() as u32,
                                Some(1),
                                VideoCodecId::VP9,
                            );

                            if let Some(codec_private) = track.codec_private() {
                                segment.set_codec_private(1, codec_private);
                            }

                            (track.track_number().get(), video_track)
                        });
                    let mut audio_track = tracks
                        .iter()
                        .find(|track| track.track_type() == TrackType::Audio)
                        .map(|track| {
                            let audio = track.audio().unwrap();
                            let audio_track = segment.add_audio_track(
                                audio.sampling_frequency() as i32,
                                audio.channels().get() as i32,
                                Some(2),
                                AudioCodecId::Opus,
                            );

                            if let Some(codec_private) = track.codec_private() {
                                segment.set_codec_private(2, codec_private);
                            }

                            (track.track_number().get(), audio_track)
                        });

                    let timescale = file.info().timestamp_scale().get();
                    let mut start_timestamp =
                        params.start_timestamp / 1_000_000_000 * 1_000_000_000;
                    let mut end_timestamp = params.end_timestamp / 1_000_000_000 * 1_000_000_000;
                    let mut frame = Frame::default();

                    if let Some((id, _)) = video_track {
                        const MAX_FRAMERATE: u64 = 60;
                        const MIN_FRAMETIME: u64 = 1_000_000_000 / MAX_FRAMERATE;

                        let mut find_keyframe = |timestamp: &mut u64| {
                            let mut timestamp_offset = 0;

                            'find_keyframe: for _ in 0..MAX_FRAMERATE / 2 {
                                file.seek((*timestamp + timestamp_offset) / timescale)
                                    .unwrap();

                                while let Ok(true) = file.next_frame(&mut frame) {
                                    if id == frame.track {
                                        if frame.is_keyframe.unwrap_or(false) {
                                            *timestamp = frame.timestamp * timescale;

                                            break 'find_keyframe;
                                        } else {
                                            break;
                                        }
                                    }
                                }

                                file.seek((*timestamp - timestamp_offset) / timescale)
                                    .unwrap();

                                while let Ok(true) = file.next_frame(&mut frame) {
                                    if id == frame.track {
                                        if frame.is_keyframe.unwrap_or(false) {
                                            *timestamp = frame.timestamp * timescale;

                                            break 'find_keyframe;
                                        } else {
                                            break;
                                        }
                                    }
                                }

                                timestamp_offset += MIN_FRAMETIME;
                            }
                        };

                        find_keyframe(&mut start_timestamp);
                        find_keyframe(&mut end_timestamp);
                    }

                    file.seek(start_timestamp / timescale).unwrap();

                    loop {
                        let Ok(true) = file.next_frame(&mut frame) else {
                            break;
                        };

                        let timestamp = frame.timestamp * timescale;

                        if timestamp > end_timestamp {
                            break;
                        }

                        let keyframe = frame.is_keyframe.unwrap_or(false);
                        let track_id = frame.track;

                        if let Some((id, ref mut track)) = video_track {
                            if id == track_id {
                                track.add_frame(&frame.data, timestamp, keyframe);
                            }
                        }

                        if let Some((id, ref mut track)) = audio_track {
                            if id == track_id {
                                track.add_frame(&frame.data, timestamp, keyframe);
                            }
                        }
                    }

                    segment
                        .try_finalize(Some((end_timestamp - start_timestamp) / timescale))
                        .map_err(|_| {
                            ErrorInternalServerError("Unable to finalize the video stream")
                        })?;

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
                            let last_frame_timestamp =
                                (video.duration.to_owned() * 1_000_000.0) as u64 * 1_000;

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

                    {
                        // update views
                        let user_id = get_gorse_user_id(&request, &data.clerk).await;
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

                            data.gorse_client
                                .insert_feedback(&vec![Feedback {
                                    feedback_type: "view".to_string(),
                                    user_id,
                                    item_id: params.uuid.to_string(),
                                    timestamp: DateTime::<Utc>::from(SystemTime::now())
                                        .to_rfc3339(),
                                }])
                                .await
                                .ok();

                            if let Ok(mut video) = data
                                .video_index
                                .get_document::<MeilliDocument>(&params.uuid.to_string())
                                .await
                            {
                                if let Some(object) = video.value.as_object_mut() {
                                    object["views"] = Value::from(
                                        object["views"].as_u64().unwrap_or_default() + 1,
                                    );
                                }

                                data.video_index
                                    .add_or_update(&[video], Some("id"))
                                    .await
                                    .ok();
                            }
                        }

                        if let Ok(Some(video)) = video::Entity::find_by_id(params.uuid)
                            .one(&data.db_connection)
                            .await
                        {
                            let views = video.views + 1;
                            let mut video = video::ActiveModel::from(video);

                            video.set(video::Column::Views, views.into());
                            video.update(&data.db_connection).await.ok();
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
