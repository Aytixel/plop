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
const video_bitrate_element = document.getElementById("video_bitrate")
const video_duration_element = document.getElementById("video_duration")
const video_timespan_element = document.getElementById("video_timespan")

let video_settings
let video_bitrate

function duration_to_string(duration) {
    const string = `${Math.floor(duration / 60 % 60)}:${(Math.round(duration) % 60).toString().padStart(2, 0)}`

    if (duration >= 3600)
        return Math.floor(duration / 3600) + ":" + string.padStart(5, 0)

    return string
}

video_element.addEventListener("volumechange", () => video_volume_slider_element.value = video_element.volume)
video_element.addEventListener("timeupdate", () => {
    video_timespan_element.textContent = duration_to_string(video_element.currentTime)

    video_duration_slider_element.value = video_element.currentTime
})
video_element.addEventListener("loadedmetadata", () => {
    video_settings = video_element.captureStream().getVideoTracks()[0].getSettings()
    video_bitrate = video_settings.width * video_settings.height * video_settings.frameRate * 0.000000113

    video_width_element.textContent = video_settings.width
    video_height_element.textContent = video_settings.height
    video_framerate_element.textContent = video_settings.frameRate
    video_bitrate_element.textContent = video_bitrate
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
    const move = () => video_element.pause()
    const up = () => {
        if (!paused)
            video_element.play()

        video_duration_slider_element.removeEventListener("pointermove", move)
        video_duration_slider_element.removeEventListener("pointerup", up)
    }

    video_element.pause()
    video_duration_slider_element.addEventListener("pointermove", move)
    video_duration_slider_element.addEventListener("pointerup", up)
})