const time_ago = (async () => {
    TimeAgo.addDefaultLocale(await (await fetch("https://unpkg.com/javascript-time-ago@2.5/locale/fr.json")).json())

    return new TimeAgo('fr')
})()

// video description
{
    const vues_element = document.getElementById("vues")

    if (video_metadata.vues >= 0 && video_metadata.vues < 1000)
        vues_element.textContent = video_metadata.vues + (video_metadata.vues > 1 ? " vues" : " vue")
    else if (video_metadata.vues < 1000000)
        vues_element.textContent = (Math.round(video_metadata.vues / 100) / 10) + " k"
    else if (video_metadata.vues < 1000000000)
        vues_element.textContent = (Math.round(video_metadata.vues / 100000) / 10) + " M de vues"
    else
        vues_element.textContent = (Math.round(video_metadata.vues / 100000000) / 10) + " Md de vues"

    const time_element = document.getElementById("time")

    time_ago.then(time_ago => time_element.textContent = time_ago.format(video_metadata.date.valueOf()))
}