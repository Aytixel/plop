export class VideoPlayer extends EventTarget {
    #video_player = document.getElementById("video_player")
    #canvas = this.#video_player.children[0]
    #context = this.#canvas.getContext("2d")
    #compute_canvas = this.#canvas.cloneNode()
    #compute_context = this.#compute_canvas.getContext("2d")
    #video = this.#video_player.children[1]
    #overlay = document.getElementById("video_player_overlay")
    #play_button = document.getElementById("video_player_play_button")
    #volume_button = document.getElementById("video_player_volume_button")
    #popup_button = document.getElementById("video_player_popup_button")
    #fullscreen_button = document.getElementById("video_player_fullscreen_button")
    #progress_slider = document.getElementById("video_player_progress_slider")
    #volume_slider = document.getElementById("video_player_volume_slider")
    #progress = document.getElementById("video_player_progress")
    #duration = document.getElementById("video_player_duration")

    #metadata = {
        uuid: undefined,
        title: "",
        ambient_light: true,
    }

    constructor(options = {}) {
        super()

        if (typeof options.uuid === "string") this.#metadata.uuid = options.uuid
        if (typeof options.title === "string") this.#metadata.title = options.title
        if (typeof options.ambient_light === "boolean") this.#metadata.ambient_light = options.ambient_light

        const shortcut_of_focus = (typeof options.shortcut_of_focus === "boolean") ? options.shortcut_of_focus : false
        const duration = (typeof options.duration === "number") ? options.duration : -1
        let start_time = (typeof options.start_time === "number") ? options.start_time : parseFloat(new URLSearchParams(location.search).get("t"))

        // setup media session
        if ("mediaSession" in navigator) {
            const updateTime = () => !isNaN(this.duration) && navigator.mediaSession.setPositionState({
                duration: this.duration,
                playbackRate: this.#video.playbackRate,
                position: this.currentTime
            })

            this.#video.addEventListener("play", () => navigator.mediaSession.playbackState = "playing")
            this.#video.addEventListener("pause", () => navigator.mediaSession.playbackState = "paused")
            this.#video.addEventListener("timeupdate", updateTime)
            this.#video.addEventListener("loadedmetadata", updateTime)

            navigator.mediaSession.playbackState = this.paused ? "paused" : "playing"
            navigator.mediaSession.metadata = new MediaMetadata({
                title: this.title
            })
            navigator.mediaSession.setActionHandler("play", () => this.play())
            navigator.mediaSession.setActionHandler("pause", () => this.pause())
            navigator.mediaSession.setActionHandler("stop", () => {
                this.pause()
                this.currentTime = 0
            })
            navigator.mediaSession.setActionHandler("seekbackward", (details) => this.currentTime -= details.seekOffset || 2)
            navigator.mediaSession.setActionHandler("seekforward", (details) => this.currentTime += details.seekOffset || 2)
            navigator.mediaSession.setActionHandler("seekto", (details) => {
                if (details.fastSeek && "fastSeek" in HTMLMediaElement.prototype)
                    this.#video.fastSeek(details.seekTime)
                else
                    this.currentTime = details.seekTime
            })
        }

        // set video start time
        if (this.uuid !== undefined && !(start_time >= 0 && start_time <= duration))
            start_time = parseFloat(localStorage.getItem(`video-progress:${this.uuid}`, this.currentTime)) || 0
        if (start_time < duration - 1)
            this.currentTime = start_time

        // listen whether to show or not the overlay
        const hideOverlay = this.#debounce(() => this.#overlay.dataset.show = false, 2000)

        this.#overlay.addEventListener("pointermove", () => {
            if (this.#overlay.dataset.show == "false") {
                this.#overlay.dataset.show = true

                hideOverlay()
            }
        })
        this.#overlay.addEventListener("pointerout", () => this.#overlay.dataset.show = false)

        // listen on play request
        const play = () => this.paused = this.ended ? (this.currentTime = 0, false) : !this.paused

        this.#overlay.addEventListener("click", e => e.target == this.#overlay && play())
        this.#play_button.addEventListener("click", play)

        // listen on mute request
        const mute = () => this.muted = !this.muted

        this.#volume_button.addEventListener("click", mute)

        // listen on picture in picture request
        this.#popup_button.addEventListener("click", () => this.requestPictureInPicture())
        this.#popup_button.hidden = !("requestPictureInPicture" in HTMLVideoElement.prototype)

        // listen on fullscreen request
        const fullscreen = () => this.fullscreen = !this.fullscreen

        this.#fullscreen_button.addEventListener("click", fullscreen)
        this.#video_player.addEventListener("dblclick", fullscreen)

        // setup sliders and listen on sliders inputs
        this.#initInputRange(this.#progress_slider)
        this.#initInputRange(this.#volume_slider)
        this.#updateTime()
        this.#updateVolume()

        let was_paused = this.paused


        this.#duration.textContent = this.#durationToString(this.#progress_slider.max)

        this.#progress_slider.addEventListener("input", () => this.currentTime = this.#progress_slider.value)
        this.#progress_slider.addEventListener("pointerdown", () => {
            was_paused = this.paused
            this.paused = true

            const up = () => {
                this.paused = was_paused

                this.#progress_slider.removeEventListener("pointerup", up)
                this.#progress_slider.removeEventListener("pointerout", up)
            }

            this.#progress_slider.addEventListener("pointerup", up)
            this.#progress_slider.addEventListener("pointerout", up)
        })
        this.#volume_slider.addEventListener("input", () => this.volume = this.#volume_slider.value)

        // listen on video event and update ui
        const updatePlayButton = () => this.#video_player.dataset.paused = this.paused
        const updateDuration = () => this.#duration.textContent = this.#durationToString(this.#progress_slider.max = this.duration)

        this.#video.addEventListener("play", updatePlayButton)
        this.#video.addEventListener("pause", updatePlayButton)
        this.#video.addEventListener("loadedmetadata", updateDuration)
        this.#video.addEventListener("durationchange", updateDuration)
        this.#video.addEventListener("timeupdate", () => this.#updateTime())
        this.#video.addEventListener("volumechange", () => this.#updateVolume())
        this.#video.addEventListener("enterpictureinpicture", () => this.fullscreen = false)

        // update ui on buffer progress
        const updateBufferProgress = () => {
            const gradients = []

            for (let i = 0; i < this.#video.buffered.length; i++) {
                const start = this.#video.buffered.start(i) / this.duration * 100
                const end = this.#video.buffered.end(i) / this.duration * 100

                gradients.push(`rgb(var(--color-fixed-light) / .4) ${start}%, rgb(var(--color-secondary) / .7) ${start}%, rgb(var(--color-secondary) / .7) ${end}%, rgb(var(--color-fixed-light) / .4) ${end}%`)
            }

            this.#progress_slider.style.background = `linear-gradient(90deg, ${gradients.join(",")})`
        }

        this.#video.addEventListener("progress", updateBufferProgress)
        this.#video.addEventListener("timeupdate", updateBufferProgress)
        this.#video.addEventListener("play", updateBufferProgress)

        // update ambient light canvas
        let battery_high = true

        if (navigator.getBattery)
            navigator.getBattery().then((battery) => {
                function update() {
                    battery_high = battery.charging || battery.level > .25
                }

                battery.addEventListener("chargingchange", update)
                battery.addEventListener("levelchange", update)
            })

        this.#context.globalAlpha = .05

        setInterval(() => !this.paused && this.#updateCanvas(), 2000)
        setInterval(() => {
            this.#video_player.dataset.ambient_light = this.ambientLight && !this.fullscreen && battery_high

            if (this.#video_player.dataset.ambient_light == "true")
                requestAnimationFrame(() => this.#context.drawImage(this.#compute_canvas, 0, 0, this.#canvas.width, this.#canvas.height))
        }, 100)

        this.#video.addEventListener("loadeddata", () => setTimeout(() => this.#updateCanvas(), 100))

        // key bindings
        this.#video_player.addEventListener("pointerdown", () => this.#video_player.focus())

        window.addEventListener("keydown", e => {
            if (!shortcut_of_focus || this.#video_player.contains(document.activeElement) || this.#video_player == document.activeElement) {
                const key_bindings = {
                    " ": play,
                    f: fullscreen,
                    p: () => this.requestPictureInPicture(),
                    m: mute,
                    arrowleft: () => this.currentTime = Math.max(this.currentTime - 2, 0),
                    arrowright: () => this.currentTime = Math.min(this.currentTime + 2, this.duration),
                    arrowup: () => this.volume = Math.min(this.volume + .1, 1),
                    arrowdown: () => this.volume = Math.max(this.volume - .1, 0),
                }
                const key = e.key.toLowerCase()

                if (key in key_bindings) {
                    e.preventDefault()

                    key_bindings[key]()
                }
            }
        })

        // event passthrough
        this.#video.addEventListener("abort", e => this.dispatchEvent(new e.constructor(e.type, e)))
        this.#video.addEventListener("canplay", e => this.dispatchEvent(new e.constructor(e.type, e)))
        this.#video.addEventListener("canplaythrough", e => this.dispatchEvent(new e.constructor(e.type, e)))
        this.#video.addEventListener("durationchange", e => this.dispatchEvent(new e.constructor(e.type, e)))
        this.#video.addEventListener("emptied", e => this.dispatchEvent(new e.constructor(e.type, e)))
        this.#video.addEventListener("encrypted", e => this.dispatchEvent(new e.constructor(e.type, e)))
        this.#video.addEventListener("ended", e => this.dispatchEvent(new e.constructor(e.type, e)))
        this.#video.addEventListener("error", e => this.dispatchEvent(new e.constructor(e.type, e)))
        this.#video.addEventListener("loadeddata", e => this.dispatchEvent(new e.constructor(e.type, e)))
        this.#video.addEventListener("loadedmetadata", e => this.dispatchEvent(new e.constructor(e.type, e)))
        this.#video.addEventListener("loadstart", e => this.dispatchEvent(new e.constructor(e.type, e)))
        this.#video.addEventListener("pause", e => this.dispatchEvent(new e.constructor(e.type, e)))
        this.#video.addEventListener("play", e => this.dispatchEvent(new e.constructor(e.type, e)))
        this.#video.addEventListener("playing", e => this.dispatchEvent(new e.constructor(e.type, e)))
        this.#video.addEventListener("progress", e => this.dispatchEvent(new e.constructor(e.type, e)))
        this.#video.addEventListener("ratechange", e => this.dispatchEvent(new e.constructor(e.type, e)))
        this.#video.addEventListener("seeked", e => this.dispatchEvent(new e.constructor(e.type, e)))
        this.#video.addEventListener("seeking", e => this.dispatchEvent(new e.constructor(e.type, e)))
        this.#video.addEventListener("stalled", e => this.dispatchEvent(new e.constructor(e.type, e)))
        this.#video.addEventListener("suspend", e => this.dispatchEvent(new e.constructor(e.type, e)))
        this.#video.addEventListener("timeupdate", e => this.dispatchEvent(new e.constructor(e.type, e)))
        this.#video.addEventListener("volumechange", e => this.dispatchEvent(new e.constructor(e.type, e)))
        this.#video.addEventListener("waiting", e => this.dispatchEvent(new e.constructor(e.type, e)))
        this.#video.addEventListener("enterpictureinpicture", e => this.dispatchEvent(new e.constructor(e.type, e)))
        this.#video.addEventListener("leavepictureinpicture", e => this.dispatchEvent(new e.constructor(e.type, e)))
        this.#video.addEventListener("resize", e => this.dispatchEvent(new e.constructor(e.type, e)))
    }

    set uuid(uuid) {
        this.#metadata.uuid = uuid
    }

    get uuid() {
        return this.#metadata.uuid
    }

    set title(title) {
        this.#metadata.title = title
    }

    get title() {
        return this.#metadata.title
    }

    set ambientLight(ambient_light) {
        this.#metadata.ambient_light = ambient_light
    }

    get ambientLight() {
        return this.#metadata.ambient_light
    }

    get duration() {
        return this.#video.duration
    }

    set currentTime(currentTime) {
        this.#video.currentTime = currentTime
        this.#updateTime()
    }

    get currentTime() {
        return this.#video.currentTime
    }

    get ended() {
        return this.#video_player.dataset.ended = Math.round(this.currentTime * 100) >= Math.round(this.duration * 100) - 3
    }

    set paused(paused) {
        paused ? this.pause() : this.play()
    }

    get paused() {
        return this.#video.paused
    }

    set muted(muted) {
        this.#video.muted = muted
        this.#updateVolume()
    }

    get muted() {
        return this.#video.muted
    }

    set volume(volume) {
        this.muted = false
        this.#video.volume = volume
        this.#updateVolume()
    }

    get volume() {
        return this.#video.volume
    }

    set fullscreen(fullscreen) {
        this.#video_player.dataset.fullscreen = fullscreen

        if (this.fullscreen != fullscreen) {
            if (fullscreen)
                this.#video_player.requestFullscreen()
            else
                document.exitFullscreen()
        }
    }

    get fullscreen() {
        return document.fullscreenElement != null
    }

    set poster(poster) {
        this.#video.poster = poster
    }

    get poster() {
        return this.#video.poster
    }

    set src(src) {
        this.#video.src = src
    }

    get src() {
        return this.#video.src
    }

    get videoTracks() {
        return this.#video.videoTracks
    }

    get audioTracks() {
        return this.#video.audioTracks
    }

    get videoWidth() {
        return this.#video.videoWidth
    }

    get videoHeight() {
        return this.#video.videoHeight
    }

    play() {
        return this.#video.play()
    }

    pause() {
        this.#video.pause()
    }

    requestPictureInPicture() {
        "requestPictureInPicture" in HTMLVideoElement.prototype && !this.#video.disablePictureInPicture && this.#video.requestPictureInPicture()
    }

    #updateTime() {
        if (this.uuid !== undefined) localStorage.setItem(`video-progress:${this.uuid}`, this.currentTime)

        this.ended
        this.#progress.textContent = this.#durationToString(this.#progress_slider.value = this.currentTime)
        this.#progress_slider.dispatchEvent(new Event("update"))
        this.#updateCanvas()
    }

    #updateVolume() {
        if (this.muted) {
            this.#video_player.dataset.volume = "muted"
            this.#volume_slider.value = 0
        } else {
            this.#video_player.dataset.volume = this.volume > .5 ? "high" : this.volume > 0 ? "low" : "muted"
            this.#volume_slider.value = this.volume
        }

        this.#volume_slider.dispatchEvent(new Event("update"))
    }

    #initInputRange(element) {
        function update() {
            requestAnimationFrame(() => element.style.setProperty("--range-position", element.value / element.max * 100 + "%"))
        }

        element.addEventListener("input", update)
        element.addEventListener("update", update)

        update()
    }

    #durationToString(duration) {
        const string = `${Math.floor(duration / 60 % 60)}:${(Math.round(duration) % 60).toString().padStart(2, 0)}`

        return duration >= 3600 ? Math.floor(duration / 3600) + ":" + string.padStart(5, 0) : string
    }

    #updateCanvas() {
        if (this.#video_player.dataset.ambient_light == "true")
            setTimeout(() => requestAnimationFrame(() => this.#compute_context.drawImage(this.#video, 0, 0, this.#compute_canvas.width, this.#compute_canvas.height)), 500)
    }

    #debounce(callback, delay) {
        let timer

        return function () {
            const args = arguments
            const context = this

            clearTimeout(timer)

            timer = setTimeout(() => callback.apply(context, args), delay)
        }
    }
}