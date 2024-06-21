import { formatDuration } from "/js/utils/duration.mjs"

class VideoPreviewElement extends HTMLElement {
    constructor() {
        super()
    }

    connectedCallback() {
        const uuid = this.dataset.uuid
        const duration = +this.dataset.duration
        const shadow = this.attachShadow({ mode: "open" })
        const style = document.createElement("style")

        style.textContent += /*css*/`
            :host {
                display: inline-block;

                aspect-ratio: 16/9;
            }

            a {
                display: inline-grid;

                aspect-ratio: 16/9;

                width: 100%;
                height: 100%;

                border: solid .1em rgb(var(--color-dark) / .1);
                border-radius: .5em;

                overflow: hidden;

                cursor: pointer;
            }

            video, img {
                grid-column: 1;
                grid-row: 1;

                min-width: 0;
                width: 100%;
                min-height: 0;
                height: 100%;
            }

            img {
                object-fit: contain;
            }

            div {
                position: absolute;
                right: 1em;
                bottom: 1em;

                padding: .2em .4em;

                border-radius: .5em;

                color: rgb(var(--color-fixed-light));

                font-size: .8rem;

                background-color: rgb(var(--color-fixed-dark) / .7);
            }
        `

        const link = document.createElement("a")
        const img = document.createElement("img")
        const video = document.createElement("video")
        const duration_element = document.createElement("div")

        link.href = `/watch/${uuid}`

        img.alt = `Miniature de la video`
        img.loading = "lazy"
        img.width = 256
        img.height = 144
        img.src = `/thumbnail/${uuid}`

        video.hidden = true
        video.muted = true
        video.preload = "none"
        video.poster = img.src
        video.width = img.width
        video.height = img.height
        video.src = `/video/${uuid}/144`

        duration_element.textContent = formatDuration(duration)

        link.append(video)
        link.append(img)
        link.append(duration_element)
        shadow.append(link)
        shadow.append(style)

        let timeout

        function update_link() {
            link.href = `/watch/${uuid}?t=${video.currentTime}`
        }

        this.addEventListener("pointerover", () => {
            timeout = setTimeout(async () => {
                video.currentTime = 0

                video.addEventListener("timeupdate", update_link)
                await video.play()

                img.hidden = true
                video.hidden = false

                timeout = null
            }, 500)
        })
        this.addEventListener("pointerout", () => {
            if (!timeout) {
                if (!video.paused) {
                    video.removeEventListener("timeupdate", update_link)
                    video.pause()

                    link.href = `/watch/${uuid}`
                    img.hidden = false
                    video.hidden = true
                }
            } else {
                clearTimeout(timeout)

                timeout = null
            }
        })
    }
}

customElements.define("video-preview", VideoPreviewElement)