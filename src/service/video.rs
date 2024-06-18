use std::{fs::File, io::Cursor};

use ::uuid::Uuid;
use actix_files::NamedFile;
use actix_web::{
    error::{ErrorInternalServerError, ErrorNotFound, ErrorRangeNotSatisfiable},
    get,
    http::StatusCode,
    web::Data,
    HttpRequest, HttpResponse, Responder,
};
use actix_web_validator5::Path;
use fred::{
    prelude::KeysInterface,
    types::{Expiration, RedisValue},
};
use matroska_demuxer::{Frame, MatroskaFile, TrackType};
use sea_orm::{ActiveEnum, EntityTrait};
use serde::Deserialize;
use validator::{Validate, ValidationError};
use webm::mux::{AudioCodecId, Segment, VideoCodecId, Writer};

use crate::{
    entity::{sea_orm_active_enums::VideoUploadState, video},
    AppState,
};

pub fn valid_resolution(resolution: u16) -> Result<(), ValidationError> {
    let resolutions = vec![144, 240, 360, 480, 720, 1080, 1440];

    if resolutions.contains(&resolution) {
        Ok(())
    } else {
        Err(ValidationError::new("Wrong resolution !"))
    }
}

pub mod uuid {
    use super::*;

    pub mod resolution {
        use super::*;

        pub fn get_resolution(resolution: u16) -> actix_web::Result<video::Column> {
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

        pub const VIDEO_REDIS_TIMEOUT: i64 = 3600;

        pub async fn find_video(
            uuid: &Uuid,
            data: &Data<AppState<'_>>,
        ) -> actix_web::Result<video::Model> {
            video::Entity::find_by_id(uuid.clone())
                .one(&data.db_connection)
                .await
                .map_err(|_| {
                    ErrorInternalServerError("Unable to find a video with this resolution")
                })?
                .ok_or_else(|| ErrorNotFound("Unable to find a video with this resolution"))
        }

        pub async fn find_video_by_resolution(
            uuid: &Uuid,
            resolution_column: video::Column,
            video_upload_state: VideoUploadState,
            data: &Data<AppState<'_>>,
        ) -> actix_web::Result<video::ActiveModel> {
            let video = find_video(uuid, data).await?;

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
                    resolution_video_upload_state.to_value().to_string(),
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
            #[validate(custom(function = "valid_resolution"))]
            resolution: u16,
        }

        #[get("/video/{uuid}/{resolution}")]
        pub async fn get(
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

                    if availability != VideoUploadState::Available.to_value().to_string() {
                        return Err(ErrorNotFound("Unable to find a video with this resolution"));
                    }
                }
            }

            if !is_cached {
                find_video_by_resolution(
                    &params.uuid,
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
            .map(|file| file.use_etag(false).use_last_modified(false))
            .map_err(|_| ErrorInternalServerError("Unable to open the file"))?
            .into_response(&request)
            .customize()
            .insert_header(("Cache-Control", "max-age=2592000")))
        }

        pub mod start_timestamp {
            use super::*;

            pub mod end_timestamp {
                use webm::mux::Track;

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

                            if availability != VideoUploadState::Available.to_value().to_string() {
                                return Err(ErrorNotFound(
                                    "Unable to find a video with this resolution",
                                ));
                            }
                        }
                    }

                    if !is_cached {
                        find_video_by_resolution(
                            &params.uuid,
                            resolution_column,
                            VideoUploadState::Available,
                            &data,
                        )
                        .await?;
                    }

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
                            let video = find_video(&params.uuid, &data).await?;
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
