export function formatDuration(duration) {
    const string = `${Math.floor(duration / 60 % 60)}:${(Math.round(duration) % 60).toString().padStart(2, 0)}`

    return duration >= 3600 ? Math.floor(duration / 3600) + ":" + string.padStart(5, 0) : string
}