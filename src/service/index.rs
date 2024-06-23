use std::{
    str::FromStr,
    time::{Duration, SystemTime},
};

use actix_web::{
    error::ErrorInternalServerError, get, web::Data, HttpRequest, HttpResponse, Responder,
};
use chrono::{DateTime, Utc};
use gorse_rs::{Feedback, User};
use sea_orm::{ColumnTrait, Condition, EntityTrait, QueryFilter};
use serde_json::json;
use uuid::Uuid;

use crate::{
    entity::video,
    util::{channel::get_channel_info, get_gorse_user_id},
    AppState,
};

#[get("/")]
async fn get(req: HttpRequest, data: Data<AppState<'_>>) -> actix_web::Result<impl Responder> {
    let user_id = get_gorse_user_id(&req, &data.clerk).await;

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

    data.gorse_client
        .insert_feedback(
            &recommendation
                .iter()
                .map(|item_id| Feedback {
                    feedback_type: "display".to_string(),
                    user_id: user_id.clone(),
                    item_id: item_id.clone(),
                    timestamp: recommendation_timestamp.clone(),
                })
                .collect::<Vec<Feedback>>(),
        )
        .await
        .ok();

    let mut conditions = Condition::any();

    for item_id in recommendation {
        conditions = conditions.add(video::Column::Uuid.eq(Uuid::from_str(&item_id).unwrap()));
    }

    let mut videos = Vec::new();

    for video in video::Entity::find()
        .filter(conditions)
        .all(&data.db_connection)
        .await
        .map_err(|_| ErrorInternalServerError("Unable to find a videos"))?
    {
        videos.push(json!({
            "uuid": video.uuid,
            "title": video.title,
            "vues": video.vues,
            "timestamp": video.timestamp.format("%Y-%m-%dT%H:%M:%S%.fZ").to_string(),
            "duration": video.duration,
            "channel_info": get_channel_info(
                &video.user_id,
                &data.clerk,
                &data.redis_client,
            )
            .await?,
        }))
    }

    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
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
