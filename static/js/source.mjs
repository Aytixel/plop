export class VideoSource extends MediaSource {
    #video
    #video_metadata
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

    constructor(video, video_metadata, speed) {
        super()

        this.#video = video
        this.#video_metadata = video_metadata

        if (speed !== undefined) this.#getResolution(speed)

        this.addEventListener("sourceopen", () => {
            this.#source_buffer = this.addSourceBuffer(`video/webm;codecs=\"vp9${this.hasAudio ? ",opus" : ""}\"`)
            this.#source_buffer.mode = "segments"
            this.#source_buffer.appendWindowStart = 0
            this.#source_buffer.appendWindowEnd = this.#video_metadata.duration
            this.#buffered = this.#source_buffer.buffered
            this.duration = this.#video_metadata.duration

            console.log(`Media type : video/webm;codecs=\"vp9${this.hasAudio ? ",opus" : ""}\"`)

            const appendSegment = () => {
                if (this.#chunk_buffer.length) {
                    this.#appending_segment = true

                    const { range_start, range_end, data } = this.#chunk_buffer.shift()

                    this.#source_buffer.addEventListener("updateend", () => {
                        this.#source_buffer.timestampOffset = range_start
                        this.#source_buffer.appendBuffer(data)
                    }, { once: true })

                    if (this.bufferedEnd >= range_end)
                        this.#source_buffer.onupdateend()
                    else
                        this.#source_buffer.remove(this.bufferedEnd, range_end)
                } else {
                    this.#appending_segment = false
                }
            }

            this.#source_buffer.onupdateend = appendSegment
            this.start()
        })
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

    get bufferedEnd() {
        if (this.buffered.length) {
            for (let i = this.buffered.length - 1; i > -1; i--)
                if (this.#video.currentTime >= this.buffered.start(i) && this.#video.currentTime <= this.buffered.end(i))
                    return this.buffered.end(i)
        }

        return 0
    }

    get #continue() {
        return this.#video.currentTime > (this.bufferedEnd - 5) && this.bufferedEnd < this.duration
    }

    start() {
        if (!this.#loading && this.#continue) {
            this.#loading = true
            this.#start = this.#video.currentTime

            this.#nextSegment()
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

    #getResolution(speed) {
        this.#resolution = Math.max(this.#video_metadata.bitrates.findLastIndex(bitrate => bitrate * 2.2 < speed), 0)
    }

    #setTimeout(key, abort_controller) {
        if (this[key])
            return setTimeout(() => {
                this[key] = 0
                this.#length = Math.round(Math.max(this.#length / 2, this.#min_chunk_size))

                abort_controller.abort("Request timeout : Certainly due to a change in connection speed.")
                this.#nextSegment()
            }, this[key] * 2)
        else
            return null
    }

    #clearTimeout(timeout_id) {
        if (timeout_id != null) clearTimeout(timeout_id)
    }

    async #fetch() {
        const start = Math.round(this.#start * 1_000_000_000)
        const end = Math.round(Math.min(this.#start + this.#length, this.duration) * 1_000_000_000)

        if (start == end)
            throw "Request rejected : length of zero"

        const abort_controller = new AbortController()
        const timeout_id = this.#setTimeout("request_latency", abort_controller)
        const t0 = Date.now()
        const response = await fetch(
            `/video/${this.#video_metadata.uuid}/${this.resolution}/${start}/${end}`,
            { signal: abort_controller.signal }
        )
        const t1 = Date.now()

        this.#clearTimeout(timeout_id)

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
        const timeout_id = this.#setTimeout("download_latency", abort_controller)
        const t2 = Date.now()
        const data = await response.arrayBuffer()
        const t3 = Date.now()
        const download_latency = this.download_latency = Math.max(t3 - t2, 1)

        this.#clearTimeout(timeout_id)

        return { data, download_latency, speed: data.byteLength * 1_000 / download_latency }
    }

    #appendSegment(range_start, range_end, data) {
        this.#chunk_buffer.push({ range_start, range_end, data })

        if (!this.#source_buffer.updating && !this.#appending_segment)
            this.#source_buffer.onupdateend()
    }

    async #nextSegment() {
        try {
            const { response, abort_controller, request_latency, range_start, range_end } = await this.#fetch()
            const { data, download_latency, speed } = await this.#read(response, abort_controller)

            this.#log(speed, download_latency, request_latency)
            this.#getResolution(speed)
            this.#start = range_end

            if (this.#continue) {
                this.#length = Math.round(speed / this.length * this.duration)
                this.#length = Math.round(Math.min(Math.max(this.#length, this.#min_chunk_size) + this.#start, this.duration) - this.#start)

                if (this.#length > 0)
                    this.#nextSegment()
                else
                    this.#loading = false
            } else {
                this.#loading = false
            }

            this.#appendSegment(range_start, range_end, data)
        } catch (error) {
            if (typeof error === "string")
                console.warn(error)
            else
                console.error(error)
        }
    }
}