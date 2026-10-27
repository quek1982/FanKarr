// Outils du test : XML-RPC rTorrent, API FanKarr, commandes dans les conteneurs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const DIR      = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
export const TORRENTS = JSON.parse(fs.readFileSync(path.join(DIR, 'work', 'torrents.json'), 'utf8'))
export const SEEDER   = 'http://127.0.0.1:8099/RPC2'
export const RTORRENT = 'http://127.0.0.1:8100/RPC2'
export const FANKARR  = 'http://127.0.0.1:8097/fankarr'
const AUTH = 'Basic ' + Buffer.from('fankarr:secret').toString('base64')

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
const val = v => typeof v === 'number' ? `<value><i8>${v}</i8></value>` : `<value><string>${esc(v)}</string></value>`

/** Appel XML-RPC ; renvoie la réponse brute (assez pour les vérifications du test). */
export async function rpc(url, method, params = []) {
    const body = `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${params.map(p => `<param>${val(p)}</param>`).join('')}</params></methodCall>`
    const res  = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/xml', Authorization: AUTH }, body })
    const text = await res.text()
    if (!res.ok || text.includes('<fault>')) throw new Error(`${method} : HTTP ${res.status} ${text.slice(0, 300)}`)
    return text
}

/** Valeurs scalaires d'une réponse, dans l'ordre (suffisant pour d.multicall2 à plat). */
export const scalars = xml => [...xml.matchAll(/<(string|i4|i8|int)>([^<]*)<\/\1>|<string\/>/g)].map(m => m[1] === 'string' || !m[1] ? (m[2] ?? '') : Number(m[2]))

/** Torrents d'un rTorrent : [{ hash, name, complete, directory, bytesDone, size }] */
export async function rtList(url) {
    const cols = ['d.hash=', 'd.name=', 'd.complete=', 'd.directory=', 'd.bytes_done=', 'd.size_bytes=', 'd.is_active=']
    const v = scalars(await rpc(url, 'd.multicall2', ['', 'main', ...cols]))
    const out = []
    for (let i = 0; i + cols.length <= v.length; i += cols.length) {
        const [hash, name, complete, directory, bytesDone, size, active] = v.slice(i, i + cols.length)
        out.push({ hash: String(hash).toLowerCase(), name, complete, directory, bytesDone, size, active })
    }
    return out
}

/** Priorités des fichiers d'un torrent : [{ path, priority, done }] */
export async function rtFiles(url, hash) {
    const v = scalars(await rpc(url, 'f.multicall', [hash.toUpperCase(), '', 'f.path=', 'f.priority=', 'f.completed_chunks=', 'f.size_chunks=']))
    const out = []
    for (let i = 0; i + 4 <= v.length; i += 4) out.push({ path: v[i], priority: v[i + 1], done: v[i + 2] >= v[i + 3] })
    return out
}

// ── API FanKarr (cookie de session) ───────────────────────────
let cookie = ''
export async function api(method, url, body) {
    const res = await fetch(FANKARR + url, {
        method, headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
    })
    const set = res.headers.get('set-cookie')
    if (set) cookie = set.split(';')[0]
    const text = await res.text()
    let data; try { data = JSON.parse(text) } catch { data = text }
    return { status: res.status, data }
}

// ── Conteneurs ────────────────────────────────────────────────
export function sh(service, cmd) {
    try {
        return execFileSync('docker', ['compose', '-f', path.join(DIR, 'docker-compose.yml'), 'exec', '-T', service, 'sh', '-c', cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    } catch (err) { return `ERREUR: ${(err.stderr || err.message).trim()}` }
}

export const sleep = ms => new Promise(r => setTimeout(r, ms))

export async function waitFor(label, fn, timeoutMs = 60_000, everyMs = 1000) {
    const t0 = Date.now()
    let last
    while (Date.now() - t0 < timeoutMs) {
        try { last = await fn(); if (last) return last } catch (err) { last = err.message }
        await sleep(everyMs)
    }
    throw new Error(`Délai dépassé : ${label} (dernier état : ${JSON.stringify(last)?.slice(0, 300)})`)
}
