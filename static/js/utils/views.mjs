import { formatCount } from "./count.mjs"

export function formatViews(views) {
    let views_string = formatCount(views)

    return views_string + (views > 1 ? (views >= 1000000 ? " de vues" : " vues") : " vue")
}