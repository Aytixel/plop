use actix_web::HttpRequest;
use clerk_rs::{
    apis::{jwks_api::Jwks, sessions_api::Session},
    clerk::Clerk,
    models::session::Status,
    validators::actix::{validate_jwt, ClerkJwt},
};

pub mod channel;
pub mod video;

pub async fn get_authentication_data(request: &HttpRequest, clerk: &Clerk) -> Option<ClerkJwt> {
    let Some(access_token) = request.cookie("__session") else {
        return None;
    };
    let Ok(jwks) = Jwks::get_jwks(clerk).await else {
        return None;
    };
    let Ok((_, jwt)) = validate_jwt(access_token.value(), jwks) else {
        return None;
    };

    Session::get_session(clerk, &jwt.sid)
        .await
        .ok()
        .map(|session| (session.status == Status::Active).then_some(jwt))
        .flatten()
}

pub async fn get_gorse_user_id(request: &HttpRequest, jwt: &Option<ClerkJwt>) -> String {
    jwt.as_ref().map_or(
        request
            .connection_info()
            .peer_addr()
            .unwrap_or("global")
            .to_string(),
        |jwt| jwt.sub.clone(),
    )
}
