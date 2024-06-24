export function formatviews(views) {
    if (typeof views === "number") {
        if (views >= 0 && views < 1000)
            return views + (views > 1 ? " views" : " view")
        else if (views < 1000000)
            return (Math.round(views / 100) / 10) + " k views"
        else if (views < 1000000000)
            return (Math.round(views / 100000) / 10) + " M de views"
        else
            return (Math.round(views / 100000000) / 10) + " Md de views"
    }

    return null
}