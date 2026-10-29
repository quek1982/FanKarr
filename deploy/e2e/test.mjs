// Scénario de bout en bout FanKarr + rTorrent. Repart d'un état vierge.
//   node deploy/e2e/test.mjs            (~6 min, obligatoire avant une Release)
//   node deploy/e2e/test.mjs --rapide   (sans A2, B et I2 : la reprise d'un torrent partiellement terminé)
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { DIR, FANKARR, RTORRENT, SEEDER, TORRENTS, api, rpc, rtList, rtFiles, sh, sleep, waitFor } from './lib.mjs'
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
const RAPIDE    = process.argv.includes('--rapide')
const durations = []
async function step(name, fn, { lent = false } = {}) {
    if (lent && RAPIDE) { console.log(`\n■ ${name}\n  (sautée : --rapide)`); return }
    section = name
    console.log(`\n■ ${name}`)
    const t0 = Date.now()
    try { await fn() } catch (err) { check('étape terminée sans erreur', false, err.message) }
    durations.push({ name, s: Math.round((Date.now() - t0) / 1000) })
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
}, { lent: true })

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
}, { lent: true })

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
    // S01E01 et S01E03 ne viennent du pack qu'après B (sautée en --rapide)
    if (!RAPIDE) check('pack de saison conservé (S01E01, S01E03 en dépendent)', !!(await inRt(T1.infohash)))
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
}, { lent: true })

await step('J. Mode « déplacer »', async () => {
    await api('POST', '/api/settings', { organizeMode: 'move', autoImport: false })
    await download(await epTorrent(900202))
    await waitDone(T3.infohash, 'S02E02 (déplacer)')
    const r = await importNow(T3.infohash)
    check('fichier déplacé dans la médiathèque', exists(media(2, 2)) && links(media(2, 2)) === 1, JSON.stringify(r))
    check('source retirée du dossier de téléchargement', !exists(`${DL}/${T3.name}`))
})

await step('K. Sécurité : sessions invalidées au changement de mot de passe', async () => {
    const call = async (cookie, method, url, body) => {
        const res = await fetch(FANKARR + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) })
        return { status: res.status, headers: res.headers, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0], data: await res.json().catch(() => null) }
    }
    const login = password => call('', 'POST', '/api/auth/login', { username: 'admin', password })
    const a = await login('admin12345')
    const b = await login('admin12345')
    check('deux sessions ouvertes', a.status === 200 && b.status === 200 && a.cookie && b.cookie)
    check('en-têtes de sécurité présents', a.headers.get('x-content-type-options') === 'nosniff' && a.headers.get('x-frame-options') === 'SAMEORIGIN')

    const change = await call(b.cookie, 'POST', '/api/auth/change-password', { currentPassword: 'admin12345', newPassword: 'admin12345-bis' })
    check('changement de mot de passe accepté', change.status === 200, JSON.stringify(change.data))
    check('la session qui change le mot de passe reste ouverte', change.cookie && (await call(change.cookie, 'GET', '/api/auth/me')).status === 200)
    check('l\'autre session est refusée', (await call(a.cookie, 'GET', '/api/auth/me')).status === 401)
    check('l\'autre session n\'est plus connectée pour l\'interface', (await call(a.cookie, 'GET', '/api/auth/status')).data?.loggedIn === false)

    const c = await login('admin12345-bis')
    check('nouveau mot de passe accepté', c.status === 200)
    const back = await call(c.cookie, 'POST', '/api/auth/change-password', { currentPassword: 'admin12345-bis', newPassword: 'admin12345' })
    check('mot de passe remis', back.status === 200, JSON.stringify(back.data))
    // La session partagée du banc a été invalidée avec les autres : on s'identifie de nouveau
    const r = await api('POST', '/api/auth/login', { username: 'admin', password: 'admin12345' })
    check('reconnexion du banc', r.status === 200, JSON.stringify(r.data))
})

await step('L. Sous-dossier : icône servie sous /fankarr', async () => {
    const html = await (await fetch(FANKARR + '/')).text()
    const base = html.match(/<base href="([^"]*)"/i)?.[1]
    const href = html.match(/<link[^>]*rel="icon"[^>]*href="([^"]*)"|<link[^>]*href="([^"]*)"[^>]*rel="icon"/i)
    const icon = href && (href[1] ?? href[2])
    check('la page déclare une icône', !!icon, html.match(/<head>[\s\S]*?<\/head>/i)?.[0])
    if (!icon) return
    // Le navigateur résout l'URL de l'icône par rapport au <base href>
    const url = new URL(icon, new URL(base ?? '/', FANKARR))
    check('URL de l\'icône dans /fankarr', url.pathname.startsWith('/fankarr/'), url.pathname)
    const res = await fetch(url)
    check('icône servie', res.status === 200 && /image/.test(res.headers.get('content-type') ?? ''), `${res.status} ${res.headers.get('content-type')}`)
})

