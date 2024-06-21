use actix_web::{error::ErrorInternalServerError, get, web::Data, HttpResponse, Responder};
use actix_web_validator5::Query;
use serde::Deserialize;
use serde_json::{json, Value};
use validator::Validate;

use crate::{util::channel::get_channel_info, AppState, MeilliDocument};

#[derive(Deserialize, Validate, Debug)]
struct GetResults {
    q: String,
    l: Option<usize>,
}

#[get("/results")]
async fn get(
    query: Query<GetResults>,
    data: Data<AppState<'_>>,
) -> actix_web::Result<impl Responder> {
    let results = data
        .video_index
        .search()
        .with_query(&query.q)
        .with_limit(query.l.unwrap_or(20))
        .with_attributes_to_search_on(&["title", "tags", "description"])
        .execute::<MeilliDocument>()
        .await
        .map_err(|_| ErrorInternalServerError("Unable to search the query"))?;
    let mut results = results
        .hits
        .iter()
        .map(|result| serde_json::to_value(&result.result).unwrap())
        .collect::<Vec<Value>>();

    for result in results.iter_mut() {
        let result_object = result.as_object_mut().unwrap();

        result_object.insert(
            "channel_info".to_string(),
            serde_json::to_value(
                &get_channel_info(
                    result_object["user_id"].as_str().unwrap(),
                    &data.clerk,
                    &data.redis_client,
                )
                .await?,
            )
            .unwrap(),
        );
    }

    Ok(HttpResponse::Ok()
        .insert_header(("Cache-Control", "no-store"))
        .body(
            data.handlebars
                .render(
                    "results",
                    &json!({
                        "search": query.q,
                        "results": results,
                    }),
                )
                .unwrap(),
        ))
}
