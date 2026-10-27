// Scénario de bout en bout FanKarr + rTorrent. Repart d'un état vierge.
//   node deploy/e2e/test.mjs
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { DIR, RTORRENT, SEEDER, TORRENTS, api, rpc, rtList, rtFiles, sh, sleep, waitFor } from './lib.mjs'
import { setup } from './setup.mjs'

const { T1, T2, T3 } = TORRENTS
const MEDIA = '/downloads/media/Test Kai'
const DL    = '/downloads/temp'
const media = (s, e) => `${MEDIA}/Saison ${s}/Test Kai.S0${s}E0${e}.MULTI.1080p.x264-FANKAI.mkv`

// ── Rapport ───────────────────────────────────────────────────
const results = []
let section = ''
function check(label, ok, detail = '') {
    results.push({ section, label, ok: !!ok, detail })
    console.log(`${ok ? '  ✔' : '  ✘'} ${label}${!ok && detail ? `\n      → ${detail}` : ''}`)
    return !!ok
}
async function step(name, fn) {
    section = name
    console.log(`\n■ ${name}`)
    try { await fn() } catch (err) { check('étape terminée sans erreur', false, err.message) }
}

// ── Outils ────────────────────────────────────────────────────
const compose = (...args) => execFileSync('docker', ['compose', '-f', path.join(DIR, 'docker-compose.yml'), ...args], { stdio: 'pipe' })
const exists  = p => sh('fankarr', `test -e "${p}" && echo oui || echo non`) === 'oui'
const links   = p => Number(sh('fankarr', `stat -c %h "${p}" 2>/dev/null || echo 0`))
const inRt    = async hash => (await rtList(RTORRENT)).find(t => t.hash === hash)

async function serie() { return (await api('GET', '/api/series/9001')).data }
async function epTorrent(epId) {
    for (const s of (await serie()).seasons) for (const e of s.episodes) if (e.id === epId) return e.torrent
    throw new Error(`épisode ${epId} introuvable`)
}
async function download(t) {
    const r = await api('POST', '/api/download', { torrent_url: t.torrent_url, magnet: t.magnet, file_index: t.file_index ?? null, file_path: t.file_path ?? null, infohash: t.infohash ?? null, serie_id: 9001 })
    if (r.status !== 200) throw new Error(`téléchargement : ${r.status} ${JSON.stringify(r.data)}`)
}
async function fkTorrent(hash) {
    const r = await api('GET', '/api/downloads')
    return Array.isArray(r.data) ? r.data.find(t => t.hash === hash) : undefined
}
async function waitDone(hash, label) {
    return waitFor(`${label} terminé côté FanKarr`, async () => {
        const t = await fkTorrent(hash)
        return t && t.state === 'seeding' && t.progress === 100 ? t : false
    }, 90_000)
}
async function importNow(hash) {
    const t = await fkTorrent(hash)
    if (!t) throw new Error('torrent absent de /api/downloads')
    return (await api('POST', '/api/organize', { hash: t.hash, name: t.name, save_path: t.save_path })).data
}
async function organizedIds() {
    const s = await serie()
    return new Set(s.seasons.flatMap(x => x.episodes).filter(e => e.organized).map(e => e.id))
}
async function fkLogs(pattern, levels = null) {
    const r = await api('GET', '/api/logs?limit=1000')
    const lines = Array.isArray(r.data) ? r.data : (r.data?.logs ?? r.data?.entries ?? [])
    return lines
        .filter(l => !levels || levels.includes(String(l.level ?? '').toLowerCase()))
        .map(l => typeof l === 'string' ? l : `${l.level ?? ''} [${l.module ?? l.source ?? ''}] ${l.message ?? l.msg ?? JSON.stringify(l)}`)
        .filter(l => pattern.test(l))
}