await step('M. Sécurité : routes admin protégées quelle que soit la casse', async () => {
    const call = async (cookie, method, url, body) => {
        const res = await fetch(FANKARR + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body === undefined ? undefined : JSON.stringify(body) })
        return { status: res.status, cookie: (res.headers.get('set-cookie') ?? '').split(';')[0], data: await res.json().catch(() => null) }
    }
    // Express ignore la casse des routes : /api/USERS mène à /api/users
    for (const url of ['/api/USERS', '/api/Users', '/api/JELLYFIN/settings', '/api/SYSTEM/info']) {
        const r = await call('', 'GET', url)
        check(`sans session : GET ${url} refusé`, r.status === 401, `${r.status} ${JSON.stringify(r.data).slice(0, 120)}`)
    }
    const intrus = await call('', 'POST', '/api/USERS', { username: 'intrus', password: 'intrus12345', role: 'admin' })
    check('sans session : création d\'un admin refusée', intrus.status === 401, `${intrus.status} ${JSON.stringify(intrus.data).slice(0, 120)}`)

    const created = await api('POST', '/api/users', { username: 'simple', password: 'simple12345', role: 'user' })
    check('compte simple créé', created.status === 200, JSON.stringify(created.data))
    const user = await call('', 'POST', '/api/auth/login', { username: 'simple', password: 'simple12345' })
    for (const url of ['/api/Torrent-clients', '/api/LOGS', '/api/Browse?path=/', '/api/Settings']) {
        const r = await call(user.cookie, 'GET', url)
        check(`compte simple : GET ${url.split('?')[0]} refusé`, r.status === 403, `${r.status} ${JSON.stringify(r.data).slice(0, 120)}`)
    }

    // Ménage : comptes du scénario (et intrus éventuel)
    for (const u of (await api('GET', '/api/users')).data ?? []) {
        if (u.username === 'simple' || u.username === 'intrus') await api('DELETE', `/api/users/${u.id}`)
    }
})

await step('N. Sécurité : CORS réservé à l\'API publique', async () => {
    const origin = { Origin: 'https://ailleurs.example' }
    const app = await fetch(FANKARR + '/api/auth/status', { headers: origin })
    check('API de l\'interface : pas d\'en-tête CORS', !app.headers.get('access-control-allow-origin'), app.headers.get('access-control-allow-origin'))
    const pub = await fetch(FANKARR + '/api/v1/auth/me', { headers: origin })
    check('API publique : CORS ouvert', pub.headers.get('access-control-allow-origin') === '*', pub.headers.get('access-control-allow-origin'))
    const pre = await fetch(FANKARR + '/api/v1/requests', { method: 'OPTIONS', headers: { ...origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } })
    check('API publique : pré-requête acceptée', pre.status === 204 && /authorization/i.test(pre.headers.get('access-control-allow-headers') ?? ''), `${pre.status} ${pre.headers.get('access-control-allow-headers')}`)
})

await step('Journal FanKarr', async () => {
    // Ignoré : l'avertissement du démarrage, avant que la médiathèque soit configurée
    // ni les épisodes volontairement non sélectionnés, ignorés par l'import
    // ni les refus d'accès provoqués par le scénario M
    const bad = (await fkLogs(/./, ['warn', 'error'])).filter(l => !/médiathèque introuvable : $|fichier non sélectionné|Accès admin refusé pour « simple »/.test(l))
    check('aucun avertissement ni erreur dans le journal', bad.length === 0, bad.slice(-8).join('\n        '))
})

// ── Bilan ─────────────────────────────────────────────────────
const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} vérifications réussies${RAPIDE ? ' (--rapide : A2, B et I2 sautées)' : ''}`)
for (const f of failed) console.log(`  ✘ [${f.section}] ${f.label}`)
console.log('\nDurée par étape :')
for (const d of durations) console.log(`  ${String(d.s).padStart(4)} s  ${d.name}`)
console.log(`  ${String(Math.round(process.uptime())).padStart(4)} s  total (remise à zéro comprise)`)
process.exitCode = failed.length ? 1 : 0
