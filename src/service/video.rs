use std::{
    collections::HashSet,
    fs::File,
    io::{Cursor, SeekFrom},
    rc::Rc,
};

use ::uuid::Uuid;
use actix_web::{
    error::{ErrorInternalServerError, ErrorNotFound, ErrorRangeNotSatisfiable},
    get,
    http::{header, StatusCode},
    post, put,
    web::{Data, Header, Payload},
    HttpRequest, HttpResponse, Responder,
};
use actix_web_validator5::{Json, Path};
use data_url::DataUrl;
use file_format::FileFormat;
use fred::{
    prelude::KeysInterface,
    types::{Expiration, RedisValue},
};
use matroska_demuxer::{Frame, MatroskaFile, TrackType};
use sea_orm::{ActiveEnum, ActiveModelTrait, EntityTrait, Set};
use serde::Deserialize;
use tokio::{
    fs::{create_dir_all, remove_file, OpenOptions},
    io::{AsyncSeekExt, AsyncWriteExt},
};
use tokio_stream::StreamExt;
use validator::{Validate, ValidationError};
use webm::mux::{AudioCodecId, Segment, Track, VideoCodecId, Writer};

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
    #[validate(range(min = 0.0))]
    duration: f64,
    #[validate(range(min = 1, max = 60))]
    framerate: u8,
    #[validate(custom(function = "valid_resolutions"))]
    resolutions: HashSet<u16>,
    thumbnail: String,
}

#[put("/video")]
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
            start_timestamp: u64,
            end_timestamp: u64,
        }

        #[get("/video/{uuid}/{resolution}/{start_timestamp}/{end_timestamp}")]
        async fn get(
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

                    (
                        track.track_number().get(),
                        segment.add_video_track(
                            video.pixel_width().get() as u32,
                            video.pixel_height().get() as u32,
                            None,
                            VideoCodecId::VP9,
                        ),
                    )
                });
            let mut audio_track = tracks
                .iter()
                .find(|track| track.track_type() == TrackType::Audio)
                .map(|track| {
                    let audio = track.audio().unwrap();

                    (
                        track.track_number().get(),
                        segment.add_audio_track(
                            (audio.sampling_frequency() * 1000.0) as i32,
                            audio.channels().get() as i32,
                            None,
                            AudioCodecId::Opus,
                        ),
                    )
                });

            let timescale = file.info().timestamp_scale().get();
            let mut processing_track = (video_track.is_some(), audio_track.is_some());
            let mut start_timestamp = params.start_timestamp;
            let mut end_timestamp = params.end_timestamp;
            let mut video_keyframe_buffer = Vec::new();
            let mut audio_keyframe_buffer = Vec::new();

            // mux before from the last keyframe to the first frame
            fn mux_start(
                track: &mut Option<(u64, impl Track)>,
                keyframe_buffer: &mut Vec<Rc<Frame>>,
                frame: Rc<Frame>,
                track_id: u64,
                keyframe: bool,
            ) {
                if let Some((id, _)) = track {
                    if track_id == *id {
                        if keyframe {
                            keyframe_buffer.clear();
                        }

                        keyframe_buffer.push(frame);
                    }
                }
            }

            fn mux_middle(
                track: &mut Option<(u64, impl Track)>,
                keyframe_buffer: &mut Vec<Rc<Frame>>,
                frame: Rc<Frame>,
                track_id: u64,
                keyframe: bool,
                timescale: u64,
                start_timestamp: &mut u64,
                end_timestamp: &mut u64,
                processing_track: &mut bool,
            ) {
                if let Some((id, track_writer)) = track {
                    if track_id == *id {
                        keyframe_buffer.push(frame);

                        if keyframe {
                            if !keyframe_buffer.is_empty() {
                                for frame in keyframe_buffer.drain(..) {
                                    let timestamp = frame.timestamp * timescale;

                                    *start_timestamp = (*start_timestamp).min(timestamp);

                                    if timestamp > *end_timestamp {
                                        *end_timestamp = timestamp;
                                        *processing_track = false;
                                    }

                                    track_writer.add_frame(
                                        &frame.data,
                                        timestamp - *start_timestamp,
                                        frame.is_keyframe.unwrap_or(false),
                                    );
                                }
                            }

                            keyframe_buffer.clear();
                        }
                    }
                }
            }

            loop {
                let mut frame = Frame::default();
                let Ok(true) = file.next_frame(&mut frame) else {
                    break;
                };
                let frame = Rc::new(frame);

                if let (false, false) = processing_track {
                    break;
                }

                let timestamp = frame.timestamp * timescale;
                let keyframe = frame.is_keyframe.unwrap_or(false);
                let track_id = frame.track;

                if timestamp < start_timestamp {
                    mux_start(
                        &mut video_track,
                        &mut video_keyframe_buffer,
                        frame.clone(),
                        track_id,
                        keyframe,
                    );
                    mux_start(
                        &mut audio_track,
                        &mut audio_keyframe_buffer,
                        frame,
                        track_id,
                        keyframe,
                    );

                    continue;
                }

                mux_middle(
                    &mut video_track,
                    &mut video_keyframe_buffer,
                    frame.clone(),
                    track_id,
                    keyframe,
                    timescale,
                    &mut start_timestamp,
                    &mut end_timestamp,
                    &mut processing_track.0,
                );
                mux_middle(
                    &mut audio_track,
                    &mut audio_keyframe_buffer,
                    frame.clone(),
                    track_id,
                    keyframe,
                    timescale,
                    &mut start_timestamp,
                    &mut end_timestamp,
                    &mut processing_track.0,
                );
            }

            // mux after the last keyframe
            fn mux_end(
                track: &mut Option<(u64, impl Track)>,
                keyframe_buffer: &mut Vec<Rc<Frame>>,
                timescale: u64,
                start_timestamp: &mut u64,
                end_timestamp: &mut u64,
            ) {
                if let Some((_, track_writer)) = track {
                    if !keyframe_buffer.is_empty() {
                        for frame in keyframe_buffer.drain(..) {
                            let timestamp = frame.timestamp * timescale;

                            *start_timestamp = (*start_timestamp).min(timestamp);

                            if timestamp > *end_timestamp {
                                *end_timestamp = timestamp;
                                break;
                            }

                            track_writer.add_frame(
                                &frame.data,
                                timestamp - *start_timestamp,
                                frame.is_keyframe.unwrap_or(false),
                            );
                        }
                    }
                }
            }

            mux_end(
                &mut video_track,
                &mut video_keyframe_buffer,
                timescale,
                &mut start_timestamp,
                &mut end_timestamp,
            );
            mux_end(
                &mut audio_track,
                &mut audio_keyframe_buffer,
                timescale,
                &mut start_timestamp,
                &mut end_timestamp,
            );

            segment
                .try_finalize(Some((end_timestamp - start_timestamp) / timescale))
                .map_err(|_| ErrorInternalServerError("Unable to finalize the video stream"))?;

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
                    let mut frame = Frame::default();
                    let mut last_frame_timestamp = 0;

                    while let Ok(true) = file.next_frame(&mut frame) {
                        last_frame_timestamp =
                            last_frame_timestamp.max(frame.timestamp * timescale);
                    }

                    last_frame_timestamp = last_frame_timestamp.max(end_timestamp);

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
                        start_timestamp, end_timestamp, last_frame_timestamp
                    ),
                ))
                .respond_to(&request))
        }

        #[derive(Deserialize, Validate, Debug)]
        struct PostVideo {
            uuid: Uuid,
            #[validate(custom(function = "valid_resolution"))]
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
