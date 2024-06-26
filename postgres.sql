CREATE DATABASE gorse;

CREATE TYPE video_upload_state AS ENUM ('unavailable', 'available', 'uploading');

CREATE TABLE video (
    uuid uuid NOT NULL PRIMARY KEY,
    user_id varchar(32) NOT NULL,
    title varchar(100) NOT NULL,
    description varchar(5000),
    tags varchar(500),
    timestamp timestamp(6) NOT NULL DEFAULT now(),
    views bigint NOT NULL DEFAULT 0,
    likes bigint NOT NULL DEFAULT 0,
    duration double precision NOT NULL,
    framerate smallint NOT NULL,
    has_audio bool NOT NULL,
    state_144p video_upload_state NOT NULL,
    state_240p video_upload_state NOT NULL,
    state_360p video_upload_state NOT NULL,
    state_480p video_upload_state NOT NULL,
    state_720p video_upload_state NOT NULL,
    state_1080p video_upload_state NOT NULL,
    state_1440p video_upload_state NOT NULL
);

CREATE TABLE "like" (
    uuid uuid NOT NULL,
    user_id varchar(32) NOT NULL,
    PRIMARY KEY (uuid, user_id)
);

CREATE OR REPLACE FUNCTION add_like_trigger() RETURNS TRIGGER AS $$
DECLARE
BEGIN
    UPDATE video SET likes = likes + 1 WHERE uuid = NEW.uuid;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION remove_like_trigger() RETURNS TRIGGER AS $$
DECLARE
BEGIN
    UPDATE video SET likes = likes - 1 WHERE uuid = OLD.uuid;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER add_like AFTER INSERT ON "like" FOR EACH ROW EXECUTE FUNCTION add_like_trigger();
CREATE TRIGGER remove_like AFTER DELETE ON "like" FOR EACH ROW EXECUTE FUNCTION remove_like_trigger();