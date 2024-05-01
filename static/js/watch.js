window.battery_high = true

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

TimeAgo.addDefaultLocale(await(await fetch("https://unpkg.com/javascript-time-ago@2.5/locale/fr.json")).json())

const time_ago = new TimeAgo('fr')

class VideoInfo {
    #description = document.getElementById("video_info_description")
    #vues = document.getElementById("video_info_vues")
    #time = document.getElementById("video_info_time")
    #show_more = document.getElementById("video_info_show_more")

    #info = {
        show_more: false,
        date: null,
        vues: null,
    }

    constructor(video_metadata) {
        this.date = video_metadata.date
        this.vues = video_metadata.vues

        this.#show_more.addEventListener("click", () => this.show_more = !this.show_more)
    }

    set show_more(show_more) {
        if (this.#info.show_more != !!show_more) {
            const content = this.#show_more.textContent

            this.#show_more.textContent = this.#show_more.dataset.switch_content
            this.#show_more.dataset.switch_content = content
            this.#description.classList.toggle("open")
            this.#info.show_more = !!show_more
        }
    }

    get show_more() {
        return this.#info.show_more
    }

    set date(date) {
        if (this.#info.date != date && date instanceof $mol_time_moment) {
            this.#time.textContent = time_ago.format(date.valueOf())
            this.#info.date = date
        }
    }

    get date() {
        return this.#info.date
    }

    set vues(vues) {
        if (this.#info.vues != vues && typeof vues === "number") {
            if (vues >= 0 && vues < 1000)
                this.#vues.textContent = vues + (vues > 1 ? " vues" : " vue")
            else if (vues < 1000000)
                this.#vues.textContent = (Math.round(vues / 100) / 10) + " k vues"
            else if (vues < 1000000000)
                this.#vues.textContent = (Math.round(vues / 100000) / 10) + " M de vues"
            else
                this.#vues.textContent = (Math.round(vues / 100000000) / 10) + " Md de vues"

            this.#info.vues = vues
        }
    }

    get vues() {
        return this.#info.vues
    }
}

window.video_info = new VideoInfo(video_metadata)

class VideoSource extends MediaSource {
    #video_player
    #source_buffer
    #resolution = 0
    #buffered
    #min_chunk_size = 0.5
    #chunk_buffer = []
    #appending_segment = false
    request_latency = 0
    download_latency = 0
    #loading = false
    #length = this.#min_chunk_size
    #start = 0

