use std::{
    collections::{HashMap, HashSet},
    str::FromStr,
    time::{Duration, SystemTime},
};

use actix_web::{
    error::ErrorInternalServerError, get, web::Data, HttpRequest, HttpResponse, Responder,
};
use chrono::{DateTime, Utc};
use futures::future::{join, join_all};
use gorse_rs::{Feedback, User};
use sea_orm::{ColumnTrait, Condition, EntityTrait, QueryFilter};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    entity::video,
    util::{channel::get_channel_info, get_authentication_data, get_gorse_user_id},
    AppState,
};

#[get("/")]
async fn get(request: HttpRequest, data: Data<AppState<'_>>) -> actix_web::Result<impl Responder> {
    let jwt = get_authentication_data(&request, &data.clerk).await;
    let user_id = get_gorse_user_id(&request, &jwt).await;

    if data.gorse_client.get_user(&user_id).await.is_err() {
        data.gorse_client
            .insert_user(&User {
                user_id: user_id.clone(),
                labels: Vec::new(),
            })
            .await
            .map_err(|_| ErrorInternalServerError("Unable to add the new user"))?;
    }

    let recommendation = data
        .gorse_client
        .get_recommend(&user_id)
        .await
        .unwrap_or_default();
    let recommendation_timestamp =
        (DateTime::<Utc>::from(SystemTime::now()) + Duration::new(3600, 0)).to_rfc3339();
    let conditions = recommendation
        .iter()
        .fold(Condition::any(), |condition, item_id| {
            condition.add(video::Column::Uuid.eq(Uuid::from_str(&item_id).unwrap()))
        });

    let (_, video_model) = join(
        data.gorse_client.insert_feedback(
            &recommendation
                .iter()
                .map(|item_id| Feedback {
                    feedback_type: "display".to_string(),
                    user_id: user_id.clone(),
                    item_id: item_id.clone(),
                    timestamp: recommendation_timestamp.clone(),
                })
                .collect::<Vec<Feedback>>(),
        ),
        video::Entity::find()
            .filter(conditions)
            .all(&data.db_connection),
    )
    .await;

    let videos_model =
        video_model.map_err(|_| ErrorInternalServerError("Unable to find a videos"))?;
    let user_ids: HashSet<String> = videos_model
        .iter()
        .map(|video| video.user_id.clone())
        .collect();
    let mut channels_info = HashMap::new();

    for channel_info in join_all(
        user_ids
            .iter()
            .map(|user_id| get_channel_info(&user_id, &data.clerk, &data.redis_client)),
    )
    .await
    {
        let channel_info = channel_info?;

        channels_info.insert(channel_info.user_id.clone(), channel_info);
    }

    let videos: Vec<Value> = videos_model
        .iter()
        .map(|video| {
            json!({
                "uuid": video.uuid,
                "title": video.title,
                "views": video.views,
                "timestamp": video.timestamp.format("%Y-%m-%dT%H:%M:%S%.fZ").to_string(),
                "duration": video.duration,
                "channel_info": channels_info[&video.user_id],
            })
        })
        .collect();

    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .insert_header(("Content-type", "text/html; charset=utf-8"))
        .body(
            data.handlebars
                .render(
                    "index",
                    &json!({
                        "videos": videos
                    }),
                )
                .unwrap(),
        ))
}