// ── Remise à zéro ─────────────────────────────────────────────
async function reset() {
    console.log('Remise à zéro (FanKarr, rTorrent et téléchargements)…')
    // Le proxy nginx garde l'IP de l'ancien conteneur FanKarr : recréé aussi
    compose('rm', '-sf', 'fankarr', 'rtorrent', 'proxy')
    for (const v of ['downloads', 'rtorrent-data', 'fankarr-config']) { try { execFileSync('docker', ['volume', 'rm', `fankarr-e2e_${v}`], { stdio: 'pipe' }) } catch {} }
    compose('up', '-d', 'fankarr', 'rtorrent', 'proxy')
    await waitFor('FanKarr prêt', async () => (await api('GET', '/api/auth/status')).status === 200, 60_000)
    await waitFor('rTorrent prêt', async () => { await rtList(RTORRENT); return true }, 90_000)
    // Le seeder se réannonce pour être connu du tracker tout de suite
    for (const t of await rtList(SEEDER)) await rpc(SEEDER, 'd.tracker_announce', [t.hash.toUpperCase()])
}

// ══ Scénario ══════════════════════════════════════════════════
await reset()

await step('Mise en place (compte, réglages, client rTorrent derrière /fankarr)', async () => {
    const { test } = await setup()
    check('test de connexion rTorrent', test?.ok, JSON.stringify(test))
    const s = await serie()
    check('page série lisible (3 + 2 épisodes)', s.seasons?.[0]?.episodes?.length === 3 && s.seasons?.[1]?.episodes?.length === 2, JSON.stringify(s).slice(0, 200))
})

await step('A. Un seul épisode d\'un pack de saison (S01E02)', async () => {
    const t = await epTorrent(900102)
    check('l\'interface propose le pack de saison avec un index de fichier', t?.infohash === T1.infohash && t.file_index === 2, JSON.stringify(t))
    await download(t)
    await waitFor('torrent dans rTorrent', () => inRt(T1.infohash), 30_000)
    const files = await waitFor('priorités appliquées', async () => {
        const f = await rtFiles(RTORRENT, T1.infohash)
        return f.length === 4 && f.filter(x => x.priority > 0).length === 1 ? f : false
    }, 40_000)
    check('seul l\'épisode demandé est actif dans rTorrent', files[2].priority > 0 && files.filter(x => x.priority > 0).length === 1, JSON.stringify(files))
    const ft = await waitDone(T1.infohash, 'S01E02')
    check('FanKarr voit le torrent terminé (100 %, seeding)', ft.state === 'seeding', JSON.stringify(ft))
    check('taille affichée = épisode seul', ft.size < 5 * 1024 * 1024, `taille ${ft.size}`)
    const r = await importNow(T1.infohash)
    check('import : 1 épisode importé', r.done === 1, JSON.stringify(r))
    check('fichier dans la médiathèque (Saison 1)', exists(media(1, 2)))
    check('import en hardlink (2 liens)', links(media(1, 2)) === 2, `liens ${links(media(1, 2))}`)
    check('épisodes non demandés pas importés', !exists(media(1, 1)) && !exists(media(1, 3)))
    check('page série : S01E02 importé', (await organizedIds()).has(900102))
})

await step('A2. Un deuxième épisode du même pack ensuite (S01E03)', async () => {
    await download(await epTorrent(900103))
    const files = await waitFor('S01E03 actif', async () => {
        const f = await rtFiles(RTORRENT, T1.infohash)
        return f[3]?.priority > 0 ? f : false
    }, 30_000)
    check('S01E03 activé, S01E02 toujours actif, S01E01 toujours désactivé', files[2].priority > 0 && files[3].priority > 0 && files[1].priority === 0, JSON.stringify(files))
    // rTorrent ne reprend un torrent partiellement terminé qu'à son cycle suivant (~90 s mesurées)
    const t0 = Date.now()
    const ok = await waitFor('S01E03 téléchargé', async () => (await rtFiles(RTORRENT, T1.infohash))[3].done, 180_000, 2000).catch(() => false)
    check(`S01E03 téléchargé (${Math.round((Date.now() - t0) / 1000)} s)`, ok)
    if (!ok) return
    await waitDone(T1.infohash, 'S01E02 + S01E03')
    await importNow(T1.infohash)
    check('S01E03 importé, S01E01 toujours absent', exists(media(1, 3)) && !exists(media(1, 1)))
})

