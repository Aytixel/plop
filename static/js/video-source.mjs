export class VideoSource extends MediaSource {
    #video
    #video_metadata
    #source_buffer
    #resolution = 0
    #buffered
    #chunk_size = 1
    #buffer_size = 5
    #bitrate_coefficient = 1
    #chunk_buffer = []
    #appending_segment = false
    #loaded_resolution
    #loading = false
    request_latency = 0
    download_latency = 0

    constructor(video, video_metadata, speed) {
        super()

        this.#video = video
        this.#video_metadata = video_metadata
        this.#loaded_resolution = new Array(Math.ceil(video_metadata.duration)).fill(null)

        if (speed !== undefined) this.#setResolution(speed)

        this.#video.addEventListener("play", () => this.#start())
        this.#video.addEventListener("timeupdate", () => this.#start())
        this.#video.addEventListener("seeking", () => this.#start())
        this.addEventListener("sourceopen", () => {
            const mime_type = `video/webm;codecs=\"vp9${this.hasAudio ? ",opus" : ""}\"`

            this.#source_buffer = this.addSourceBuffer(mime_type)
            this.#source_buffer.mode = "segments"
            this.#source_buffer.appendWindowStart = 0
            this.#source_buffer.appendWindowEnd = this.#video_metadata.duration
            this.#buffered = this.#source_buffer.buffered
            this.duration = this.#video_metadata.duration

            console.log(`Media type : ${mime_type}`)

            const appendSegment = () => {
                if (this.#chunk_buffer.length) {
                    this.#appending_segment = true

                    const { range_start, range_end, data } = this.#chunk_buffer.shift()

                    this.#source_buffer.appendWindowEnd = Math.min(range_end / 1_000_000_000, this.#video_metadata.duration)
                    this.#source_buffer.appendBuffer(data)
                } else {
                    this.#appending_segment = false
                }
            }

            this.#source_buffer.onupdateend = appendSegment
            this.#start()
        }, { once: true })
    }

    get hasAudio() {
        return this.#video_metadata.has_audio
    }

    set resolution(resolution) {
        this.#resolution = resolution
    }

    get resolution() {
        return this.#video_metadata.resolutions[this.#resolution]
    }

    get length() {
        return this.#video_metadata.lengths[this.#resolution]
    }

    get bitrate() {
        return this.#video_metadata.bitrates[this.#resolution]
    }

    get buffered() {
        return this.#source_buffer.buffered.length ? this.#buffered = this.#source_buffer.buffered : this.#buffered
    }

    #start() {
        if (!this.#loading) {
            this.#loading = true

            this.#nextSegment()
        }
    }

    #log(speed, download_latency, request_latency, range_start, range_end) {
        console.log(
            this.resolution.toString() +
            "p, " +
            (Math.round((speed * 8 / 1_000_000) * 100) / 100).toString() +
            "Mbps, download : " +
            (Math.round(download_latency * 100) / 100).toString() +
            "ms, request : " +
            (Math.round(request_latency * 100) / 100).toString() +
            "ms, range : [" +
            range_start +
            ":" +
            range_end +
            "]"
        )
    }

    #setResolution(speed) {
        this.#resolution = Math.max(this.#video_metadata.bitrates.findLastIndex(bitrate => bitrate * this.#bitrate_coefficient < speed), 0)
    }

    #getFetchOptions() {
        const start = Math.floor(this.#video.currentTime)

        for (let i = start; true; i++) {
            if (i == start + this.#buffer_size || i >= this.#loaded_resolution.length)
                return null

            if (this.#loaded_resolution[i] === null)
                return { start: i * 1_000_000_000, length: this.#chunk_size * 1_000_000_000, resolution: this.resolution }
        }
    }

    async #fetch(fetch_options) {
        const start = Math.round(fetch_options.start)
        const end = Math.round(fetch_options.start + fetch_options.length)

        if (start == end)
            throw "Request rejected : length of zero"

        const t0 = Date.now()
        const response = await fetch(`/video/${this.#video_metadata.uuid}/${this.resolution}/${start}/${end}`)
        const t1 = Date.now()

        const request_latency = this.request_latency = Math.max(t1 - t0, 1)

        if (response.status != 200)
            throw "Request failed : " + await response.text()

        const content_range_split = response.headers.get("X-Content-Range").split("/")
        const [range_start, range_end] = content_range_split[0].split("-").map(value => parseInt(value))

        return {
            response,
            request_latency,
            range_start: range_start,
            range_end: range_end,
        }
    }

    async #read(response) {
        const t2 = Date.now()
        const data = await response.arrayBuffer()
        const t3 = Date.now()
        const download_latency = this.download_latency = Math.max(t3 - t2, 1)

        return { data, download_latency, speed: data.byteLength * 1_000 / download_latency }
    }

    #appendSegment(range_start, range_end, data) {
        this.#chunk_buffer.push({ range_start, range_end, data })

        if (!this.#source_buffer.updating && !this.#appending_segment)
            this.#source_buffer.onupdateend()
    }

    async #nextSegment() {
        try {
            const fetch_options = this.#getFetchOptions()

            if (fetch_options === null) {
                this.#loading = false
                return null
            }

            const { response, request_latency, range_start, range_end } = await this.#fetch(fetch_options)
            const { data, download_latency, speed } = await this.#read(response)
            const start = Math.round(range_start / 1_000_000_000)
            const end = Math.round(range_end / 1_000_000_000)

            for (let i = start; i < end; i++) {
                this.#loaded_resolution[i] = fetch_options.resolution
            }

            this.#log(speed, download_latency, request_latency, range_start, range_end)
            this.#setResolution(speed)
            this.#nextSegment()
            this.#appendSegment(range_start, range_end, data)
        } catch (error) {
            if (typeof error === "string")
                console.warn(error)
            else
                console.error(error)
        }
    }
}