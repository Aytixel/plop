import "/component/video-player/video-player.mjs"
import { formatVues } from "./utils/vues.mjs"
import { VideoSource } from "./video-source.mjs"

TimeAgo.addDefaultLocale(await (await fetch("https://unpkg.com/javascript-time-ago@2.5/locale/fr.json")).json())

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

        this.#show_more.addEventListener("click", () => this.showMore = !this.showMore)
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

    set vues(vues) {
        if (this.#info.vues != vues) {
            this.#vues.textContent = formatVues(vues) || this.#vues.textContent
            this.#info.vues = vues
        }
    }

    get vues() {
        return this.#info.vues
    }
}

window.video_info = new VideoInfo(video_metadata)

// load and manage video stream
const video_player = document.querySelector("video-player").getPlayer(video_metadata)
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