await step('B. Toute la saison ensuite (même torrent déjà présent)', async () => {
    const s = await serie()
    await download(s.seasons[0].torrent)
    const files = await waitFor('tous les épisodes actifs', async () => {
        const f = await rtFiles(RTORRENT, T1.infohash)
        return f.filter(x => x.priority > 0).length >= 3 ? f : false
    }, 30_000).catch(err => { check('les 3 épisodes deviennent actifs dans rTorrent', false, err.message); return null })
    if (files) check('les 3 épisodes deviennent actifs dans rTorrent', true)
    if (!files) return
    await waitFor('saison complète', async () => (await rtFiles(RTORRENT, T1.infohash)).filter(x => x.priority > 0).every(x => x.done), 180_000, 2000)
    await waitDone(T1.infohash, 'saison 1')
    const r = await importNow(T1.infohash)
    check('import : S01E01 et S01E03 importés', exists(media(1, 1)) && exists(media(1, 3)), JSON.stringify(r))
})

await step('C. Torrent d\'un seul fichier (S02E02)', async () => {
    const t = await epTorrent(900202)
    check('l\'interface propose le torrent mono-fichier', t?.infohash === T3.infohash, JSON.stringify(t))
    await download(t)
    await waitDone(T3.infohash, 'S02E02')
    const r = await importNow(T3.infohash)
    check('import : S02E02 dans Saison 2', exists(media(2, 2)), JSON.stringify(r))
    check('hardlink', links(media(2, 2)) === 2, `liens ${links(media(2, 2))}`)
})

await step('D. Intégrale avec sous-dossiers de saison', async () => {
    const s = await serie()
    await download(s.torrents_integrale[0])
    await waitDone(T2.infohash, 'intégrale')
    const r = await importNow(T2.infohash)
    check('import : S02E01 trouvé dans « Test Henshu/Saison 2/ »', exists(media(2, 1)), JSON.stringify(r))
    check('aucune erreur d\'import', (r.errors ?? []).length === 0, JSON.stringify(r.errors))
})

await step('E. Supprimer des épisodes (fichier + torrent devenu inutile)', async () => {
    let r = await api('DELETE', '/api/organized/9001/900102?deleteFile=true')
    check('suppression S01E02 acceptée', r.status === 200, JSON.stringify(r.data))
    check('S01E02 retiré de la médiathèque', !exists(media(1, 2)))
    // S01E02 vient aussi de l'intégrale : vérifier qu'aucun torrent encore utile n'a été retiré
    check('pack de saison conservé (S01E01, S01E03 en dépendent)', !!(await inRt(T1.infohash)))
    await api('DELETE', '/api/organized/9001/900101?deleteFile=true')
    await api('DELETE', '/api/organized/9001/900103?deleteFile=true')
    await sleep(3000)
    const gone = !(await inRt(T1.infohash))
    check('pack de saison retiré de rTorrent une fois inutile', gone || !!(await inRt(T2.infohash)), 'toujours présent')
    if (gone) check('données du pack supprimées du disque', !exists(`${DL}/${T1.name}`), sh('fankarr', `ls -la "${DL}"`))
})

await step('F. Supprimer une saison (S02)', async () => {
    const r = await api('DELETE', '/api/organized/9001/seasons/90012?deleteFile=true')
    check('suppression acceptée', r.status === 200, JSON.stringify(r.data))
    check('épisodes S02 retirés de la médiathèque', !exists(media(2, 1)) && !exists(media(2, 2)))
    await sleep(3000)
    check('torrent mono-fichier retiré de rTorrent', !(await inRt(T3.infohash)))
    check('fichier du torrent mono-fichier supprimé', !exists(`${DL}/${T3.name}`))
    check('dossier de téléchargement conservé', exists(DL))
})

await step('G. Supprimer la série', async () => {
    const r = await api('DELETE', '/api/organized/9001?deleteFile=true')
    check('suppression acceptée', r.status === 200, JSON.stringify(r.data))
    await sleep(3000)
    check('plus aucun épisode importé', (await organizedIds()).size === 0, [...await organizedIds()].join(','))
    check('intégrale retirée de rTorrent', !(await inRt(T2.infohash)))
    check('données de l\'intégrale supprimées', !exists(`${DL}/${T2.name}`), sh('fankarr', `find "${DL}" | head`))
    check('rien d\'autre supprimé dans downloads', exists(DL) && exists('/downloads/media'))
})

