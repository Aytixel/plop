let battery_high = true

if (navigator.getBattery) navigator.getBattery().then((battery) => {
    function update() {
        battery_high = battery.charging || battery.level > .25
    }

    battery.addEventListener("chargingchange", update)
    battery.addEventListener("levelchange", update)
})

function debounce(callback, delay) {
    let timer

    return function () {
        const args = arguments
        const context = this

        clearTimeout(timer)

        timer = setTimeout(() => callback.apply(context, args), delay)
    }
}

const url_search_params = new URLSearchParams(location.search)

// video player
{
    document.getElementById("video_player_controls").querySelectorAll("input[type='range']").forEach(element => {
        function update() {
            requestAnimationFrame(() => element.style.setProperty("--range-position", element.value / element.max * 100 + "%"))
        }

        function down() {
            element.addEventListener("pointermove", move)
            element.addEventListener("pointerup", up)
            element.addEventListener("pointerout", up)
        }

        function move(e) {
            const rect = element.getBoundingClientRect()

            element.value = (e.clientX - rect.x) / (rect.width - rect.x) * element.max
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
    const canvas = video_player.children[0]
    const context = canvas.getContext("2d")
    const compute_canvas = canvas.cloneNode()
    const compute_context = compute_canvas.getContext("2d")
    const video = video_player.children[1]
    const start_time = parseFloat(url_search_params.get("t"))

    if (start_time >= 0 && start_time <= video_metadata.duration)
        video.currentTime = start_time
    else
        video.currentTime = parseFloat(localStorage.getItem(`video-progress:${video_metadata.uuid}`, video.currentTime)) || 0

    context.globalAlpha = .05

    function update_canvas() {
        if (video_player.dataset.ambient_light == "true")
            setTimeout(() => requestAnimationFrame(() => compute_context.drawImage(video, 0, 0, compute_canvas.width, compute_canvas.height)), 500)
    }

    setInterval(() => !video.paused && update_canvas(), 2000)
    setInterval(() => {
        video_player.dataset.ambient_light = document.fullscreenElement == null && battery_high

        if (video_player.dataset.ambient_light == "true")
            requestAnimationFrame(() => context.drawImage(compute_canvas, 0, 0, canvas.width, canvas.height))
    }, 100)

    video.addEventListener("loadeddata", () => setTimeout(update_canvas, 100))

    const overlay = document.getElementById("video_player_overlay")
    const play_button_element = document.getElementById("video_player_play_button")
    const volume_button_element = document.getElementById("video_player_volume_button")
    const popup_button_element = document.getElementById("video_player_popup_button")
    const fullscreen_button_element = document.getElementById("video_player_fullscreen_button")

    const hide_overlay = debounce(() => overlay.dataset.show = false, 2000)

    overlay.addEventListener("pointermove", () => {
        if (overlay.dataset.show == "false") {
            overlay.dataset.show = true

            hide_overlay()
        }
    })
    overlay.addEventListener("pointerout", () => overlay.dataset.show = false)

    function play() {
        video.paused ? video.play() : video.pause()
    }

    overlay.addEventListener("click", e => {
        if (e.target == overlay)
            play()
    })
    play_button_element.addEventListener("click", play)
    volume_button_element.addEventListener("click", () => video.muted = !video.muted)
    popup_button_element.addEventListener("click", () => !video.disablePictureInPicture && video.requestPictureInPicture())

    function fullscreen() {
        video_player.dataset.fullscreen = document.fullscreenElement == null

        if (document.fullscreenElement == null)
            video_player.requestFullscreen()
        else
            document.exitFullscreen()
    }

    fullscreen_button_element.addEventListener("click", fullscreen)
    video_player.addEventListener("dblclick", fullscreen)

    function update_play_button() {
        video_player.dataset.paused = video.paused
    }

    video.addEventListener("play", update_play_button)
    video.addEventListener("pause", update_play_button)

    const progression_slider_element = document.getElementById("video_player_progression_slider")
    const volume_slider_element = document.getElementById("video_player_volume_slider")
    const progression_element = document.getElementById("video_player_progression")
    const duration_element = document.getElementById("video_player_duration")
    let was_paused = video.paused

    duration_element.textContent = duration_to_string(progression_slider_element.max)

    progression_slider_element.addEventListener("input", () => {
        progression_element.textContent = duration_to_string(video.currentTime = progression_slider_element.value)
        update_canvas()
    })
    progression_slider_element.addEventListener("pointerdown", () => {
        was_paused = video.paused
        video.pause()

        function up() {
            was_paused ? video.pause() : video.play()

            progression_slider_element.removeEventListener("pointerup", up)
            progression_slider_element.removeEventListener("pointerout", up)
        }

        progression_slider_element.addEventListener("pointerup", up)
        progression_slider_element.addEventListener("pointerout", up)
    })
    volume_slider_element.addEventListener("input", () => {
        video.volume = volume_slider_element.value
        video.muted = false
    })

    video.addEventListener("durationchange", () => {
        if (isFinite(video.duration)) {
            video_metadata.duration = video.duration
            duration_element.textContent = duration_to_string(progression_slider_element.max = video.duration)
        }
    })
    video.addEventListener("timeupdate", () => {
        localStorage.setItem(`video-progress:${video_metadata.uuid}`, video.currentTime)
        progression_element.textContent = duration_to_string(progression_slider_element.value = video.currentTime)
        progression_slider_element.dispatchEvent(new Event("update"))
    })

    function update_volume_button() {
        if (video.muted) {
            video_player.dataset.volume = "muted"
            return
        }

        video_player.dataset.volume = video.volume > .5 ? "high" : video.volume > 0 ? "low" : "muted"
    }

    video.addEventListener("volumechange", () => {
        volume_slider_element.value = video.volume
        volume_slider_element.dispatchEvent(new Event("update"))

        update_volume_button()
    })

    function update_buffered_progress() {
        const gradients = []

        for (let i = 0; i < video.buffered.length; i++) {

            const start = video.buffered.start(i) / video_metadata.duration * 100
            const end = video.buffered.end(i) / video_metadata.duration * 100

            gradients.push(`rgb(var(--color-fixed-light) / .4) ${start}%, rgb(var(--color-secondary) / .7) ${start}%, rgb(var(--color-secondary) / .7) ${end}%, rgb(var(--color-fixed-light) / .4) ${end}%`)
        }

        progression_slider_element.style.background = `linear-gradient(90deg, ${gradients.join(",")})`
    }

    video.addEventListener("progress", update_buffered_progress)
    video.addEventListener("timeupdate", update_buffered_progress)
    video.addEventListener("play", update_buffered_progress)
}