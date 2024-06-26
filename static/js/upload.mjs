import "/component/video-player/video-player.mjs"
import "/component/video-preview/video-preview.mjs"
import { formatViews } from "./utils/views.mjs"
import { Encoder } from "./encoder.mjs"

TimeAgo.addDefaultLocale(await (await fetch("https://unpkg.com/javascript-time-ago@2.5/locale/fr.json")).json())

const time_ago = new TimeAgo('fr')

function isCompatible() {
    return "AudioEncoder" in window && "VideoEncoder" in window
}

// video list
const video_list_select_all_element = document.getElementById("video_list_select_all")
const video_list_delete_element = document.getElementById("video_list_delete")
const video_list_element = document.getElementById("video_list")

video_list_select_all_element.addEventListener("input", () => {
    for (const video_list_item_element of video_list_element.children) {
        video_list_item_element.children[0].classList.toggle("active", video_list_select_all_element.checked)
    }
})

video_list_delete_element.addEventListener("click", async () => {
    const video_list = [...video_list_element.children].map(video => video.children[0]).filter(video => video.classList.contains("active"))
    const response = await fetch("/upload", {
        method: "DELETE",
        body: JSON.stringify({ uuids: video_list.map(video => video.dataset.uuid) })
    })

    video_list_select_all_element.checked = false

    if (!response.ok)
        alert("Une erreur est survenue : action annuler.")

    const json = await response.json()

    video_list.forEach(video => json.uuids.includes(video.dataset.uuid) && video.remove())
})

function video_list_item_element_add_event(video_list_item_element) {
    video_list_item_element.addEventListener("click", () => {
        video_list_select_all_element.checked = false
        video_list_item_element.children[0].classList.toggle("active")
    })
}

for (const video of video_list_element.children) {
    const views_element = video.getElementsByClassName("views")[0]

    views_element.textContent = formatViews(+views_element.dataset.views)

    const date_element = video.getElementsByTagName("time")[0]

    date_element.textContent = time_ago.format(new $mol_time_moment(date_element.dateTime).valueOf())

    video_list_item_element_add_event(video)
}

// video upload form
const header_element = document.getElementsByTagName("header")[0]

header_element.children[1].hidden = !(header_element.children[0].hidden = isCompatible())

const thumbnail_element = document.getElementById("thumbnail")
const thumbnail_filepicker_element = document.getElementById("thumbnail_filepicker")

function encodeThumbnail(url) {
    return new Promise(resolve => {
        const canvas = document.createElement("canvas")
        const canvas_context = canvas.getContext("2d")
        const image = document.createElement("img")

        image.src = url
        image.onload = () => {
            const aspect_ratio = image.naturalWidth / image.naturalHeight
            let width
            let height

            if (aspect_ratio > 1) {
                width = Math.round(480 * aspect_ratio)
                height = 480
            } else {
                width = 480
                height = Math.round(480 / aspect_ratio)
            }

            canvas.width = width
            canvas.height = height
            canvas_context.drawImage(image, 0, 0, width, height)

            resolve(canvas.toDataURL("image/webp", 0.85))
        }
    })
}

thumbnail_filepicker_element.addEventListener("input", async () => {
    if (thumbnail_filepicker_element.files.length > 0)
        thumbnail_element.src = await encodeThumbnail(URL.createObjectURL(thumbnail_filepicker_element.files[0]))
})

const video_element = document.querySelector("video-player").getPlayer({ ambient_light: false })
const video_filepicker_element = document.getElementById("video_filepicker")

video_filepicker_element.addEventListener("input", () => {
    if (video_filepicker_element.files.length > 0)
        video_element.preview = video_element.src = URL.createObjectURL(video_filepicker_element.files[0])
})

const video_upload_form_element = document.getElementById("video_upload_form")
let uploading_video = false

