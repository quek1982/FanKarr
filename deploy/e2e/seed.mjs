// Charge les torrents de test dans le seeder et attend qu'il les partage
import { SEEDER, TORRENTS, rpc, rtList, waitFor } from './lib.mjs'

const slugs = { T1: 'saga01', T2: 'integrale', T3: 'single05' }
const have  = new Set((await rtList(SEEDER)).map(t => t.hash))
for (const [k, t] of Object.entries(TORRENTS)) {
    if (have.has(t.infohash)) continue
    await rpc(SEEDER, 'load.start', ['', `http://catalog/torrents/${slugs[k]}.torrent`, 'd.directory.set=/seed'])
    console.log(`${k} chargé dans le seeder`)
}
const list = await waitFor('seeder complet', async () => {
    const l = await rtList(SEEDER)
    return l.length === 3 && l.every(t => t.complete === 1) ? l : false
}, 60_000)
for (const t of list) console.log(`  ${t.hash.slice(0, 8)} complet=${t.complete} actif=${t.active} ${t.directory}`)
