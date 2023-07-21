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

function encode_thumbnail(url) {
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
            canvas.toBlob(blob => resolve(blob), "image/webp", 0.75)
        }
    })
}

thumbnail_filepicker_element.addEventListener("input", () => {
    if (thumbnail_filepicker_element.files.length > 0)
        thumbnail_element.src = URL.createObjectURL(thumbnail_filepicker_element.files[0])
})

const video_element = document.getElementById("video")
const video_filepicker_element = document.getElementById("video_filepicker")
const video_play_button_element = document.getElementById("video_play_button")
const video_volume_slider_element = document.getElementById("video_volume_slider")
const video_duration_slider_element = document.getElementById("video_duration_slider")

const video_width_element = document.getElementById("video_width")
const video_height_element = document.getElementById("video_height")
const video_framerate_element = document.getElementById("video_framerate")
const video_duration_element = document.getElementById("video_duration")
const video_timespan_element = document.getElementById("video_timespan")

function duration_to_string(duration) {
    const string = `${Math.floor(duration / 60 % 60)}:${(Math.round(duration) % 60).toString().padStart(2, 0)}`

    if (duration >= 3600)
        return Math.floor(duration / 3600) + ":" + string.padStart(5, 0)

    return string
}

const video_encode_interval = 2000

function get_video_encode_options_list(width, height, framerate) {
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

const encoding_bitrate_multiplier = 0.3

function encode_video(url, encode_options, callback) {
    return new Promise(resolve => {
        const canvas = document.createElement("canvas")
        const canvas_context = canvas.getContext("2d")

        canvas.width = encode_options.width
        canvas.height = encode_options.height

        const video = document.createElement("video")
        let running = true

        function update_canvas() {
            if (running) {
                canvas_context.drawImage(video, 0, 0, encode_options.width, encode_options.height)
                requestAnimationFrame(update_canvas)
            }
        }

        requestAnimationFrame(update_canvas)

        video.src = url
        video.onloadedmetadata = () => {
            const audio_track = video.audioTracks[0]
            const video_stream = canvas.captureStream(encode_options.framerate)
            let mimeType = "video/webm;codecs=vp8"

            if (audio_track) {
                audio_track = "video/webm;codecs=\"vp8,opus\""

                video_stream.addTrack(audio_track)
            }

            const recorder = new MediaRecorder(video_stream, {
                audioBitsPerSecond: 128000,
                videoBitsPerSecond: encode_options.width * encode_options.height * encode_options.framerate * encoding_bitrate_multiplier,
                mimeType
            })
            const interval_id = setInterval(() => recorder.requestData(), video_encode_interval)
            let size = 0
            let starting_byte = 0

            recorder.ondataavailable = e => {
                starting_byte += size
                size = e.data.size

                callback({ resolution: encode_options.resolution, data: e.data, starting_byte })

                if (recorder.state == "inactive")
                    setTimeout(() => callback({ resolution: encode_options.resolution }), 1000)
            }
            video.onended = () => {
                running = false

                recorder.stop()

                clearInterval(interval_id)
                resolve()
            }
            video.onplay = () => recorder.start()
            video.play()
        }
    })
}

function encode_multiple_video(url, encode_options_list, callback) {
    return new Promise(resolve => {
        const canvas_list = encode_options_list.map(encode_options => {
            const canvas = document.createElement("canvas")

            canvas.width = encode_options.width
            canvas.height = encode_options.height

            return {
                canvas,
                canvas_context: canvas.getContext("2d")
            }
        })
        const video = document.createElement("video")
        let running = true

        function update_canvas() {
            if (running) {
                for (const canvas of canvas_list) {
                    canvas.canvas_context.drawImage(video, 0, 0, canvas.canvas.width, canvas.canvas.height)
                }

                requestAnimationFrame(update_canvas)
            }
        }

        requestAnimationFrame(update_canvas)

        video.src = url
        video.addEventListener("ended", () => running = false)
        video.onloadedmetadata = () => {
            const audio_track = video.audioTracks[0]
            let encoded_video_count = 0

            for (const key in canvas_list) {
                const video_stream = canvas_list[key].canvas.captureStream(encode_options_list[key].framerate)
                let mimeType = "video/webm;codecs=vp8"

                if (audio_track) {
                    audio_track = "video/webm;codecs=\"vp8,opus\""

                    video_stream.addTrack(audio_track)
                }

                const recorder = new MediaRecorder(video_stream, {
                    audioBitsPerSecond: 128000,
                    videoBitsPerSecond: encode_options_list[key].width * encode_options_list[key].height * encode_options_list[key].framerate * encoding_bitrate_multiplier,
                    mimeType
                })
                const interval_id = setInterval(() => recorder.requestData(), video_encode_interval)
                let size = 0
                let starting_byte = 0

                recorder.ondataavailable = e => {
                    starting_byte += size
                    size = e.data.size

                    callback({ resolution: encode_options_list[key].resolution, data: e.data, starting_byte })

                    if (recorder.state == "inactive")
                        setTimeout(() => callback({ resolution: encode_options_list[key].resolution }), 1000)
                }
                video.addEventListener("ended", () => {
                    recorder.stop()

                    clearInterval(interval_id)

                    if (++encoded_video_count == encode_options_list.length)
                        resolve()
                })
                video.addEventListener("play", () => recorder.start())
            }

            video.play()
        }
    })
}

let video_settings

video_element.addEventListener("volumechange", () => video_volume_slider_element.value = video_element.volume)
video_element.addEventListener("timeupdate", () => {
    video_timespan_element.textContent = duration_to_string(video_element.currentTime)

    video_duration_slider_element.value = video_element.currentTime
})
video_element.addEventListener("loadedmetadata", () => {
    video_settings = video_element.videoTracks[0].getSettings()
    video_settings.width ??= video_element.videoWidth
    video_settings.height ??= video_element.videoHeight
    video_settings.frameRate ??= 30

    video_width_element.textContent = video_settings.width
    video_height_element.textContent = video_settings.height
    video_framerate_element.textContent = video_settings.frameRate
    video_duration_element.textContent = duration_to_string(video_element.duration)

    video_duration_slider_element.max = video_element.duration
})

video_filepicker_element.addEventListener("input", () => {
    if (video_filepicker_element.files.length > 0)
        video_element.src = URL.createObjectURL(video_filepicker_element.files[0])
})

video_play_button_element.addEventListener("click", () => video_element.paused ? video_element.play() : video_element.pause())

video_volume_slider_element.value = video_element.volume
video_volume_slider_element.addEventListener("input", () => video_element.volume = video_volume_slider_element.value)

video_duration_slider_element.addEventListener("input", () => video_element.currentTime = video_duration_slider_element.value)
video_duration_slider_element.addEventListener("pointerdown", () => {
    const paused = video_element.paused

    function move() {
        video_element.pause()
    }
    function up() {
        if (!paused)
            video_element.play()

        video_duration_slider_element.removeEventListener("pointermove", move)
        video_duration_slider_element.removeEventListener("pointerup", up)
    }

    video_element.pause()
    video_duration_slider_element.addEventListener("pointermove", move)
    video_duration_slider_element.addEventListener("pointerup", up)
})

const video_upload_form_element = document.getElementById("video_upload_form")
let uploading_video = false

video_upload_form_element.addEventListener("submit", async e => {
    e.preventDefault()

    if (uploading_video)
        return;

    uploading_video = true

    const video_encode_options_list = get_video_encode_options_list(video_settings.width, video_settings.height, video_settings.frameRate)
    const form_data = new FormData(video_upload_form_element)
    const params = {
        title: form_data.get("title"),
        framerate: video_settings.frameRate,
        duration: video_element.duration,
        resolutions: video_encode_options_list.map(video_encode_options => video_encode_options.resolution)
    };

    if (form_data.get("description").length)
        params.description = form_data.get("description")

    if (form_data.get("tags").length)
        params.tags = form_data.get("tags")

    const video_uuid = await (await fetch("/video", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(params) })).text()
    const low_video_encode_options_list = video_encode_options_list.filter(video_encode_options => video_encode_options.resolution <= 360)
    const high_video_encode_options_list = video_encode_options_list.filter(video_encode_options => video_encode_options.resolution > 360)
    const worker = [new Worker("/js/upload-worker.js"), new Worker("/js/upload-worker.js")]

    async function upload_video_chunk(chunk) {
        chunk.video_uuid = video_uuid

        if (chunk.data) {
            chunk.data = await chunk.data.arrayBuffer()
            worker[0].postMessage(chunk, [chunk.data])
        } else {
            worker[0].postMessage(chunk)
        }

        worker.reverse()
    }

    if (low_video_encode_options_list.length)
        await encode_multiple_video(video_element.src, low_video_encode_options_list, upload_video_chunk)

    for (const video_encode_options of high_video_encode_options_list)
        await encode_video(video_element.src, video_encode_options, upload_video_chunk)

    console.log("Upload finished : " + video_uuid)
})