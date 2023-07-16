let running = false
let queue = []

async function upload() {
    let chunk

    while (chunk = queue.shift()) {
        await fetch(`/video/${chunk.video_uuid}/${chunk.resolution}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: chunk.data })
    }

    running = false
}

onmessage = e => {
    queue.push(e.data)

    if (!running) {
        running = true

        upload()
    }
}