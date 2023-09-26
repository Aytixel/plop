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

TimeAgo.addDefaultLocale(await(await fetch("https://unpkg.com/javascript-time-ago@2.5/locale/fr.json")).json())

const time_ago = new TimeAgo('fr')

// video info
{
    const description = document.getElementById("video_info_description")
    const vues = document.getElementById("video_info_vues")

    if (video_metadata.vues >= 0 && video_metadata.vues < 1000)
        vues.textContent = video_metadata.vues + (video_metadata.vues > 1 ? " vues" : " vue")
    else if (video_metadata.vues < 1000000)
        vues.textContent = (Math.round(video_metadata.vues / 100) / 10) + " k"
    else if (video_metadata.vues < 1000000000)
        vues.textContent = (Math.round(video_metadata.vues / 100000) / 10) + " M de vues"
    else
        vues.textContent = (Math.round(video_metadata.vues / 100000000) / 10) + " Md de vues"

    const time = document.getElementById("video_info_time")

    time.textContent = time_ago.format(video_metadata.date.valueOf())

    const show_more_button = document.getElementById("video_info_show_more_button")

    show_more_button.addEventListener("click", () => {
        const content = show_more_button.textContent

        show_more_button.textContent = show_more_button.dataset.switch_content
        show_more_button.dataset.switch_content = content
        description.classList.toggle("open")
    })
}

