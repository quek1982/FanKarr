// Fausse API Fankai (metadata.fankai.fr) construite à partir du faux catalogue
import https from 'node:https'
import fs from 'node:fs'

const sd = JSON.parse(fs.readFileSync('/work/catalog/series/9001.json', 'utf8'))
const serie = { id: sd.id, title: sd.title, show_title: sd.show_title, genres: 'Test', images: {}, poster_image: null, fanart_image: null }
const seasons = sd.seasons.map(s => ({ id: s.id, season_number: s.season_number, title: s.title, images: {} }))
const episodes = Object.fromEntries(sd.seasons.map(s => [s.id, s.episodes.map(e => ({
    id: e.id, episode_number: e.episode_number, title: e.title, aired: e.aired, season_id: s.id,
    formatted_name: e.formatted_name, nfo_filename: e.nfo_filename, original_filename: e.original_filename,
}))]))

const routes = {
    '/series': [serie],
    [`/series/${sd.id}`]: serie,
    [`/series/${sd.id}/seasons`]: { seasons },
    ...Object.fromEntries(Object.entries(episodes).map(([id, eps]) => [`/seasons/${id}/episodes`, { episodes: eps }])),
}

https.createServer({ key: fs.readFileSync('/cert/key.pem'), cert: fs.readFileSync('/cert/cert.pem') }, (req, res) => {
    const body = routes[req.url.split('?')[0]]
    console.log(`${req.method} ${req.url} → ${body ? 200 : 404}`)
    res.writeHead(body ? 200 : 404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body ?? { error: 'not found' }))
}).listen(443, () => console.log('fausse API Fankai sur :443'))
