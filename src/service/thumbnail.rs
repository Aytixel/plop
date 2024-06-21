use ::uuid::Uuid;
use actix_files::NamedFile;
use actix_web::{error::ErrorInternalServerError, get, HttpRequest, Responder};
use actix_web_validator5::Path;
use serde::Deserialize;
use validator::Validate;

pub mod uuid {
    use super::*;

    #[derive(Deserialize, Validate, Debug)]
    struct GetThumbnail {
        uuid: Uuid,
    }

    #[get("/thumbnail/{uuid}")]
    async fn get(
        request: HttpRequest,
        params: Path<GetThumbnail>,
    ) -> actix_web::Result<impl Responder> {
        Ok(NamedFile::open(format!("./thumbnail/{}.webp", params.uuid))
            .map(|file| file.use_etag(false).use_last_modified(false))
            .map_err(|_| ErrorInternalServerError("Unable to open the file"))?
            .into_response(&request)
            .customize()
            .insert_header(("Cache-Control", "max-age=31536000")))
    }
}