    constructor(video_player, speed) {
        super()

        this.#video_player = video_player

        if (speed !== undefined) this.#get_resolution(speed)

        this.addEventListener("sourceopen", () => {
            this.#source_buffer = this.addSourceBuffer(`video/webm;codecs=\"vp9${this.#video_player.has_audio ? ",opus" : ""}\"`)
            this.#source_buffer.mode = "segments"
            this.#source_buffer.appendWindowStart = 0
            this.#source_buffer.appendWindowEnd = video_player.duration
            this.#buffered = this.#source_buffer.buffered
            this.duration = video_player.duration

            const append_segment = () => {
                if (this.#chunk_buffer.length) {
                    this.#appending_segment = true

                    const { range_start, range_end, data } = this.#chunk_buffer.shift()

                    this.#source_buffer.addEventListener("updateend", () => {
                        this.#source_buffer.timestampOffset = range_start
                        this.#source_buffer.appendWindowStart = range_start
                        this.#source_buffer.appendWindowEnd = range_end
                        this.#source_buffer.appendBuffer(data)
                    }, { once: true })

                    if (this.buffered_end >= range_end)
                        this.#source_buffer.onupdateend()
                    else
                        this.#source_buffer.remove(this.buffered_end, range_end)
                } else {
                    this.#appending_segment = false
                }
            }

            this.#source_buffer.onupdateend = append_segment
            this.start()
        })
    }

    set resolution(resolution) {
        this.#resolution = resolution
    }

    get resolution() {
        return this.#video_player.resolutions[this.#resolution]
    }

    get length() {
        return this.#video_player.lengths[this.#resolution]
    }

    get bitrate() {
        return this.#video_player.bitrates[this.#resolution]
    }

    get buffered() {
        return this.#source_buffer.buffered.length ? this.#buffered = this.#source_buffer.buffered : this.#buffered
    }

    get buffered_end() {
        if (this.buffered.length) {
            for (let i = this.buffered.length - 1; i > -1; i--)
                if (this.#video_player.current_time >= this.buffered.start(i) && this.#video_player.current_time <= this.buffered.end(i))
                    return this.buffered.end(i)
        }

        return 0
    }

    get #continue() {
        return this.#video_player.current_time > (this.buffered_end - 5) && this.buffered_end < this.duration
    }

    start() {
        if (!this.#loading && this.#continue) {
            this.#loading = true
            this.#start = this.#video_player.current_time

            this.#next_segment()
        }
    }

    #log(speed, download_latency, request_latency) {
        console.log(
            this.resolution.toString() +
            "p, " +
            (Math.round((speed * 8 / 1_000_000) * 100) / 100).toString() +
            "Mbps, download : " +
            (Math.round(download_latency * 100) / 100).toString() +
            "ms, request : " +
            (Math.round(request_latency * 100) / 100).toString() +
            "ms"
        )
    }

    #get_resolution(speed) {
        this.#resolution = Math.max(this.#video_player.bitrates.findLastIndex(bitrate => bitrate * 2.2 < speed), 0)
    }

    #set_timeout(key, abort_controller) {
        if (this[key])
            return setTimeout(() => {
                this[key] = 0
                this.#length = Math.round(Math.max(this.#length / 2, this.#min_chunk_size))

                abort_controller.abort("Request timeout : Certainly due to a change in connection speed.")
                this.#next_segment()
            }, this[key] * 2)
        else
            return null
    }

    #clear_timeout(timeout_id) {
        if (timeout_id != null) clearTimeout(timeout_id)
    }

    async #fetch() {
        const abort_controller = new AbortController()
        const timeout_id = this.#set_timeout("request_latency", abort_controller)
        const t0 = Date.now()
        const response = await fetch(`/video/${this.#video_player.uuid
            }/${this.resolution
            }/${Math.round(this.#start * 1_000_000_000)
            }/${Math.round(Math.min(this.#start + this.#length, this.duration) * 1_000_000_000)}`,
            { signal: abort_controller.signal }
        )
        const t1 = Date.now()

        this.#clear_timeout(timeout_id)

        const request_latency = this.request_latency = Math.max(t1 - t0, 1)

        if (response.status != 200)
            throw "Request failed : " + await response.text()

        const content_range_split = response.headers.get("X-Content-Range").split("/")
        const [range_start, range_end] = content_range_split[0].split("-").map(value => parseInt(value))

        this.duration = Math.min(parseInt(content_range_split[1]) / 1_000_000_000, this.duration)

        return {
            response,
            abort_controller,
            request_latency,
            range_start: Math.max(range_start / 1_000_000_000, 0),
            range_end: Math.min(range_end / 1_000_000_000, this.duration)
        }
    }

    async #read(response, abort_controller) {
        const timeout_id = this.#set_timeout("download_latency", abort_controller)
        const t2 = Date.now()
        const data = await response.arrayBuffer()
        const t3 = Date.now()
        const download_latency = this.download_latency = Math.max(t3 - t2, 1)

        this.#clear_timeout(timeout_id)

        return { data, download_latency, speed: data.byteLength * 1_000 / download_latency }
    }

    #append_segment(range_start, range_end, data) {
        this.#chunk_buffer.push({ range_start, range_end, data })

        if (!this.#source_buffer.updating && !this.#appending_segment)
            this.#source_buffer.onupdateend()
    }

    async #next_segment() {
        try {
            const { response, abort_controller, request_latency, range_start, range_end } = await this.#fetch()
            const { data, download_latency, speed } = await this.#read(response, abort_controller)

            this.#log(speed, download_latency, request_latency)
            this.#get_resolution(speed)
            this.#start = range_end

            if (this.#continue) {
                this.#length = Math.round(speed / this.length * this.duration)
                this.#length = Math.round(Math.min(Math.max(this.#length, this.#min_chunk_size) + this.#start, this.duration) - this.#start)

                if (this.#length > 0)
                    this.#next_segment()
                else
                    this.#loading = false
            } else {
                this.#loading = false
            }

            this.#append_segment(range_start, range_end, data)
        } catch (error) {
            if (typeof error === "string")
                console.warn(error)
            else
                console.error(error)
        }
    }
}

class VideoPlayer {
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

