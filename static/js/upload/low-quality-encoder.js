const video_encode_interval = 2000
const encoding_bitrate_multiplier = 0.12

function encode_single_video(url, encode_options, callback) {
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
        video.addEventListener("loadedmetadata", () => {
            const audio_track = video.audioTracks[0]
            const video_stream = canvas.captureStream(encode_options.framerate)
            let mime_type = "video/webm;codecs=vp9"

            if (audio_track) {
                mime_type = "video/webm;codecs=\"vp9,opus\""

                video_stream.addTrack(audio_track)
            }

            const recorder = new MediaRecorder(video_stream, {
                audioBitsPerSecond: 128000,
                videoBitsPerSecond: encode_options.width * encode_options.height * encode_options.framerate * encoding_bitrate_multiplier,
                mimeType: mime_type
            })
            let size = 0
            let position = 0

            recorder.addEventListener("dataavailable", async e => {
                position += size
                size = e.data.size

                callback({ resolution: encode_options.resolution, data: await e.data.arrayBuffer(), position })

                if (recorder.state == "inactive")
                    setTimeout(() => callback({ resolution: encode_options.resolution }), 1000)
            })
            video.addEventListener("ended", () => {
                running = false

                recorder.stop()

                resolve()
            })
            video.addEventListener("play", () => recorder.start(video_encode_interval))
            video.play()
        })
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
        video.addEventListener("loadedmetadata", () => {
            const audio_track = video.audioTracks[0]
            let encoded_video_count = 0

            for (const key in canvas_list) {
                const video_stream = canvas_list[key].canvas.captureStream(encode_options_list[key].framerate)
                let mime_type = "video/webm;codecs=vp9"

                if (audio_track) {
                    mime_type = "video/webm;codecs=\"vp9,opus\""

                    video_stream.addTrack(audio_track)
                }

                const recorder = new MediaRecorder(video_stream, {
                    audioBitsPerSecond: 128000,
                    videoBitsPerSecond: encode_options_list[key].width * encode_options_list[key].height * encode_options_list[key].framerate * encoding_bitrate_multiplier,
                    mimeType: mime_type
                })
                let size = 0
                let position = 0

                recorder.addEventListener("dataavailable", async e => {
                    position += size
                    size = e.data.size

                    callback({ resolution: encode_options_list[key].resolution, data: await e.data.arrayBuffer(), position })

                    if (recorder.state == "inactive")
                        setTimeout(() => callback({ resolution: encode_options_list[key].resolution }), 1000)
                })
                video.addEventListener("ended", () => {
                    recorder.stop()

                    if (++encoded_video_count == encode_options_list.length)
                        resolve()
                })
                video.addEventListener("play", () => recorder.start(video_encode_interval))
            }

            video.play()
        })
    })
}

async function encode_video(url, encode_options_list, callback) {
    const low_encode_options_list = encode_options_list.filter(encode_options => encode_options.resolution <= 360)
    const high_encode_options_list = encode_options_list.filter(encode_options => encode_options.resolution > 360)

    if (low_encode_options_list.length)
        await encode_multiple_video(url, low_encode_options_list, callback)

    for (const encode_options of high_encode_options_list)
        await encode_single_video(url, encode_options, callback)
}

export default encode_video