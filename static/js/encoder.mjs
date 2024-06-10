import { Muxer, StreamTarget } from "https://cdn.jsdelivr.net/npm/webm-muxer@3.1/+esm"

if ("mozCaptureStream" in HTMLMediaElement.prototype)
    HTMLMediaElement.prototype.captureStream = HTMLMediaElement.prototype.mozCaptureStream

class EncodingDataEvent extends Event {
    resolution
    position
    data

    constructor(resolution, position, data) {
        super("encodingdata")

        this.resolution = resolution
        this.position = position
        this.data = data
    }
}

class EncodingEndedEvent extends Event {
    resolution

    constructor(resolution) {
        super("encodingended")

        this.resolution = resolution
    }
}

class EncodingProgress extends Event {
    type
    encoding
    duration

    constructor(type, encoding, duration) {
        super("encodingprogress")

        this.type = type
        this.encoding = encoding
        this.duration = duration
    }
}

class VideoFrameEvent extends Event {
    resolution
    chunk
    metadata

    constructor(resolution, chunk, metadata) {
        super("videoframe")

        this.resolution = resolution
        this.chunk = chunk
        this.metadata = metadata
    }
}

class AudioFrameEvent extends Event {
    chunk
    metadata

    constructor(chunk, metadata) {
        super("audioframe")

        this.chunk = chunk
        this.metadata = metadata
    }
}

export class Encoder extends EventTarget {
    #bitrate_multiplier = 0.12
    #video
    #url

    constructor() {
        super()
    }

    loadVideo(url) {
        return new Promise(resolve => {
            const video = document.createElement("video")

            video.src = this.#url = url
            video.addEventListener("loadedmetadata", () => {
                this.#video = video
                resolve(this)
            })
        })
    }

