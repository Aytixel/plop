import { formatDuration } from "../../js/utils/duration.mjs"

class VideoPlayer extends EventTarget {
    #video_player
    #canvas
    #context
    #compute_canvas
    #compute_context
    #video
    #overlay
    #play_button
    #volume_button
    #popup_button
    #fullscreen_button
    #progress_slider
    #volume_slider
    #progress
    #duration

    #metadata = {
        uuid: undefined,
        title: "",
        ambient_light: true,
        duration: -1,
    }

    constructor(parent, options = {}) {
        super()

        this.#video_player = parent.getElementById("video_player")
        this.#canvas = this.#video_player.children[0]
        this.#context = this.#canvas.getContext("2d")
        this.#compute_canvas = this.#canvas.cloneNode()
        this.#compute_context = this.#compute_canvas.getContext("2d")
        this.#video = this.#video_player.children[1]
        this.#overlay = parent.getElementById("video_player_overlay")
        this.#play_button = parent.getElementById("video_player_play_button")
        this.#volume_button = parent.getElementById("video_player_volume_button")
        this.#popup_button = parent.getElementById("video_player_popup_button")
        this.#fullscreen_button = parent.getElementById("video_player_fullscreen_button")
        this.#progress_slider = parent.getElementById("video_player_progress_slider")
        this.#volume_slider = parent.getElementById("video_player_volume_slider")
        this.#progress = parent.getElementById("video_player_progress")
        this.#duration = parent.getElementById("video_player_duration")

        if (typeof options.uuid === "string") this.#metadata.uuid = options.uuid
        if (typeof options.title === "string") this.#metadata.title = options.title
        if (typeof options.ambient_light === "boolean") this.#metadata.ambient_light = options.ambient_light

        const shortcut_on_focus = (typeof options.shortcut_on_focus === "boolean") ? options.shortcut_on_focus : false
        const duration = this.#metadata.duration = (typeof options.duration === "number") ? options.duration : -1
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

        this.#duration.textContent = formatDuration(this.#progress_slider.max)

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
        const updateDuration = () => this.#duration.textContent = formatDuration(this.#progress_slider.max = this.duration)

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
            if (!shortcut_on_focus || this.#video_player.contains(parent.activeElement) || this.#video_player == parent.activeElement) {
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
        return (this.#metadata.duration == -1) ? this.#video.duration : this.#metadata.duration
    }

    set currentTime(currentTime) {
        this.#video.currentTime = currentTime
        this.#updateTime()
    }

    get currentTime() {
        return this.#video.currentTime
    }

    get ended() {
        return this.#video_player.dataset.ended = Math.round(this.currentTime * 100) >= Math.round(this.duration * 100) - 10
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

    get videoWidth() {
        return this.#video.videoWidth
    }

    get videoHeight() {
        return this.#video.videoHeight
    }

    captureStream() {
        return this.#video.captureStream()
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
        this.#progress.textContent = formatDuration(this.#progress_slider.value = this.currentTime)
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

class VideoPlayerElement extends HTMLElement {
    #player

    constructor() {
        super()
    }

    getPlayer(options = {}) {
        if (this.#player)
            return this.#player

        return this.#player = new VideoPlayer(this.shadowRoot, options)
    }

    async connectedCallback() {
        const shadow = this.attachShadow({ mode: "open" })
        const width = this.getAttribute("width") || ""
        const height = this.getAttribute("height") || ""
        const title = this.getAttribute("title") || ""
        const duration = this.getAttribute("duration") || ""

        shadow.innerHTML = /*html*/`
            <div id="video_player" data-ambient_light="true" data-paused="true" data-ended="false" data-volume="high" data-fullscreen="false" tabindex="0" style="display: none">
                <canvas width="256" height="144"></canvas>
                <video autoplay="" playsinline="" width="${width}" height="${height}"></video>
                <div id="video_player_overlay" data-show="false">
                    <div id="video_player_title">${title}</div>
                    <div id="video_player_controls">
                        <input type="range" min="0" value="0" max="${duration}" step="0.05" id="video_player_progress_slider" aria-label="Barre de Progression">
                        <div>
                            <button id="video_player_play_button" aria-label="Bouton Play">
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                                    <path d="M6 5H8V19H6V5ZM16 5H18V19H16V5Z"></path>
                                </svg>
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                                    <path d="M19.376 12.4158L8.77735 19.4816C8.54759 19.6348 8.23715 19.5727 8.08397 19.3429C8.02922 19.2608 8 19.1643 8 19.0656V4.93408C8 4.65794 8.22386 4.43408 8.5 4.43408C8.59871 4.43408 8.69522 4.4633 8.77735 4.51806L19.376 11.5838C19.6057 11.737 19.6678 12.0474 19.5146 12.2772C19.478 12.3321 19.4309 12.3792 19.376 12.4158Z"></path>
                                </svg>
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M6 4H21C21.5523 4 22 4.44772 22 5V12H20V6H6V9L1 5L6 1V4ZM18 20H3C2.44772 20 2 19.5523 2 19V12H4V18H18V15L23 19L18 23V20Z"></path>
                                </svg>
                            </button>
                            <button id="video_player_volume_button" aria-label="Bouton Volume">
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                                    <path d="M2 16.0001H5.88889L11.1834 20.3319C11.2727 20.405 11.3846 20.4449 11.5 20.4449C11.7761 20.4449 12 20.2211 12 19.9449V4.05519C12 3.93977 11.9601 3.8279 11.887 3.73857C11.7121 3.52485 11.3971 3.49335 11.1834 3.66821L5.88889 8.00007H2C1.44772 8.00007 1 8.44778 1 9.00007V15.0001C1 15.5524 1.44772 16.0001 2 16.0001ZM23 12C23 15.292 21.5539 18.2463 19.2622 20.2622L17.8445 18.8444C19.7758 17.1937 21 14.7398 21 12C21 9.26016 19.7758 6.80629 17.8445 5.15557L19.2622 3.73779C21.5539 5.75368 23 8.70795 23 12ZM18 12C18 10.0883 17.106 8.38548 15.7133 7.28673L14.2842 8.71584C15.3213 9.43855 16 10.64 16 12C16 13.36 15.3213 14.5614 14.2842 15.2841L15.7133 16.7132C17.106 15.6145 18 13.9116 18 12Z"></path>
                                </svg>
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                                    <path
                                        d="M8.88889 16.0001H5C4.44772 16.0001 4 15.5524 4 15.0001V9.00007C4 8.44778 4.44772 8.00007 5 8.00007H8.88889L14.1834 3.66821C14.3971 3.49335 14.7121 3.52485 14.887 3.73857C14.9601 3.8279 15 3.93977 15 4.05519V19.9449C15 20.2211 14.7761 20.4449 14.5 20.4449C14.3846 20.4449 14.2727 20.405 14.1834 20.3319L8.88889 16.0001ZM18.8631 16.5911L17.4411 15.1691C18.3892 14.4376 19 13.2902 19 12.0001C19 10.5697 18.2493 9.31476 17.1203 8.60766L18.5589 7.16906C20.0396 8.26166 21 10.0187 21 12.0001C21 13.8422 20.1698 15.4905 18.8631 16.5911Z">
                                    </path>
                                </svg>
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                                    <path d="M5.88889 16.0001H2C1.44772 16.0001 1 15.5524 1 15.0001V9.00007C1 8.44778 1.44772 8.00007 2 8.00007H5.88889L11.1834 3.66821C11.3971 3.49335 11.7121 3.52485 11.887 3.73857C11.9601 3.8279 12 3.93977 12 4.05519V19.9449C12 20.2211 11.7761 20.4449 11.5 20.4449C11.3846 20.4449 11.2727 20.405 11.1834 20.3319L5.88889 16.0001ZM20.4142 12.0001L23.9497 15.5356L22.5355 16.9498L19 13.4143L15.4645 16.9498L14.0503 15.5356L17.5858 12.0001L14.0503 8.46454L15.4645 7.05032L19 10.5859L22.5355 7.05032L23.9497 8.46454L20.4142 12.0001Z"></path>
                                </svg>
                            </button>
                            <input type="range" min="0" max="1" value="1" step="0.05" id="video_player_volume_slider" aria-label="Barre de Volume">
                            <span>
                                <span id="video_player_progress">0:00</span> / <span id="video_player_duration">0:00</span>
                            </span>
                            <span class="filler"></span>
                            <button id="video_player_popup_button" aria-label="Bouton Picture-in-Picture">
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                                    <path d="M21 3C21.5523 3 22 3.44772 22 4V11H20V5H4V19H10V21H3C2.44772 21 2 20.5523 2 20V4C2 3.44772 2.44772 3 3 3H21ZM21 13C21.5523 13 22 13.4477 22 14V20C22 20.5523 21.5523 21 21 21H13C12.4477 21 12 20.5523 12 20V14C12 13.4477 12.4477 13 13 13H21Z"></path>
                                </svg>
                            </button>
                            <button id="video_player_fullscreen_button" aria-label="Bouton Plein Écran">
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                                    <path d="M8 3V5H4V9H2V3H8ZM2 21V15H4V19H8V21H2ZM22 21H16V19H20V15H22V21ZM22 9H20V5H16V3H22V9Z"></path>
                                </svg>
                                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                                    <path d="M18 7H22V9H16V3H18V7ZM8 9H2V7H6V3H8V9ZM18 17V21H16V15H22V17H18ZM8 15V21H6V17H2V15H8Z"></path>
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `

        const style = document.createElement("style")

        style.textContent = await (await fetch("/component/video-player/video-player.css")).text()

        shadow.children[0].style.display = ""
        shadow.append(style)

        const player = shadow.querySelector("#video_player")
        const video = shadow.querySelector("video")
        const updateSize = () => {
            requestAnimationFrame(() => {
                if (player.dataset.fullscreen == "false") {
                    video.style.maxWidth = this.clientWidth + "px"
                    video.style.maxHeight = this.clientHeight + "px"
                } else {
                    video.style.maxWidth = window.innerWidth + "px"
                    video.style.maxHeight = window.innerHeight + "px"
                }

                if (!this.clientHeight) updateSize()
            })
        }
        const resize_observer = new ResizeObserver(updateSize)

        updateSize()
        resize_observer.observe(this)
    }
}

customElements.define("video-player", VideoPlayerElement)