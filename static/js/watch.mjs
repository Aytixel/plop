import "/component/video-player/video-player.mjs"
import { formatViews } from "./utils/views.mjs"
import { formatDuration } from "./utils/duration.mjs"
import { formatCount } from "./utils/count.mjs"
import { VideoSource } from "./video-source.mjs"

TimeAgo.addDefaultLocale(await (await fetch("https://unpkg.com/javascript-time-ago@2.5/locale/fr.json")).json())

const time_ago = new TimeAgo('fr')

class VideoInfo {
    #description = document.getElementById("video_info_description")
    #views = document.getElementById("video_info_views")
    #likes = document.getElementById("video_info_likes")
    #watch_together = document.getElementById("video_info_watch_together")
    #share = document.getElementById("video_info_share")
    #share_dialog = {
        dialog: document.getElementById("video_info_share_dialog"),
        close: document.getElementById("video_info_share_close"),
        link: document.getElementById("video_info_share_link"),
        copy: document.getElementById("video_info_share_copy"),
        start_at: document.getElementById("video_info_share_start_at"),
    }
    #time = document.getElementById("video_info_time")
    #show_more = document.getElementById("video_info_show_more")

    #info = {
        show_more: false,
        date: null,
        views: null,
        likes: null,
        liked: null,
    }

    constructor(video_metadata, video_player) {
        this.date = video_metadata.date
        this.views = video_metadata.views
        this.likes = video_metadata.likes
        this.liked = video_metadata.liked

        this.#show_more.addEventListener("click", () => this.showMore = !this.showMore)
        this.#likes.addEventListener("click", async () => {
            if (this.liked) {
                await this.removeLike()
                this.likes -= 1
                this.liked = false
            } else {
                await this.addLike()
                this.likes += 1
                this.liked = true
            }
        })

        let shared = false

        function sendShareFeedback() {
            if (!shared) {
                shared = true

                fetch(`/share/${video_metadata.uuid}`, { method: "post" })
            }
        }

        let watch_together_url = ""

        this.#watch_together.addEventListener("click", () => {
            if (!watch_together_url.length) {
                const peer = new Peer()
                const stream = video_player.captureStream()
                const canvas = new OffscreenCanvas(video_player.videoWidth, video_player.videoHeight)
                const context = canvas.getContext("2d")

                sendShareFeedback()

                if ("mozCaptureStream" in HTMLMediaElement.prototype) {
                    const audio_context = new AudioContext()
                    const media_stream_source = audio_context.createMediaStreamSource(stream)

                    media_stream_source.connect(audio_context.destination)
                }

                peer.on("open", id => {
                    this.#watch_together.children[0].style.display = "none"
                    this.#watch_together.children[1].style.display = "block"
                    watch_together_url = `${location.origin}/together/${id}`

                    navigator.clipboard.writeText(watch_together_url)
                })
                peer.on("connection", connection => {
                    connection.on("open", async () => {
                        context.drawImage(video_player.video, 0, 0)

                        connection.send(await canvas.convertToBlob({ type: "image/webp", quality: 0.85 }))
                    })
                })
                peer.on("call", call => call.answer(stream))
            }

            navigator.clipboard.writeText(watch_together_url)
        })

        const update_link = () => this.#share_dialog.link.value = `${location.origin}/watch/${video_metadata.uuid}${this.#share_dialog.start_at.checked ? `&t=${video_player.currentTime}` : ""}`
        const close_dialog = () => this.#share_dialog.dialog.close()

        this.#share.addEventListener("click", () => {
            sendShareFeedback()
            update_link()
            this.#share_dialog.start_at.nextSibling.nextSibling.textContent = formatDuration(video_player.currentTime)
            this.#share_dialog.dialog.showModal()
        })
        this.#share_dialog.start_at.addEventListener("input", update_link)
        this.#share_dialog.close.addEventListener("click", close_dialog)
        this.#share_dialog.dialog.addEventListener("click", e => {
            const rect = this.#share_dialog.dialog.getBoundingClientRect()

            if (e.clientY < rect.top || e.clientY > rect.bottom || e.clientX < rect.left || e.clientX > rect.right)
                close_dialog()
        })
        this.#share_dialog.copy.addEventListener("click", () => navigator.clipboard.writeText(this.#share_dialog.link.value))
    }

    async addLike() {
        return fetch(`/like/${video_metadata.uuid}`, { method: "post" })
    }

    async removeLike() {
        return fetch(`/like/${video_metadata.uuid}`, { method: "delete" })
    }

    set showMore(show_more) {
        if (this.#info.show_more != !!show_more) {
            const content = this.#show_more.textContent

            this.#show_more.textContent = this.#show_more.dataset.switch_content
            this.#show_more.dataset.switch_content = content
            this.#description.classList.toggle("open")
            this.#info.show_more = !!show_more
        }
    }

    get showMore() {
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

    set views(views) {
        if (this.#info.views != views) {
            this.#views.textContent = formatViews(views) || this.#views.textContent
            this.#info.views = views
        }
    }

    get views() {
        return this.#info.views
    }

    set likes(likes) {
        if (this.#info.likes != likes) {
            this.#likes.children[2].textContent = formatCount(likes) || this.#likes.textContent
            this.#info.likes = likes
        }
    }

    get likes() {
        return this.#info.likes
    }

    set liked(liked) {
        if (this.#info.liked != liked) {
            this.#likes.children[0].style.display = liked ? "none" : "block"
            this.#likes.children[1].style.display = liked ? "block" : "none"
            this.#info.liked = liked
        }
    }

    get liked() {
        return this.#info.liked
    }
}

// load and manage video stream
const video_player = document.querySelector("video-player").getPlayer(Object.assign({
    fullscreen_element: document.getElementById("main_container")
}, video_metadata))

window.video_info = new VideoInfo(video_metadata, video_player)

const response = await fetch(`/thumbnail/${video_metadata.uuid}`)
const t0 = Date.now()
const data = await response.blob()
const t1 = Date.now()

video_player.poster = URL.createObjectURL(data)

const video_source = new VideoSource(video_player, video_metadata, data.size * 1_000 / Math.max(t1 - t0, 1))

video_player.addEventListener("loadedmetadata", () => video_player.play())

video_player.src = URL.createObjectURL(video_source)
video_player.preview = `/video/${video_metadata.uuid}/${video_metadata.resolutions[0]}`

window.video_source = video_source
window.video_player = video_player