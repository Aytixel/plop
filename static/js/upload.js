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

function encode_audio(url, audio_config, callback) {
    return new Promise((resolve, reject) => {
        const video = document.createElement("video")

        video.src = url
        video.addEventListener("loadedmetadata", async () => {
            const audio_encoder = new AudioEncoder({
                output: callback,
                error: reject,
            })

            audio_config = Object.assign(audio_config, {
                codec: "opus",
                bitrate: 128000
            })

            console.log(audio_config)

            audio_encoder.configure(audio_config)

            const audio_processor = new MediaStreamTrackProcessor(video.audioTracks[0])
            const audio_reader = audio_processor.readable.getReader()

            video.play()

            while (true) {
                const result = await audio_reader.read()

                if (result.done)
                    break

                const audio_data = result.value

                audio_encoder.encode(audio_data)
                audio_data.close()
            }

            audio_encoder.close()

            resolve()
        })
    })
}

const encoding_bitrate_multiplier = 0.12

function encode_video(url, encode_options_list, callback) {
    return new Promise((resolve, reject) => {
        console.log(encode_options_list)

        const video = document.createElement("video")

        video.src = url
        video.addEventListener("loadedmetadata", async () => {
            let audio_config

            // setup audio encoder
            if (video.audioTracks.length) {
                const audio_processor = new MediaStreamTrackProcessor(video.audioTracks[0])
                const audio_reader = audio_processor.readable.getReader()

                video.play()

                const audio_data = (await audio_reader.read()).value

                video.pause()

                video.currentTime = 0
                audio_config = {
                    numberOfChannels: audio_data.numberOfChannels,
                    sampleRate: audio_data.sampleRate
                }
            }

            // setup video encoder and the muxer
            for (const key in encode_options_list) {
                const muxer_config = {
                    target: new WebMMuxer.StreamTarget(
                        (data, position) => {
                            callback({
                                resolution: encode_options_list[key].resolution,
                                position,
                                data: data.buffer.slice(0, data.byteLength)
                            })
                        },
                        () => {
                            setTimeout(() => callback({ resolution: encode_options_list[key].resolution }), 100)
                            console.log(`${encode_options_list[key].resolution}p encoding finished`)
                        },
                        {
                            chunked: true,
                            chunkSize: 1_500_000
                        }
                    ),
                    video: {
                        codec: "V_VP9",
                        width: encode_options_list[key].width,
                        height: encode_options_list[key].height,
                        frameRate: encode_options_list[key].framerate,
                        alpha: false
                    },
                    streaming: true,
                    type: "webm"
                }

                if (video.audioTracks.length)
                    muxer_config.audio = Object.assign({ ...audio_config }, {
                        codec: "A_OPUS"
                    })

                const muxer = new WebMMuxer.Muxer(muxer_config)
                const video_encoder = new VideoEncoder({
                    output: (chunk, metadata) => muxer.addVideoChunk(chunk, metadata),
                    error: reject,
                })
                const video_encoder_config = {
                    codec: "vp09.02.10.10.01",
                    width: encode_options_list[key].width,
                    height: encode_options_list[key].height,
                    bitrate: encode_options_list[key].width * encode_options_list[key].height * encode_options_list[key].framerate * encoding_bitrate_multiplier,
                    framerate: encode_options_list[key].framerate
                }
                let video_encoder_configured = false

                async function test_video_encoder_config(hardware_acceleration) {
                    video_encoder_config.hardwareAcceleration = hardware_acceleration

                    if (!video_encoder_configured && (await VideoEncoder.isConfigSupported(video_encoder_config)).supported) {
                        video_encoder_configured = true
                        video_encoder.configure(video_encoder_config)
                    }
                }

                await test_video_encoder_config("prefer-hardware")
                await test_video_encoder_config("prefer-software")

                if (!video_encoder_configured) {
                    reject("No configuration found")

                    return
                }

                encode_options_list[key].muxer = muxer
                encode_options_list[key].video_encoder = video_encoder
                encode_options_list[key].timestamp = 0
            }

            let audio_encoder

            // start audio encoding
            if (video.audioTracks.length) {
                let start_timestamp = -1

                audio_encoder = encode_audio(url, audio_config, (chunk, metadata) => {
                    if (start_timestamp == -1)
                        start_timestamp = chunk.timestamp

                    for (encode_options of encode_options_list) {
                        encode_options.muxer.addAudioChunk(chunk, metadata, chunk.timestamp - start_timestamp)
                    }
                })
            }

            // start video encoding
            let frame_count = 0
            const duration = Math.round(video.duration * 1_000_000)
            const high_encode_options = encode_options_list[encode_options_list.length - 1]

            async function encode_frame() {
                console.log(`Time : ${video.currentTime}s`)

                frame_count++

                const video_frame = new VideoFrame(video, {
                    timestamp: high_encode_options.timestamp,
                    duration
                })

                for (const encode_options of encode_options_list) {
                    if (
                        high_encode_options.framerate == encode_options.framerate
                        || (video.currentTime * 1_000_000) >= encode_options.timestamp
                    ) {
                        encode_options.timestamp = Math.min(encode_options.timestamp + Math.round(1_000_000 / encode_options.framerate), duration)

                        encode_options.video_encoder.encode(video_frame, {
                            keyFrame: frame_count % (encode_options.framerate * 4) == 0
                        })
                    }
                }

                video_frame.close()

                if (high_encode_options.video_encoder.encodeQueueSize > 4)
                    await high_encode_options.video_encoder.flush()

                if (video.currentTime != video.duration) {
                    video.currentTime = high_encode_options.timestamp / 1_000_000

                    return
                }

                // ending frame
                for (const encode_options of encode_options_list) {
                    if (encode_options.video_encoder.state != "closed")
                        encode_options.video_encoder.close()

                    encode_options.muxer.finalize()
                }

                await audio_encoder

                console.timeEnd("Encode time")
                console.log(`Frame count : ${frame_count}`)
                video.removeEventListener("timeupdate", encode_frame)

                resolve()
            }

            video.addEventListener("timeupdate", encode_frame)

            console.time("Encode time")

            video.currentTime = 0
        })
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
    const worker = [new Worker("/js/upload-worker.js"), new Worker("/js/upload-worker.js")]

    async function upload_video_chunk(chunk) {
        chunk.video_uuid = video_uuid

        if (chunk.data)
            worker[0].postMessage(chunk, [chunk.data])
        else
            worker[0].postMessage(chunk)

        worker.reverse()
    }

    await encode_video(video_element.src, video_encode_options_list, upload_video_chunk)

    console.log("Upload finished : " + video_uuid)
})