await step('H. Activité : supprimer un torrent avec ses fichiers', async () => {
    await download(await epTorrent(900202))
    await waitDone(T3.infohash, 'S02E02 (bis)')
    const r = await api('DELETE', `/api/torrent/${T3.infohash}?deleteFiles=true`)
    check('suppression acceptée', r.status === 200 && r.data?.ok !== false, JSON.stringify(r.data))
    await sleep(2000)
    check('torrent retiré de rTorrent', !(await inRt(T3.infohash)))
    check('fichier supprimé du disque', !exists(`${DL}/${T3.name}`))
})

await step('I. Import automatique (comme au quotidien)', async () => {
    await api('POST', '/api/settings', { autoImport: true })
    await download(await epTorrent(900102))
    await waitDone(T1.infohash, 'S01E02 (auto)')
    // Le premier passage automatique a lieu 10 s après le démarrage
    compose('restart', 'fankarr', 'proxy')
    await waitFor('FanKarr redémarré', async () => (await api('GET', '/api/auth/status')).status === 200, 60_000)
    await setup({ autoImport: true })
    const ok = await waitFor('import automatique', () => exists(media(1, 2)), 60_000, 2000).catch(() => false)
    check('S01E02 importé automatiquement', ok, (await fkLogs(/organize/)).slice(-5).join(' | '))
})

await step('I2. Épisode suivant du même pack, torrent arrêté une fois terminé (règle de ratio d\'une seedbox)', async () => {
    await download(await epTorrent(900103))
    const done = await waitFor('S01E03 téléchargé', async () => (await rtFiles(RTORRENT, T1.infohash))[3]?.done, 180_000, 2000).catch(() => false)
    check('S01E03 téléchargé', done)
    if (!done) return
    await rpc(RTORRENT, 'd.stop', [T1.infohash])
    const ft = await waitFor('FanKarr voit le torrent arrêté', async () => {
        const t = await fkTorrent(T1.infohash)
        return t && t.progress === 100 ? t : false
    }, 30_000)
    check('torrent arrêté mais terminé : vu comme « seeding »', ft.state === 'seeding', JSON.stringify(ft))
    compose('restart', 'fankarr', 'proxy')
    await waitFor('FanKarr redémarré', async () => (await api('GET', '/api/auth/status')).status === 200, 60_000)
    await setup({ autoImport: true })
    const ok = await waitFor('import automatique', () => exists(media(1, 3)), 60_000, 2000).catch(() => false)
    check('S01E03 importé automatiquement', ok, (await fkLogs(/organize/)).slice(-5).join(' | '))
})

await step('J. Mode « déplacer »', async () => {
    await api('POST', '/api/settings', { organizeMode: 'move', autoImport: false })
    await download(await epTorrent(900202))
    await waitDone(T3.infohash, 'S02E02 (déplacer)')
    const r = await importNow(T3.infohash)
    check('fichier déplacé dans la médiathèque', exists(media(2, 2)) && links(media(2, 2)) === 1, JSON.stringify(r))
    check('source retirée du dossier de téléchargement', !exists(`${DL}/${T3.name}`))
})

await step('Journal FanKarr', async () => {
    // Ignoré : l'avertissement du démarrage, avant que la médiathèque soit configurée
    // ni les épisodes volontairement non sélectionnés, ignorés par l'import
    const bad = (await fkLogs(/./, ['warn', 'error'])).filter(l => !/médiathèque introuvable : $|fichier non sélectionné/.test(l))
    check('aucun avertissement ni erreur dans le journal', bad.length === 0, bad.slice(-8).join('\n        '))
})

// ── Bilan ─────────────────────────────────────────────────────
const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} vérifications réussies`)
for (const f of failed) console.log(`  ✘ [${f.section}] ${f.label}`)
process.exitCode = failed.length ? 1 : 0
