export function formatCount(count) {
    if (typeof count === "number") {
        if (count >= 0 && count < 1000)
            return count.toString()
        else if (count < 1000000)
            return (Math.round(count / 100) / 10) + " k"
        else if (count < 1000000000)
            return (Math.round(count / 100000) / 10) + " M"
        else
            return (Math.round(count / 100000000) / 10) + " Md"
    }

    return null
}