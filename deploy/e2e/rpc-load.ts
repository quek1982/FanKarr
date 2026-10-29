// Charge que FanKarr impose à rTorrent à chaque interrogation (liste des téléchargements).
// Faux serveur XML-RPC qui compte les appels ; le pilote est appelé directement.
//   bun deploy/e2e/rpc-load.ts
import http from 'node:http'
import RT from '../../server/torrent-clients/rtorrent.ts'

const POLLS       = 10   // interrogations successives (la page d'une série en fait une toutes les 5 s)
const DONE_COUNT  = 5    // torrents terminés
const DONE_FILES  = 100
const LIVE_FILES  = 300  // torrent en cours : une intégrale
const MAX_CONCURRENT = 2

const calls: Record<string, number> = {}
let inFlight = 0, peak = 0

const i8  = (n: number) => `<value><i8>${n}</i8></value>`
const str = (s: string) => `<value><string>${s}</string></value>`
const arr = (items: string[]) => `<value><array><data>${items.join('')}</data></array></value>`

const torrents = [
    ...Array.from({ length: DONE_COUNT }, (_, i) => ({ hash: `D${i}`.padEnd(40, '0'), complete: 1, files: DONE_FILES })),
    { hash: 'A'.repeat(40), complete: 0, files: LIVE_FILES },
]
const filesOf = (hash: string) => {
    const t = torrents.find(x => x.hash === hash)!
    return arr(Array.from({ length: t.files }, (_, i) => arr([
        i8(t.complete ? 100 : 40), i8(100), str(`Saison 1/episode-${i}.mkv`), i8(1), i8(1_000_000),
    ])))
}
const listAll = () => arr(torrents.map(t => arr([
    str(t.hash), str(`torrent-${t.hash.slice(0, 2)}`), i8(1), i8(1), i8(0), i8(t.complete), i8(t.files * 1_000_000),
    i8(t.complete ? t.files * 1_000_000 : t.files * 400_000), i8(0), i8(0), i8(0), i8(0), i8(t.complete ? 0 : t.files * 600_000), str('/downloads'), str('fankai'),
])))

const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => body += c)
    req.on('end', () => {
        const method = body.match(/<methodName>(.*?)<\/methodName>/)?.[1] ?? '?'
        const hash   = body.match(/<string>([0-9A-Fa-f]{40})<\/string>/)?.[1]?.toUpperCase()
        calls[method] = (calls[method] ?? 0) + 1
        inFlight++; peak = Math.max(peak, inFlight)
        const payload = method === 'd.multicall2' ? listAll() : method === 'f.multicall' && hash ? filesOf(hash) : str('')
        setTimeout(() => {
            inFlight--
            res.setHeader('Content-Type', 'text/xml')
            res.end(`<?xml version="1.0"?><methodResponse><params><param>${payload}</param></params></methodResponse>`)
        }, 5)
    })
})
await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
const config = { url: `http://127.0.0.1:${(server.address() as any).port}`, rpcPath: '/RPC2', category: 'fankai' } as any

let last: any[] = []
for (let i = 0; i < POLLS; i++) last = await RT.list(config, 'fankai')
server.close()

let failed = 0
const check = (label: string, ok: boolean, detail = '') => {
    console.log(`  ${ok ? '✔' : '✘'} ${label}${!ok && detail ? `\n      → ${detail}` : ''}`)
    if (!ok) failed++
}
const files = calls['f.multicall'] ?? 0
console.log(`${POLLS} interrogations, ${DONE_COUNT} torrents terminés de ${DONE_FILES} fichiers + 1 en cours de ${LIVE_FILES} fichiers`)
console.log(`  appels : ${JSON.stringify(calls)}, requêtes simultanées au maximum : ${peak}`)

// Un torrent terminé ne change plus : ses fichiers ne sont relus qu'une fois, le torrent en cours à chaque fois
check(`fichiers relus au plus ${POLLS + DONE_COUNT} fois au lieu de ${POLLS * (DONE_COUNT + 1)}`, files <= POLLS + DONE_COUNT, `${files} appels f.multicall`)
check(`au plus ${MAX_CONCURRENT} requêtes simultanées vers rTorrent`, peak <= MAX_CONCURRENT, `${peak} simultanées`)
// Le résultat ne change pas
const done = last.filter(t => t.progress === 100)
check('torrents terminés toujours listés avec leurs fichiers', done.length === DONE_COUNT && done.every(t => t.files?.length === DONE_FILES), JSON.stringify(done.map(t => t.files?.length)))
const live = last.find(t => t.files?.length === LIVE_FILES)
check('torrent en cours listé avec sa progression par fichier', !!live && live.progress < 100 && live.files[0].progress === 0.4, JSON.stringify(live && { p: live.progress, f: live.files?.[0] }))

process.exit(failed ? 1 : 0)