    get #videoTracks() {
        return this.#video.captureStream().getVideoTracks() ?? []
    }

    get #audioTracks() {
        return this.#video.captureStream().getAudioTracks() ?? []
    }

    async getVideoEncodeOptionsList() {
        const width = this.#video.videoWidth
        const height = this.#video.videoHeight
        const aspect_ratio = width / height
        const framerate = this.#videoTracks[0].getSettings().frameRate ?? 30

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
        }).filter((encode_options, index) => index == 0 || encode_options.resolution <= Math.min(width, height))
    }

    async #getVideoConfigs(encode_options_list) {
        if (this.#videoTracks.length) {
            const video_configs = []

            for (const encode_options of encode_options_list) {
                const video_encoder_config = {
                    codec: "vp09.02.10.10.01",
                    width: encode_options.width,
                    height: encode_options.height,
                    bitrate: encode_options.width * encode_options.height * encode_options.framerate * this.#bitrate_multiplier,
                    framerate: encode_options.framerate
                }

                for (const hardware_acceleration of ["prefer-hardware", "prefer-software", "no-preference"]) {
                    video_encoder_config.hardwareAcceleration = hardware_acceleration

                    if ((await VideoEncoder.isConfigSupported(video_encoder_config)).supported)
                        break
                }

                video_configs.push(video_encoder_config)
            }

            return video_configs
        }

        return null
    }

    async #getAudioConfig() {
        if (this.#audioTracks.length) {
            const audio_processor = new MediaStreamTrackProcessor(this.#audioTracks[0])
            const audio_reader = audio_processor.readable.getReader()

            this.#video.play()

            const audio_data = (await audio_reader.read()).value

            this.#video.pause()
            this.#video.currentTime = 0

            return {
                numberOfChannels: audio_data.numberOfChannels,
                sampleRate: audio_data.sampleRate,
                codec: "opus",
                bitrate: 128000
            }
        }

        return null
    }

    #getBaseMuxerConfigs(encode_options_list) {
        return encode_options_list.map(encode_options => ({
            target: new StreamTarget(
                (data, position) => this.dispatchEvent(new EncodingDataEvent(encode_options.resolution, position, data.buffer.slice(0, data.byteLength))),
                () => this.dispatchEvent(new EncodingEndedEvent(encode_options.resolution)),
                {
                    chunked: true,
                    chunkSize: 1_500_000
                }
            ),
            streaming: true,
            type: "webm"
        }))
    }

    #getAudioMuxerConfigs(audio_config, encode_options_list) {
        const muxer_configs = this.#getBaseMuxerConfigs(encode_options_list)

        if (this.#audioTracks.length) {
            return muxer_configs.map(muxer_config => {
                muxer_config.audio = Object.assign({}, audio_config)
                muxer_config.audio.codec = "A_OPUS"

                return muxer_config
            })
        }

        return muxer_configs
    }

    #getVideoMuxerConfigs(audio_config, encode_options_list) {
        const muxer_configs = this.#getAudioMuxerConfigs(audio_config, encode_options_list)

        if (this.#videoTracks.length) {
            return muxer_configs.map((muxer_config, index) => {
                muxer_config.video = {
                    codec: "V_VP9",
                    width: encode_options_list[index].width,
                    height: encode_options_list[index].height,
                    frameRate: encode_options_list[index].framerate,
                    alpha: false
                }

                return muxer_config
            })
        }

        return muxer_configs
    }

    #encodeAudio(audio_config) {
        if (audio_config === null)
            return Promise.resolve()

        return new Promise(async (resolve, reject) => {
            const video = document.createElement("video")

            video.src = this.#url
            video.addEventListener("loadedmetadata", async () => {
                const audio_encoder = new AudioEncoder({
                    output: (chunk, metadata) => this.dispatchEvent(new AudioFrameEvent(chunk, metadata)),
                    error: reject,
                })

                audio_encoder.configure(audio_config)

                const audio_processor = new MediaStreamTrackProcessor(video.captureStream().getAudioTracks()[0])
                const audio_reader = audio_processor.readable.getReader()

                video.play()

                while (true) {
                    const result = await audio_reader.read()

                    if (result.done)
                        break

                    const audio_data = result.value

                    audio_encoder.encode(audio_data)
                    audio_data.close()

                    this.dispatchEvent(new EncodingProgress("audio", video.currentTime, video.duration))
                }

                audio_encoder.close()

                resolve()
            })
        })
    }

    #encodeVideo(video_configs, encode_options_list) {
        if (video_configs === null)
            return Promise.resolve()

        return new Promise(async (resolve, reject) => {
            encode_options_list = encode_options_list.map((encode_options, index) => {
                encode_options = Object.assign({}, encode_options)
                encode_options.video_encoder = new VideoEncoder({
                    output: (chunk, metadata) => this.dispatchEvent(new VideoFrameEvent(encode_options.resolution, chunk, metadata)),
                    error: reject,
                })
                encode_options.video_encoder.configure(video_configs[index])
                encode_options.timestamp = 0
                encode_options.frame_count = 0

                return encode_options
            })

            const canvas = new OffscreenCanvas(this.#video.videoWidth, this.#video.videoHeight)
            const canvas_context = canvas.getContext("2d")
            const duration = Math.round(this.#video.duration * 1_000_000)
            const high_encode_options = encode_options_list[encode_options_list.length - 1]

            const encodeFrame = async () => {
                canvas_context.clearRect(0, 0, canvas.width, canvas.height)
                canvas_context.drawImage(this.#video, 0, 0)

                const video_frame = new VideoFrame(canvas, {
                    timestamp: high_encode_options.timestamp,
                    duration
                })

                for (const encode_options of encode_options_list) {
                    if (
                        high_encode_options.framerate == encode_options.framerate
                        || (this.#video.currentTime * 1_000_000) >= encode_options.timestamp
                    ) {
                        encode_options.timestamp = Math.min(encode_options.timestamp + Math.round(1_000_000 / encode_options.framerate), duration)

                        encode_options.video_encoder.encode(video_frame, {
                            keyFrame: encode_options.frame_count++ % encode_options.framerate == 0
                        })
                    }
                }

                video_frame.close()

                this.dispatchEvent(new EncodingProgress("video", this.#video.currentTime, this.#video.duration))

                if (high_encode_options.video_encoder.encodeQueueSize > 4)
                    await high_encode_options.video_encoder.flush()

                if (this.#video.currentTime != this.#video.duration) {
                    this.#video.currentTime = high_encode_options.timestamp / 1_000_000

                    return
                }

                for (const encode_options of encode_options_list) {
                    if (encode_options.video_encoder.state != "closed")
                        encode_options.video_encoder.close()
                }

                this.#video.removeEventListener("timeupdate", encodeFrame)

                resolve()
            }

            this.#video.addEventListener("timeupdate", encodeFrame)
            this.#video.currentTime = 0
        })
    }

    async encodeVideo(encode_options_list) {
        const audio_config = await this.#getAudioConfig()
        const video_configs = await this.#getVideoConfigs(encode_options_list)
        const muxer_configs = this.#getVideoMuxerConfigs(audio_config, encode_options_list)

        console.log(muxer_configs, audio_config, video_configs)

        const encoders = Promise.all([
            this.#encodeAudio(audio_config),
            this.#encodeVideo(video_configs, encode_options_list)
        ])

        muxer_configs.forEach(async (muxer_config, index) => {
            const muxer = new Muxer(muxer_config)
            let start_timestamp = -1

            function video(e) {
                if (e.resolution == encode_options_list[index].resolution)
                    muxer.addVideoChunk(e.chunk, e.metadata)
            }

            function audio(e) {
                if (start_timestamp == -1)
                    start_timestamp = e.chunk.timestamp

                muxer.addAudioChunk(e.chunk, e.metadata, e.chunk.timestamp - start_timestamp)
            }

            if (video_configs)
                this.addEventListener("videoframe", video)

            if (audio_config)
                this.addEventListener("audioframe", audio)

            await encoders

            if (video_configs)
                this.removeEventListener("videoframe", video)

            if (audio_config)
                this.removeEventListener("audioframe", audio)

            muxer.finalize()
        })

        await encoders
    }
}