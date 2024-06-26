import "/component/video-player/video-player.mjs"

// watch together
const video_player_element = document.querySelector("video-player")
const video_player = video_player_element.getPlayer({ live: true })
const peer = new Peer()

peer.on("open", () => {
    const connection = peer.connect(video_player_element.dataset.uuid)

    connection.on("open", () => {
        connection.on("data", data => {
            video_player.poster = URL.createObjectURL(new Blob([data], { type: "image/webp" }))
        })
    })

    const canvas = document.createElement("canvas")

    canvas.width = 0
    canvas.height = 0

    const call = peer.call(video_player_element.dataset.uuid, canvas.captureStream(1))

    call.on("stream", stream => video_player.srcObject = stream)
})