// media session
if ("mediaSession" in navigator) {
    const video = document.getElementById("video_player").children[1]

    video.addEventListener("play", () => navigator.mediaSession.playbackState = "playing")
    video.addEventListener("pause", () => navigator.mediaSession.playbackState = "paused")
    video.addEventListener("timeupdate", () => navigator.mediaSession.setPositionState({
        duration: video_metadata.duration,
        playbackRate: video.playbackRate,
        position: video.currentTime
    }))

    navigator.mediaSession.setPositionState({
        duration: video_metadata.duration,
        playbackRate: video.playbackRate,
        position: video.currentTime
    })
    navigator.mediaSession.playbackState = video.paused ? "paused" : "playing"
    navigator.mediaSession.metadata = new MediaMetadata({
        title: video_metadata.title
    })
    navigator.mediaSession.setActionHandler("play", () => video.play())
    navigator.mediaSession.setActionHandler("pause", () => video.pause())
    navigator.mediaSession.setActionHandler("stop", () => {
        video.pause()
        video.currentTime = 0
    })
    navigator.mediaSession.setActionHandler("seekbackward", (details) => video.currentTime -= details.seekOffset || 2)
    navigator.mediaSession.setActionHandler("seekforward", (details) => video.currentTime += details.seekOffset || 2)
    navigator.mediaSession.setActionHandler("seekto", (details) => {
        if (details.fastSeek && 'fastSeek' in video) {
            video.fastSeek(details.seekTime)

            return
        }

        video.currentTime = details.seekTime
    })
}

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
    let start_time = parseFloat(url_search_params.get("t"))

    if (!(start_time >= 0 && start_time <= video_metadata.duration))
        start_time = parseFloat(localStorage.getItem(`video-progress:${video_metadata.uuid}`, video.currentTime)) || 0

    if (start_time < video_metadata.duration - 1)
        video.currentTime = start_time

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
    const play_button = document.getElementById("video_player_play_button")
    const volume_button = document.getElementById("video_player_volume_button")
    const popup_button = document.getElementById("video_player_popup_button")
    const fullscreen_button = document.getElementById("video_player_fullscreen_button")

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
    play_button.addEventListener("click", play)

    function mute() {
        video.muted = !video.muted
    }

    volume_button.addEventListener("click", mute)

    function picture_in_picture() {
        !video.disablePictureInPicture && video.requestPictureInPicture()
    }

    popup_button.addEventListener("click", picture_in_picture)

    function fullscreen() {
        video_player.dataset.fullscreen = document.fullscreenElement == null

        if (document.fullscreenElement == null) {
            video_player.requestFullscreen()

            return
        }

        document.exitFullscreen()
    }

    fullscreen_button.addEventListener("click", fullscreen)
    video_player.addEventListener("dblclick", fullscreen)

    function update_play_button() {
        video_player.dataset.paused = video.paused
    }

    video.addEventListener("play", update_play_button)
    video.addEventListener("pause", update_play_button)

    const progress_slider = document.getElementById("video_player_progress_slider")
    const volume_slider = document.getElementById("video_player_volume_slider")
    const progress = document.getElementById("video_player_progress")
    const duration = document.getElementById("video_player_duration")
    let was_paused = video.paused

    duration.textContent = duration_to_string(progress_slider.max)

    progress_slider.addEventListener("input", () => {
        progress.textContent = duration_to_string(video.currentTime = progress_slider.value)
        update_canvas()
    })
    progress_slider.addEventListener("pointerdown", () => {
        was_paused = video.paused
        video.pause()

        function up() {
            was_paused ? video.pause() : video.play()

            progress_slider.removeEventListener("pointerup", up)
            progress_slider.removeEventListener("pointerout", up)
        }

        progress_slider.addEventListener("pointerup", up)
        progress_slider.addEventListener("pointerout", up)
    })
    volume_slider.addEventListener("input", () => {
        video.volume = volume_slider.value
        video.muted = false
    })

    video.addEventListener("durationchange", () => {
        if (isFinite(video.duration)) {
            video_metadata.duration = video.duration
            duration.textContent = duration_to_string(progress_slider.max = video.duration)
        }
    })
    video.addEventListener("timeupdate", () => {
        localStorage.setItem(`video-progress:${video_metadata.uuid}`, video.currentTime)
        progress.textContent = duration_to_string(progress_slider.value = video.currentTime)
        progress_slider.dispatchEvent(new Event("update"))
    })

    function update_volume_button() {
        if (video.muted) {
            video_player.dataset.volume = "muted"
            return
        }

        video_player.dataset.volume = video.volume > .5 ? "high" : video.volume > 0 ? "low" : "muted"
    }

    video.addEventListener("volumechange", () => {
        volume_slider.value = video.volume
        volume_slider.dispatchEvent(new Event("update"))

        update_volume_button()
    })

    function update_buffered_progress() {
        const gradients = []

        for (let i = 0; i < video.buffered.length; i++) {

            const start = video.buffered.start(i) / video_metadata.duration * 100
            const end = video.buffered.end(i) / video_metadata.duration * 100

            gradients.push(`rgb(var(--color-fixed-light) / .4) ${start}%, rgb(var(--color-secondary) / .7) ${start}%, rgb(var(--color-secondary) / .7) ${end}%, rgb(var(--color-fixed-light) / .4) ${end}%`)
        }

        progress_slider.style.background = `linear-gradient(90deg, ${gradients.join(",")})`
    }

    video.addEventListener("progress", update_buffered_progress)
    video.addEventListener("timeupdate", update_buffered_progress)
    video.addEventListener("play", update_buffered_progress)

    window.addEventListener("keydown", e => {
        if (["Space", "KeyF", "KeyP", "Semicolon", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].indexOf(e.code) != -1)
            e.preventDefault()

        switch (e.code) {
            case "Space":
                play()
                break
            case "KeyF":
                fullscreen()
                break
            case "KeyP":
                picture_in_picture()
                break
            case "Semicolon":
                mute()
                break
            case "ArrowLeft":
                video.currentTime = Math.max(video.currentTime - 2, 0)
                break
            case "ArrowRight":
                video.currentTime = Math.min(video.currentTime + 2, video_metadata.duration)
                break
            case "ArrowUp":
                video.volume = Math.min(video.volume + .1, 1)
                break
            case "ArrowDown":
                video.volume = Math.max(video.volume - .1, 0)
                break
        }
    })
}