video_upload_form_element.addEventListener("submit", async e => {
    e.preventDefault()

    if (!isCompatible() || uploading_video)
        return;

    uploading_video = true

    const encoder = await new Encoder().loadVideo(video_element.src)
    const video_encode_options_list = await encoder.getVideoEncodeOptionsList()
    const form_data = new FormData(video_upload_form_element)
    const params = {
        title: form_data.get("title"),
        framerate: video_encode_options_list[video_encode_options_list.length - 1].framerate,
        duration: video_element.duration,
        resolutions: video_encode_options_list.map(video_encode_options => video_encode_options.resolution),
        thumbnail: thumbnail_element.src,
        has_audio: !!video_element.captureStream().getAudioTracks().length
    }

    if (form_data.get("description").length)
        params.description = form_data.get("description")

    if (form_data.get("tags").length)
        params.tags = form_data.get("tags")

    const video_uuid = await (await fetch("/upload", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(params) })).text()
    const worker = [new Worker("/js/upload-worker.js"), new Worker("/js/upload-worker.js")]
    const progress_elements = {
        video: document.getElementById("video_progress"),
        audio: document.getElementById("audio_progress"),
    }
    const video_upload_progress = document.getElementById("video_upload_progress")

    const video_list_item_element = document.createElement("li")
    const video_button_element = document.createElement("button")

    video_button_element.tabIndex = 0
    video_button_element.ariaLabel = form_data.get("title")
    video_button_element.dataset.uuid = video_uuid
    video_list_item_element_add_event(video_list_item_element)
    video_list_item_element.prepend(video_button_element)

    const video_preview_element = document.createElement("video-preview")

    video_preview_element.dataset.uuid = video_uuid
    video_preview_element.dataset.duration = video_element.duration
    video_button_element.append(video_preview_element)

    const top_element = document.createElement("div")

    top_element.classList.add("top")
    video_button_element.append(top_element)

    const title_element = document.createElement("span")

    title_element.classList.add("title")
    title_element.textContent = form_data.get("title")
    top_element.append(title_element)

    const views_element = document.createElement("span")

    views_element.classList.add("views")
    views_element.textContent = formatViews(0)
    top_element.append(views_element)

    const time_element = document.createElement("time")

    time_element.dateTime = new Date().toISOString()
    time_element.textContent = time_ago.format(new $mol_time_moment().valueOf())
    top_element.append(time_element)

    const bottom_element = document.createElement("div")

    bottom_element.classList.add("bottom")
    video_button_element.append(bottom_element)
    video_list_element.prepend(video_list_item_element)

    const resolution_elements = {}

    for (const resolution of [144, 240, 360, 480, 720, 1080, 1440]) {
        const resolution_element = document.createElement("span")
        const is_encoding_resolution = video_encode_options_list.find(video_encode_options => video_encode_options.resolution == resolution) !== undefined

        resolution_element.textContent = `${resolution}p ${is_encoding_resolution ? "⚠️" : "🚫"}`
        resolution_elements[resolution] = resolution_element
        bottom_element.append(resolution_element)
    }

    encoder.addEventListener("encodingdata", e => {
        const chunk = {
            resolution: e.resolution,
            position: e.position,
            data: e.data,
            video_uuid
        }

        worker[0].postMessage(chunk, [chunk.data])
        worker.reverse()
    })
    encoder.addEventListener("encodingended", e => {
        setTimeout(() => {
            const chunk = {
                resolution: e.resolution,
                video_uuid
            }

            resolution_elements[e.resolution].textContent = `${e.resolution}p ✅`
            worker[0].postMessage(chunk)
            worker.reverse()
        }, 200)
    })
    encoder.addEventListener("encodingprogress", e => {
        const progress_element = progress_elements[e.type]

        video_upload_progress.hidden = false
        progress_element.parentElement.hidden = false
        progress_element.value = Math.round(e.encoding * 1_000)
        progress_element.max = Math.round(e.duration * 1_000)
    })

    await encoder.encodeVideo(video_encode_options_list)

    video_upload_progress.hidden = true

    for (const key in progress_elements) {
        const progress_element = progress_elements[key]

        progress_element.parentElement.hidden = true
        progress_element.value = 0
        progress_element.max = 1
    }

    console.log("Upload finished : " + video_uuid)

    uploading_video = false
})