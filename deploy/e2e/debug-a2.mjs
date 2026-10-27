// Diagnostic : un épisode, puis un deuxième du même pack ; état de rTorrent seconde par seconde
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { DIR, RTORRENT, SEEDER, TORRENTS, api, rpc, rtList, rtFiles, scalars, sleep, waitFor } from './lib.mjs'
import { setup } from './setup.mjs'

const { T1 } = TORRENTS
const H = T1.infohash.toUpperCase()
const compose = (...a) => execFileSync('docker', ['compose', '-f', path.join(DIR, 'docker-compose.yml'), ...a], { stdio: 'pipe' }).toString()
compose('rm', '-sf', 'fankarr', 'rtorrent', 'proxy')
for (const v of ['downloads', 'rtorrent-data', 'fankarr-config']) { try { execFileSync('docker', ['volume', 'rm', `fankarr-e2e_${v}`], { stdio: 'pipe' }) } catch {} }
compose('up', '-d', 'fankarr', 'rtorrent', 'proxy')
await waitFor('FanKarr', async () => (await api('GET', '/api/auth/status')).status === 200, 60_000)
await waitFor('rTorrent', async () => { await rtList(RTORRENT); return true }, 90_000)
for (const t of await rtList(SEEDER)) await rpc(SEEDER, 'd.tracker_announce', [t.hash.toUpperCase()])
await setup()

const ep = async id => { for (const s of (await api('GET', '/api/series/9001')).data.seasons) for (const e of s.episodes) if (e.id === id) return e.torrent }
const dl = async t => api('POST', '/api/download', { torrent_url: t.torrent_url, magnet: t.magnet, file_index: t.file_index, file_path: t.file_path, infohash: t.infohash, serie_id: 9001 })
const state = async () => {
    const q = async m => scalars(await rpc(RTORRENT, m, [H]))[0]
    const f = await rtFiles(RTORRENT, T1.infohash)
    return `peers=${await q('d.peers_connected')} actif=${await q('d.is_active')} ouvert=${await q('d.is_open')} state=${await q('d.state')} complete=${await q('d.complete')} partiel=${await q('d.is_partially_done').catch(() => '?')} fichiers=${f.map(x => `${x.priority}${x.done ? '✓' : '·'}`).join(' ')}`
}

await dl(await ep(900102))
await waitFor('E02', async () => (await rtFiles(RTORRENT, T1.infohash))[2]?.done, 60_000)
console.log('E02 terminé :', await state())
await sleep(3000)
console.log('3 s après    :', await state())
await dl(await ep(900103))
const t0 = Date.now()
for (let i = 0; i < 40; i++) {
    await sleep(10_000)
    const s = await state()
    console.log(`+${Math.round((Date.now() - t0) / 1000)}s`.padEnd(7), s)
    if (/1✓ 1✓$/.test(s)) break
}
