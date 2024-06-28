onmessage = e => {
    const chunk = e.data
    const headers = new Headers({ "content-type": "application/octet-stream" })

    if ("position" in chunk)
        headers.set("Range", `bytes=${chunk.position}-`)

    fetch(`/upload/${chunk.video_uuid}/${chunk.resolution}`, { method: "POST", headers, body: chunk.data })

    postMessage(chunk.resolution)
}