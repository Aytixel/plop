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
                display: inline-grid;

                aspect-ratio: 16/9;

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

        const img = document.createElement("img")
        const video = document.createElement("video")
        const duration_element = document.createElement("div")

        img.alt = `Miniature de la video`
        img.loading = "lazy"
        img.width = 256
        img.height = 144
        img.src = `/thumbnail/${uuid}`

        video.muted = true
        video.preload = "none"
        video.poster = img.src
        video.width = img.width
        video.height = img.height
        video.src = `/video/${uuid}/144`

        duration_element.textContent = formatDuration(duration)

        shadow.append(video)
        shadow.append(img)
        shadow.append(duration_element)
        shadow.append(style)

        let timeout

        this.addEventListener("pointerover", () => {
            timeout = setTimeout(async () => {
                video.currentTime = 0

                await video.play()

                img.style.display = "none"

                timeout = null
            }, 500)
        })
        this.addEventListener("pointerout", () => {
            if (!timeout) {
                if (!video.paused) {
                    video.pause()

                    img.style.display = ""
                }
            } else {
                clearTimeout(timeout)

                timeout = null
            }
        })
        this.addEventListener("click", () => window.location = `/watch/${uuid}` + (video.paused ? "" : `?t=${video.currentTime}`), { capture: true })
    }
}

customElements.define("video-preview", VideoPreviewElement)