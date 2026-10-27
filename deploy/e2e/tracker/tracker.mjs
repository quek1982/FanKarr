// Tracker HTTP minimal (réponses compactes) pour relier le seeder et le rTorrent de FanKarr
import http from 'node:http'

const swarms = new Map()  // infohash hex → Map("ip:port" → { ip, port, seen })

function decodeBinary(s) {
    const out = []
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '%') { out.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2 }
        else out.push(s.charCodeAt(i))
    }
    return Buffer.from(out)
}

const be = (s) => `${Buffer.byteLength(s, 'latin1')}:${s}`

http.createServer((req, res) => {
    const [pathname, query = ''] = req.url.split('?')
    if (pathname !== '/announce') { res.writeHead(404).end(); return }
    const params = Object.fromEntries(query.split('&').map(kv => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)] }))
    const hash = decodeBinary(params.info_hash ?? '').toString('hex')
    const ip   = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
    const port = Number(params.port)
    const key  = `${ip}:${port}`

    const swarm = swarms.get(hash) ?? new Map()
    swarms.set(hash, swarm)
    if (params.event === 'stopped') swarm.delete(key)
    else swarm.set(key, { ip, port, seen: Date.now() })

    const peers = [...swarm.entries()]
        // Pas d'expiration courte : rTorrent ne se réannonce qu'à son propre rythme
        .filter(([k, p]) => k !== key && Date.now() - p.seen < 24 * 3600_000)
        .map(([, p]) => Buffer.from([...p.ip.split('.').map(Number), p.port >> 8, p.port & 255]))
    const compact = Buffer.concat(peers).toString('latin1')
    console.log(`announce ${hash.slice(0, 8)} ${key} ${params.event ?? ''} → ${peers.length} pair(s)`)
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(Buffer.from(`d8:intervali10e12:min intervali5e5:peers${be(compact)}e`, 'latin1'))
}).listen(6969, () => console.log('tracker sur :6969'))
