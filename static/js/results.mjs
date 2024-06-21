import "/component/video-preview/video-preview.mjs"
import { formatVues } from "./utils/vues.mjs"

TimeAgo.addDefaultLocale(await (await fetch("https://unpkg.com/javascript-time-ago@2.5/locale/fr.json")).json())

const time_ago = new TimeAgo('fr')

function update_video_list_item(video) {
    const vues_element = video.getElementsByClassName("vues")[0]

    vues_element.textContent = formatVues(+vues_element.textContent)

    const date_element = video.getElementsByTagName("time")[0]

    date_element.textContent = time_ago.format(new $mol_time_moment(date_element.dateTime).valueOf())
}

const video_list_element = document.getElementById("video_list")

for (const video of video_list_element.children) {
    update_video_list_item(video)
}