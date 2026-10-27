// Génère les données de test : faux épisodes, torrents et catalogue au format du scraper.
//   node gen.mjs <dossier de sortie>
//   → <out>/seed/...           données partagées par le seeder
//   → <out>/catalog/...        available.json, infohash_map.json, series/9001.json, torrents/*.torrent
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const OUT      = path.resolve(process.argv[2] ?? 'work')
const TRACKER  = 'http://tracker:6969/announce'
const CATALOG  = 'http://catalog'
const PIECE    = 256 * 1024
const SERIE_ID = 9001

// ── bencode ───────────────────────────────────────────────────
function bencode(v) {
    if (Buffer.isBuffer(v))        return Buffer.concat([Buffer.from(`${v.length}:`), v])
    if (typeof v === 'string')     return bencode(Buffer.from(v, 'utf8'))
    if (typeof v === 'number')     return Buffer.from(`i${v}e`)
    if (Array.isArray(v))          return Buffer.concat([Buffer.from('l'), ...v.map(bencode), Buffer.from('e')])
    const keys = Object.keys(v).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    return Buffer.concat([Buffer.from('d'), ...keys.flatMap(k => [bencode(k), bencode(v[k])]), Buffer.from('e')])
}

// ── Torrent : files = chemins relatifs à la racine, dans l'ordre du torrent ──
function makeTorrent(slug, name, files, single = false) {
    const root  = path.join(OUT, 'seed', single ? '' : name)
    const blobs = files.map(f => {
        // Taille variable pour que les pièces chevauchent les fichiers
        const size = 3 * 1024 * 1024 + crypto.randomInt(0, 900_000)
        const data = crypto.randomBytes(size)
        const p    = path.join(root, f)
        fs.mkdirSync(path.dirname(p), { recursive: true })
        fs.writeFileSync(p, data)
        return data
    })
    const all    = Buffer.concat(blobs)
    const pieces = []
    for (let o = 0; o < all.length; o += PIECE) pieces.push(crypto.createHash('sha1').update(all.subarray(o, o + PIECE)).digest())

    const info = single
        ? { name: files[0], length: blobs[0].length, 'piece length': PIECE, pieces: Buffer.concat(pieces) }
        : { name, 'piece length': PIECE, pieces: Buffer.concat(pieces),
            files: files.map((f, i) => ({ length: blobs[i].length, path: f.split('/') })) }
    const torrent  = bencode({ announce: TRACKER, info })
    const infohash = crypto.createHash('sha1').update(bencode(info)).digest('hex')
    fs.mkdirSync(path.join(OUT, 'catalog', 'torrents'), { recursive: true })
    fs.writeFileSync(path.join(OUT, 'catalog', 'torrents', `${slug}.torrent`), torrent)

    const size = `${(all.length / 1024 / 1024).toFixed(1)} MiB`
    return {
        infohash, name, files,
        ref: {
            title: `[Test] ${name}`, torrent_name: name,
            torrent_url: `${CATALOG}/torrents/${slug}.torrent`,
            magnet: `magnet:?xt=urn:btih:${infohash}&dn=${encodeURIComponent(name)}&tr=${encodeURIComponent(TRACKER)}`,
            infohash, size, pub_date: '2026-10-27 12:00', seeders: 1, fankai: true,
        },
    }
}

fs.rmSync(OUT, { recursive: true, force: true })

// T1 : pack de saison « à plat » (comme Bleach), avec un fichier annexe avant les épisodes
const ep = n => `[Test] Test Kai - 0${n} - Episode ${n}.mkv`
const T1 = makeTorrent('saga01', 'Saga 01 - Test', ['Extras/lisez-moi.txt', ep(1), ep(2), ep(3)])
// T2 : intégrale avec sous-dossiers de saison (comme Dr. Stone)
const he = n => `[Test] Test Henshu - 0${n}.mkv`
const T2 = makeTorrent('integrale', 'Test Henshu', [`Saison 1/${he(1)}`, `Saison 1/${he(2)}`, `Saison 1/${he(3)}`, `Saison 2/${he(4)}`, `Saison 2/${he(5)}`])
// T3 : torrent d'un seul fichier (comme Gintama)
const T3 = makeTorrent('single05', `[Single] Test Kai - 05.mkv`, [`[Single] Test Kai - 05.mkv`], true)

// Chemin catalogue : relatif au dossier de téléchargement, racine du torrent comprise
const pathRef = (T, rel) => ({
    infohash: T.infohash,
    path: T === T3 ? rel : `${T.name}/${rel}`,
    file_index: T.files.indexOf(rel),
})

const episode = (id, season, number, refs) => ({
    id, episode_number: number, title: `Episode ${number}`, aired: '2026-01-01',
    original_filename: refs[0].path.split('/').pop(),
    formatted_name: `Test Kai.S0${season}E0${number}.MULTI.1080p.x264-FANKAI`,
    nfo_filename: refs[0].path.split('/').pop().replace(/\.mkv$/, '.nfo'),
    torrents: [],
    paths: refs.map(r => ({ ...r,
        formatted_name: `Test Kai.S0${season}E0${number}.MULTI.1080p.x264-FANKAI`,
        nfo_filename: r.path.split('/').pop().replace(/\.mkv$/, '.nfo'),
        original_filename: r.path.split('/').pop() })),
})

const serie = {
    id: SERIE_ID, title: 'Test Kai', show_title: 'Test Kai',
    torrents: [T2.ref],
    seasons: [
        { id: 90011, season_number: 1, title: 'Saga Alpha', torrents: [T1.ref], episodes: [
            episode(900101, 1, 1, [pathRef(T1, ep(1)), pathRef(T2, `Saison 1/${he(1)}`)]),
            episode(900102, 1, 2, [pathRef(T1, ep(2)), pathRef(T2, `Saison 1/${he(2)}`)]),
            episode(900103, 1, 3, [pathRef(T1, ep(3)), pathRef(T2, `Saison 1/${he(3)}`)]),
        ] },
        { id: 90012, season_number: 2, title: 'Saga Beta', torrents: [], episodes: [
            episode(900201, 2, 1, [pathRef(T2, `Saison 2/${he(4)}`)]),
            { ...episode(900202, 2, 2, [pathRef(T3, T3.files[0]), pathRef(T2, `Saison 2/${he(5)}`)]), torrents: [T3.ref] },
        ] },
    ],
}

const cat = path.join(OUT, 'catalog')
fs.mkdirSync(path.join(cat, 'series'), { recursive: true })
fs.writeFileSync(path.join(cat, 'available.json'), JSON.stringify([SERIE_ID]))
fs.writeFileSync(path.join(cat, 'infohash_map.json'), JSON.stringify(Object.fromEntries([T1, T2, T3].map(t => [t.infohash, t.ref.title]))))
fs.writeFileSync(path.join(cat, 'series', `${SERIE_ID}.json`), JSON.stringify(serie, null, 1))
fs.writeFileSync(path.join(OUT, 'torrents.json'), JSON.stringify({ T1, T2, T3 }, null, 1))
console.log(`Données générées dans ${OUT}`)
for (const [k, t] of Object.entries({ T1, T2, T3 })) console.log(`  ${k} ${t.infohash}  ${t.name}  (${t.files.length} fichier(s))`)
