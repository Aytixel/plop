const time_ago = (async () => {
    TimeAgo.addDefaultLocale(await (await fetch("https://unpkg.com/javascript-time-ago@2.5/locale/fr.json")).json())

    return new TimeAgo('fr')
})()

// video player
{
    document.getElementById("video_player_controls").querySelectorAll("input[type='range']").forEach(element => {
        function update() {
            element.style = "--range-position: " + (element.value / element.max * 100) + "%;"
        }

        function down() {
            element.addEventListener("pointermove", move)
            element.addEventListener("pointerup", up)
            element.addEventListener("pointerout", up)
        }

        function move(e) {
            const rect = element.getBoundingClientRect()

            element.value = Math.max(0, Math.min(element.max, (e.clientX - rect.x) / (rect.width - rect.x) * element.max))
        }

        function up() {
            element.removeEventListener("pointermove", move)
            element.removeEventListener("pointerup", up)
            element.removeEventListener("pointerout", up)
        }

        element.addEventListener("input", update)
        element.addEventListener("update", update)
        element.addEventListener("pointerdown", down)
        update()
    })

    function duration_to_string(duration) {
        const string = `${Math.floor(duration / 60 % 60)}:${(Math.round(duration) % 60).toString().padStart(2, 0)}`

        if (duration >= 3600)
            return Math.floor(duration / 3600) + ":" + string.padStart(5, 0)

        return string
    }

    const video_player = document.getElementById("video_player")
    const video = video_player.firstElementChild
    const play_button_element = document.getElementById("video_player_play_button")
    const mute_button_element = document.getElementById("video_player_mute_button")
    const popup_button_element = document.getElementById("video_player_popup_button")
    const fullscreen_button_element = document.getElementById("video_player_fullscreen_button")

    function fullscreen() {
        if (document.fullscreenElement == null)
            video_player.requestFullscreen()
        else
            document.exitFullscreen()
    }

    play_button_element.addEventListener("click", () => video.paused ? video.play() : video.pause())
    mute_button_element.addEventListener("click", () => video.muted = !video.muted)
    popup_button_element.addEventListener("click", () => !video.disablePictureInPicture && video.requestPictureInPicture())
    fullscreen_button_element.addEventListener("click", fullscreen)
    video_player.addEventListener("dblclick", fullscreen)

    const duration_slider_element = document.getElementById("video_player_duration_slider")
    const volume_slider_element = document.getElementById("video_player_volume_slider")
    const timespan_element = document.getElementById("video_player_timespan")
    const duration_element = document.getElementById("video_player_duration")

    duration_element.textContent = duration_to_string(duration_slider_element.max)

    duration_slider_element.addEventListener("input", () => timespan_element.textContent = duration_to_string(video.currentTime = duration_slider_element.value))
    volume_slider_element.addEventListener("input", () => video.volume = volume_slider_element.value)

    video.addEventListener("durationchange", () => isFinite(video.duration) && (duration_element.textContent = duration_to_string(duration_slider_element.max = video.duration)))
    video.addEventListener("timeupdate", () => {
        timespan_element.textContent = duration_to_string(duration_slider_element.value = video.currentTime)
        duration_slider_element.dispatchEvent(new Event("update"))
    })
    video.addEventListener("volumechange", () => {
        volume_slider_element.value = video.volume
        volume_slider_element.dispatchEvent(new Event("update"))
    })
}

// video description
{
    const vues_element = document.getElementById("vues")

    if (video_metadata.vues >= 0 && video_metadata.vues < 1000)
        vues_element.textContent = video_metadata.vues + (video_metadata.vues > 1 ? " vues" : " vue")
    else if (video_metadata.vues < 1000000)
        vues_element.textContent = (Math.round(video_metadata.vues / 100) / 10) + " k"
    else if (video_metadata.vues < 1000000000)
        vues_element.textContent = (Math.round(video_metadata.vues / 100000) / 10) + " M de vues"
    else
        vues_element.textContent = (Math.round(video_metadata.vues / 100000000) / 10) + " Md de vues"

    const time_element = document.getElementById("time")

    time_ago.then(time_ago => time_element.textContent = time_ago.format(video_metadata.date.valueOf()))
}