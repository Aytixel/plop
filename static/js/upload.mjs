import { VideoPlayer } from "./player.mjs"

if ("mozCaptureStream" in HTMLMediaElement.prototype)
    HTMLMediaElement.prototype.captureStream = HTMLMediaElement.prototype.mozCaptureStream

if ("captureStream" in HTMLMediaElement.prototype) {
    Object.defineProperties(HTMLMediaElement.prototype, {
        audioTracks: {
            get: function () {
                return this.captureStream().getAudioTracks()
            },
            enumerable: true
        },
        videoTracks: {
            get: function () {
                return this.captureStream().getVideoTracks()
            },
            enumerable: true
        }
    });
}

const thumbnail_element = document.getElementById("thumbnail")
const thumbnail_filepicker_element = document.getElementById("thumbnail_filepicker")

function encodeThumbnail(url) {
    return new Promise(resolve => {
        const canvas = document.createElement("canvas")
        const canvas_context = canvas.getContext("2d")
        const image = document.createElement("img")

        image.src = url
        image.onload = () => {
            const aspect_ratio = image.naturalWidth / image.naturalHeight
            let width
            let height

            if (aspect_ratio > 1) {
                width = Math.round(480 * aspect_ratio)
                height = 480
            } else {
                width = 480
                height = Math.round(480 / aspect_ratio)
            }

            canvas.width = width
            canvas.height = height
            canvas_context.drawImage(image, 0, 0, width, height)

            resolve(canvas.toDataURL("image/webp", 0.85))
        }
    })
}

thumbnail_filepicker_element.addEventListener("input", () => {
    if (thumbnail_filepicker_element.files.length > 0)
        thumbnail_element.src = URL.createObjectURL(thumbnail_filepicker_element.files[0])
})

const video_element = new VideoPlayer({ ambient_light: false })
const video_filepicker_element = document.getElementById("video_filepicker")

const video_width_element = document.getElementById("video_width")
const video_height_element = document.getElementById("video_height")
const video_framerate_element = document.getElementById("video_framerate")

let video_settings

video_element.addEventListener("loadedmetadata", () => {
    video_settings = video_element.videoTracks[0].getSettings()
    video_settings.width ??= video_element.videoWidth
    video_settings.height ??= video_element.videoHeight
    video_settings.frameRate ??= 30

    video_width_element.textContent = video_settings.width
    video_height_element.textContent = video_settings.height
    video_framerate_element.textContent = video_settings.frameRate
})

video_filepicker_element.addEventListener("input", () => {
    if (video_filepicker_element.files.length > 0)
        video_element.src = URL.createObjectURL(video_filepicker_element.files[0])
})

const encoder_selection_element = document.getElementById("encoder_selection")

if ("AudioEncoder" in window) {
    encoder_selection_element.children[0].selected = false
    encoder_selection_element.children[1].disabled = false
    encoder_selection_element.children[1].selected = true
}

const video_upload_form_element = document.getElementById("video_upload_form")
let uploading_video = false

function getVideoEncodeOptionsList(width, height, framerate) {
    const aspect_ratio = width / height

    return [
        { resolution: 144, framerate: 24 },
        { resolution: 240, framerate: 24 },
        { resolution: 360, framerate: 30 },
        { resolution: 480, framerate: 30 },
        { resolution: 720, framerate: 60 },
        { resolution: 1080, framerate: 60 },
        { resolution: 1440, framerate: 60 },
    ].map(encode_options => {
        if (framerate < encode_options.framerate)
            encode_options.framerate = framerate

        if (aspect_ratio > 1) {
            encode_options.width = Math.round(encode_options.resolution * aspect_ratio)
            encode_options.height = encode_options.resolution
        } else {
            encode_options.width = encode_options.resolution
            encode_options.height = Math.round(encode_options.resolution / aspect_ratio)
        }

        return encode_options
    }).filter((encode_options, index) => index == 0 || encode_options.width <= width)
}

video_upload_form_element.addEventListener("submit", async e => {
    e.preventDefault()

    if (uploading_video)
        return;

    uploading_video = true

    const video_encode_options_list = getVideoEncodeOptionsList(video_settings.width, video_settings.height, video_settings.frameRate)
    const form_data = new FormData(video_upload_form_element)
    const params = {
        title: form_data.get("title"),
        framerate: video_settings.frameRate,
        duration: video_element.duration,
        resolutions: video_encode_options_list.map(video_encode_options => video_encode_options.resolution),
        thumbnail: await encodeThumbnail(thumbnail_element.src),
    };

    if (form_data.get("description").length)
        params.description = form_data.get("description")

    if (form_data.get("tags").length)
        params.tags = form_data.get("tags")

    const video_uuid = await (await fetch("/upload", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(params) })).text()
    const worker = [new Worker("/js/upload-worker.js"), new Worker("/js/upload-worker.js")]

    async function uploadVideoChunk(chunk) {
        chunk.video_uuid = video_uuid

        if (chunk.data)
            worker[0].postMessage(chunk, [chunk.data])
        else
            worker[0].postMessage(chunk)

        worker.reverse()
    }

    let encode_video

    switch (encoder_selection_element.value) {
        case "high":
            encode_video = (await import("/js/upload/high-quality-encoder.mjs")).default
            break
        default:
            encode_video = (await import("/js/upload/low-quality-encoder.mjs")).default
            break
    }

    await encode_video(video_element.src, video_encode_options_list, uploadVideoChunk)

    console.log("Upload finished : " + video_uuid)
})