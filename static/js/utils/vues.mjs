export function formatVues(vues) {
    if (typeof vues === "number") {
        if (vues >= 0 && vues < 1000)
            return vues + (vues > 1 ? " vues" : " vue")
        else if (vues < 1000000)
            return (Math.round(vues / 100) / 10) + " k vues"
        else if (vues < 1000000000)
            return (Math.round(vues / 100000) / 10) + " M de vues"
        else
            return (Math.round(vues / 100000000) / 10) + " Md de vues"
    }

    return null
}