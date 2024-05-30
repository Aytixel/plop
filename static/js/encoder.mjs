import { Muxer, StreamTarget } from "https://cdn.jsdelivr.net/npm/webm-muxer@3.1/+esm"

function encodeAudio(url, audio_config, callback) {
    return new Promise((resolve, reject) => {
        const video = document.createElement("video")

        video.src = url
        video.addEventListener("loadedmetadata", async () => {
            const audio_encoder = new AudioEncoder({
                output: callback,
                error: reject,
            })

            audio_config = Object.assign(audio_config, {
                codec: "opus",
                bitrate: 128000
            })

            console.log(audio_config)

            audio_encoder.configure(audio_config)

            const audio_processor = new MediaStreamTrackProcessor(video.audioTracks[0])
            const audio_reader = audio_processor.readable.getReader()

            video.play()

            while (true) {
                const result = await audio_reader.read()

                if (result.done)
                    break

                const audio_data = result.value

                audio_encoder.encode(audio_data)
                audio_data.close()
            }

            audio_encoder.close()

            resolve()
        })
    })
}

const encoding_bitrate_multiplier = 0.12

function encodeVideo(url, encode_options_list, callback) {
    return new Promise((resolve, reject) => {
        console.log(encode_options_list)

        const video = document.createElement("video")

        video.src = url
        video.addEventListener("loadedmetadata", async () => {
            let audio_config

            // setup audio encoder
            if (video.audioTracks.length) {
                const audio_processor = new MediaStreamTrackProcessor(video.audioTracks[0])
                const audio_reader = audio_processor.readable.getReader()

                video.play()

                const audio_data = (await audio_reader.read()).value

                video.pause()

                video.currentTime = 0
                audio_config = {
                    numberOfChannels: audio_data.numberOfChannels,
                    sampleRate: audio_data.sampleRate
                }
            }

            // setup video encoder and the muxer
            for (const key in encode_options_list) {
                const muxer_config = {
                    target: new StreamTarget(
                        (data, position) => {
                            callback({
                                resolution: encode_options_list[key].resolution,
                                position,
                                data: data.buffer.slice(0, data.byteLength)
                            })
                        },
                        () => {
                            setTimeout(() => callback({ resolution: encode_options_list[key].resolution }), 100)
                            console.log(`${encode_options_list[key].resolution}p encoding finished`)
                        },
                        {
                            chunked: true,
                            chunkSize: 1_500_000
                        }
                    ),
                    video: {
                        codec: "V_VP9",
                        width: encode_options_list[key].width,
                        height: encode_options_list[key].height,
                        frameRate: encode_options_list[key].framerate,
                        alpha: false
                    },
                    streaming: true,
                    type: "webm"
                }

                if (video.audioTracks.length)
                    muxer_config.audio = Object.assign({ ...audio_config }, {
                        codec: "A_OPUS"
                    })

                const muxer = new Muxer(muxer_config)
                const video_encoder = new VideoEncoder({
                    output: (chunk, metadata) => muxer.addVideoChunk(chunk, metadata),
                    error: reject,
                })
                const video_encoder_config = {
                    codec: "vp09.02.10.10.01",
                    width: encode_options_list[key].width,
                    height: encode_options_list[key].height,
                    bitrate: encode_options_list[key].width * encode_options_list[key].height * encode_options_list[key].framerate * encoding_bitrate_multiplier,
                    framerate: encode_options_list[key].framerate
                }
                let video_encoder_configured = false

                async function testVideoEncoderConfig(hardware_acceleration) {
                    video_encoder_config.hardwareAcceleration = hardware_acceleration

                    if (!video_encoder_configured && (await VideoEncoder.isConfigSupported(video_encoder_config)).supported) {
                        video_encoder_configured = true
                        video_encoder.configure(video_encoder_config)
                    }
                }

                await testVideoEncoderConfig("prefer-hardware")
                await testVideoEncoderConfig("prefer-software")

                if (!video_encoder_configured) {
                    reject("No configuration found")

                    return
                }

                encode_options_list[key].muxer = muxer
                encode_options_list[key].video_encoder = video_encoder
                encode_options_list[key].timestamp = 0
            }

            let audio_encoder

            // start audio encoding
            if (video.audioTracks.length) {
                let start_timestamp = -1

                audio_encoder = encodeAudio(url, audio_config, (chunk, metadata) => {
                    if (start_timestamp == -1)
                        start_timestamp = chunk.timestamp

                    for (const encode_options of encode_options_list) {
                        encode_options.muxer.addAudioChunk(chunk, metadata, chunk.timestamp - start_timestamp)
                    }
                })
            }

            // start video encoding
            const canvas = document.createElement("canvas")
            const canvas_context = canvas.getContext("2d")
            let frame_count = 0
            const duration = Math.round(video.duration * 1_000_000)
            const high_encode_options = encode_options_list[encode_options_list.length - 1]

            canvas.width = video.videoWidth
            canvas.height = video.videoHeight

            async function encodeFrame() {
                console.log(`Time : ${video.currentTime}s`)

                frame_count++

                canvas_context.clearRect(0, 0, canvas.width, canvas.height)
                canvas_context.drawImage(video, 0, 0)

                const video_frame = new VideoFrame(canvas, {
                    timestamp: high_encode_options.timestamp,
                    duration
                })

                for (const encode_options of encode_options_list) {
                    if (
                        high_encode_options.framerate == encode_options.framerate
                        || (video.currentTime * 1_000_000) >= encode_options.timestamp
                    ) {
                        encode_options.timestamp = Math.min(encode_options.timestamp + Math.round(1_000_000 / encode_options.framerate), duration)

                        encode_options.video_encoder.encode(video_frame, {
                            keyFrame: frame_count % encode_options.framerate == 0
                        })
                    }
                }

                video_frame.close()

                if (high_encode_options.video_encoder.encodeQueueSize > 4)
                    await high_encode_options.video_encoder.flush()

                if (video.currentTime != video.duration) {
                    video.currentTime = high_encode_options.timestamp / 1_000_000

                    return
                }

                // ending frame
                for (const encode_options of encode_options_list) {
                    if (encode_options.video_encoder.state != "closed")
                        encode_options.video_encoder.close()

                    encode_options.muxer.finalize()
                }

                await audio_encoder

                console.timeEnd("Encode time")
                console.log(`Frame count : ${frame_count}`)
                video.removeEventListener("timeupdate", encodeFrame)

                resolve()
            }

            video.addEventListener("timeupdate", encodeFrame)

            console.time("Encode time")

            video.currentTime = 0
        })
    })
}

export default encodeVideo