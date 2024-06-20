use actix_web::error::ErrorInternalServerError;
use clerk_rs::{apis::users_api::User, clerk::Clerk};
use fred::{
    clients::RedisClient,
    interfaces::KeysInterface,
    types::{Expiration, RedisValue},
};
use serde::{Deserialize, Serialize};

pub const CHANNEL_INFO_REDIS_TIMEOUT: i64 = 3600 * 4;

#[derive(Serialize, Deserialize, Debug)]
pub struct ChannelInfo {
    pub username: String,
    pub profil_picture: String,
}

pub async fn get_channel_info(
    user_id: &str,
    clerk: &Clerk,
    redis_client: &RedisClient,
) -> actix_web::Result<ChannelInfo> {
    let key = format!("channel_info:{}", user_id);
    let value = redis_client
        .get::<String, _>(&key)
        .await
        .unwrap_or("nil".to_string());

    if value == "nil" {
        let user = User::get_user(clerk, user_id)
            .await
            .map_err(|_| ErrorInternalServerError("Unable to get channel info"))?;
        let channel_info = ChannelInfo {
            username: user.username.unwrap_or_default().unwrap_or_default(),
            profil_picture: user.image_url.unwrap_or_default(),
        };

        redis_client
            .set::<RedisValue, _, _>(
                &key,
                serde_json::to_string(&channel_info).unwrap(),
                Some(Expiration::EX(CHANNEL_INFO_REDIS_TIMEOUT)),
                None,
                false,
            )
            .await
            .ok();

        Ok(channel_info)
    } else {
        Ok(serde_json::from_str::<ChannelInfo>(&value).unwrap())
    }
}
