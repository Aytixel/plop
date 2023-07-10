const thumbnail_element = document.getElementById("thumbnail")
const thumbnail_filepicker_element = document.getElementById("thumbnail_filepicker")

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

const encode_video = (url, width, height, framerate) => new Promise(resolve => {
    const canvas = document.createElement("canvas")
    const canvas_context = canvas.getContext("2d")

    canvas.width = width
    canvas.height = height

    const video = document.createElement("video")
    const update_canvas = () => {
        canvas_context.drawImage(video, 0, 0, width, height)
        video.requestVideoFrameCallback(update_canvas)
    }

    video.requestVideoFrameCallback(update_canvas)
    video.src = url
    video.onloadedmetadata = () => {
        const audio_track = video.captureStream().getAudioTracks()[0]
        const video_stream = canvas.captureStream(framerate)

        if (audio_track)
            video_stream.addTrack(audio_track)

        const recorder = new MediaRecorder(video_stream, {
            audioBitsPerSecond: 128000,
            videoBitsPerSecond: width * height * framerate * 0.3,
            mimeType: 'video/webm;codecs="vp8,opus"'
        })

        recorder.ondataavailable = e => resolve(URL.createObjectURL(e.data))
        video.onended = () => recorder.stop()
        video.onplay = () => recorder.start()
        video.play()
    }
})

const encode_multiple_video = (url, encode_options_list) => new Promise(resolve => {
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

    function update_canvas() {
        for (const canvas of canvas_list) {
            canvas.canvas_context.drawImage(video, 0, 0, canvas.canvas.width, canvas.canvas.height)
        }

        video.requestVideoFrameCallback(update_canvas)
    }

    video.requestVideoFrameCallback(update_canvas)
    video.src = url
    video.onloadedmetadata = () => {
        const audio_track = video.captureStream().getAudioTracks()[0]
        let encoded_video_count = 0

        for (const key in canvas_list) {
            const video_stream = canvas_list[key].canvas.captureStream(encode_options_list[key].framerate)

            if (audio_track)
                video_stream.addTrack(audio_track)

            const recorder = new MediaRecorder(video_stream, {
                audioBitsPerSecond: 128000,
                videoBitsPerSecond: encode_options_list[key].width * encode_options_list[key].height * encode_options_list[key].framerate * 0.3,
                mimeType: 'video/webm;codecs="vp8,opus"'
            })

            recorder.ondataavailable = e => {
                encode_options_list[key].url = URL.createObjectURL(e.data)

                if (++encoded_video_count == encode_options_list.length)
                    resolve(encode_options_list)
            }
            video.addEventListener("ended", () => recorder.stop())
            video.addEventListener("play", () => recorder.start())
        }

        video.play()
    }
})

video_element.addEventListener("volumechange", () => video_volume_slider_element.value = video_element.volume)
video_element.addEventListener("timeupdate", () => {
    video_timespan_element.textContent = duration_to_string(video_element.currentTime)

    video_duration_slider_element.value = video_element.currentTime
})
video_element.addEventListener("loadedmetadata", () => {
    const video_settings = video_element.captureStream().getVideoTracks()[0].getSettings()

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