    #video_source
    #metadata = {
        uuid: null,
        duration: null,
        resolutions: null,
        lengths: null,
        bitrates: null,
        has_audio: null,
    }

    constructor(video_metadata, start_time = parseFloat(new URLSearchParams(location.search).get("t"))) {
        this.#metadata.uuid = video_metadata.uuid
        this.#metadata.duration = video_metadata.duration
        this.#metadata.resolutions = video_metadata.resolutions
        this.#metadata.lengths = video_metadata.lengths
        this.#metadata.bitrates = video_metadata.bitrates
        this.#metadata.has_audio = video_metadata.has_audio

        // setup media session
        if ("mediaSession" in navigator) {
            this.#video.addEventListener("play", () => navigator.mediaSession.playbackState = "playing")
            this.#video.addEventListener("pause", () => navigator.mediaSession.playbackState = "paused")
            this.#video.addEventListener("timeupdate", () => navigator.mediaSession.setPositionState({
                duration: this.duration,
                playbackRate: this.#video.playbackRate,
                position: this.current_time
            }))

            navigator.mediaSession.setPositionState({
                duration: this.duration,
                playbackRate: this.#video.playbackRate,
                position: this.current_time
            })
            navigator.mediaSession.playbackState = this.paused ? "paused" : "playing"
            navigator.mediaSession.metadata = new MediaMetadata({
                title: video_metadata.title
            })
            navigator.mediaSession.setActionHandler("play", () => this.#video.play())
            navigator.mediaSession.setActionHandler("pause", () => this.#video.pause())
            navigator.mediaSession.setActionHandler("stop", () => {
                this.#video.pause()
                this.current_time = 0
            })
            navigator.mediaSession.setActionHandler("seekbackward", (details) => this.current_time -= details.seekOffset || 2)
            navigator.mediaSession.setActionHandler("seekforward", (details) => this.current_time += details.seekOffset || 2)
            navigator.mediaSession.setActionHandler("seekto", (details) => {
                if (details.fastSeek && "fastSeek" in HTMLMediaElement.prototype)
                    this.#video.fastSeek(details.seekTime)
                else
                    this.current_time = details.seekTime
            })
        }

        // set video start time
        if (!(start_time >= 0 && start_time <= this.duration))
            start_time = parseFloat(localStorage.getItem(`video-progress:${this.uuid}`, this.current_time)) || 0
        if (start_time < this.duration - 1)
            this.current_time = start_time

        // listen whether to show or not the overlay
        const hide_overlay = debounce(() => this.#overlay.dataset.show = false, 2000)

        this.#overlay.addEventListener("pointermove", () => {
            if (this.#overlay.dataset.show == "false") {
                this.#overlay.dataset.show = true

                hide_overlay()
            }
        })
        this.#overlay.addEventListener("pointerout", () => this.#overlay.dataset.show = false)

        // listen on play request
        const play = () => this.paused = this.ended ? (this.current_time = 0, this.#video_source && this.#video_source.start(), false) : !this.paused

        this.#overlay.addEventListener("click", e => e.target == this.#overlay && play())
        this.#play_button.addEventListener("click", play)

        // listen on mute request
        const mute = () => this.muted = !this.muted

        this.#volume_button.addEventListener("click", mute)

        // listen on picture in picture request
        this.#popup_button.addEventListener("click", () => this.picture_in_picture())
        this.#popup_button.hidden = !("requestPictureInPicture" in HTMLVideoElement.prototype)

        // listen on fullscreen request
        const fullscreen = () => this.#video_player.dataset.fullscreen = this.fullscreen = !this.fullscreen

        this.#fullscreen_button.addEventListener("click", fullscreen)
        this.#video_player.addEventListener("dblclick", fullscreen)

        // setup sliders and listen on sliders inputs
        this.#init_input_range(this.#progress_slider)
        this.#init_input_range(this.#volume_slider)
        this.#update_time()
        this.#update_volume()

        let was_paused = this.paused

        this.#duration.textContent = this.#duration_to_string(this.#progress_slider.max)

        this.#progress_slider.addEventListener("input", () => this.current_time = this.#progress_slider.value)
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
        const update_play_button = () => this.#video_player.dataset.paused = this.paused

        this.#video.addEventListener("play", update_play_button)
        this.#video.addEventListener("pause", update_play_button)
        this.#video.addEventListener("durationchange", () => this.#duration.textContent = this.#duration_to_string(this.#progress_slider.max = this.#metadata.duration = this.#video.duration))
        this.#video.addEventListener("timeupdate", () => this.#update_time())
        this.#video.addEventListener("volumechange", () => this.#update_volume())

        // update ui on buffer progress
        const update_buffer_progress = () => {
            const gradients = []

            for (let i = 0; i < this.#video.buffered.length; i++) {
                const start = this.#video.buffered.start(i) / this.duration * 100
                const end = this.#video.buffered.end(i) / this.duration * 100

                gradients.push(`rgb(var(--color-fixed-light) / .4) ${start}%, rgb(var(--color-secondary) / .7) ${start}%, rgb(var(--color-secondary) / .7) ${end}%, rgb(var(--color-fixed-light) / .4) ${end}%`)
            }

            this.#progress_slider.style.background = `linear-gradient(90deg, ${gradients.join(",")})`
        }

        this.#video.addEventListener("progress", update_buffer_progress)
        this.#video.addEventListener("timeupdate", update_buffer_progress)
        this.#video.addEventListener("play", update_buffer_progress)

        // update ambient light canvas
        this.#context.globalAlpha = .05

        setInterval(() => !this.paused && this.#update_canvas(), 2000)
        setInterval(() => {
            this.#video_player.dataset.ambient_light = !this.fullscreen && battery_high

            if (this.#video_player.dataset.ambient_light == "true")
                requestAnimationFrame(() => this.#context.drawImage(this.#compute_canvas, 0, 0, this.#canvas.width, this.#canvas.height))
        }, 100)

        this.#video.addEventListener("loadeddata", () => setTimeout(() => this.#update_canvas(), 100))

        // key bindings
        window.addEventListener("keydown", e => {
            const key_bindings = {
                " ": play,
                f: fullscreen,
                p: () => this.picture_in_picture(),
                m: mute,
                ArrowLeft: () => this.current_time = Math.max(this.current_time - 2, 0),
                ArrowRight: () => this.current_time = Math.min(this.current_time + 2, this.duration),
                ArrowUp: () => this.volume = Math.min(this.volume + .1, 1),
                ArrowDown: () => this.volume = Math.max(this.volume - .1, 0),
            }

            if (e.key in key_bindings) {
                e.preventDefault()

                key_bindings[e.key]()
            }
        })

        // load and manage video stream
        fetch(`/thumbnail/${this.uuid}`).then(async response => {
            const t0 = Date.now()
            const data = await response.blob()
            const t1 = Date.now()

            this.#video_source = new VideoSource(this, data.size * 1_000 / Math.max(t1 - t0, 1))
            this.#video.poster = URL.createObjectURL(data)
            this.#progress_slider.addEventListener("input", () => this.#video_source.start())
            this.#video.addEventListener("timeupdate", () => this.#video_source.start())
            this.#video.addEventListener("loadedmetadata", () => this.#video.play())

            this.#video.src = URL.createObjectURL(this.#video_source)
        })
    }

    get uuid() {
        return this.#metadata.uuid
    }

    get duration() {
        return this.#metadata.duration
    }

    get resolutions() {
        return this.#metadata.resolutions
    }

    get lengths() {
        return this.#metadata.lengths
    }

    get bitrates() {
        return this.#metadata.bitrates
    }

    get has_audio() {
        return this.#metadata.has_audio
    }

    set current_time(current_time) {
        this.#video.currentTime = current_time
        this.#update_time()
    }

    get current_time() {
        return this.#video.currentTime
    }

    get ended() {
        return this.#video_player.dataset.ended = this.current_time == this.duration
    }

    set paused(paused) {
        paused ? this.#video.pause() : this.#video.play()
    }

    get paused() {
        return this.#video.paused
    }

    set muted(muted) {
        this.#video.muted = muted
        this.#update_volume()
    }

    get muted() {
        return this.#video.muted
    }

    set volume(volume) {
        this.muted = false
        this.#video.volume = volume
        this.#update_volume()
    }

    get volume() {
        return this.#video.volume
    }

    set fullscreen(fullscreen) {
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

    picture_in_picture() {
        "requestPictureInPicture" in HTMLVideoElement.prototype && !this.#video.disablePictureInPicture && this.#video.requestPictureInPicture()
    }

    #update_time() {
        localStorage.setItem(`video-progress:${this.uuid}`, this.current_time)

        this.ended
        this.#progress.textContent = this.#duration_to_string(this.#progress_slider.value = this.current_time)
        this.#progress_slider.dispatchEvent(new Event("update"))
        this.#update_canvas()
    }

    #update_volume() {
        if (this.muted) {
            this.#video_player.dataset.volume = "muted"
            this.#volume_slider.value = 0
        } else {
            this.#video_player.dataset.volume = this.volume > .5 ? "high" : this.volume > 0 ? "low" : "muted"
            this.#volume_slider.value = this.volume
        }

        this.#volume_slider.dispatchEvent(new Event("update"))
    }

    #init_input_range(element) {
        function update() {
            requestAnimationFrame(() => element.style.setProperty("--range-position", element.value / element.max * 100 + "%"))
        }

        element.addEventListener("input", update)
        element.addEventListener("update", update)

        update()
    }

    #duration_to_string(duration) {
        const string = `${Math.floor(duration / 60 % 60)}:${(Math.round(duration) % 60).toString().padStart(2, 0)}`

        return duration >= 3600 ? Math.floor(duration / 3600) + ":" + string.padStart(5, 0) : string
    }

    #update_canvas() {
        if (this.#video_player.dataset.ambient_light == "true")
            setTimeout(() => requestAnimationFrame(() => this.#compute_context.drawImage(this.#video, 0, 0, this.#compute_canvas.width, this.#compute_canvas.height)), 500)
    }
}

window.video_player = new VideoPlayer(video_metadata)