// Mise en place : compte admin, réglages, client rTorrent (idempotent)
import { api, sh } from './lib.mjs'

export async function setup({ organizeMode = 'hardlink', autoImport = false } = {}) {
    sh('fankarr', 'mkdir -p /downloads/media /downloads/temp')
    let r = await api('GET', '/api/auth/status')
    if (!r.data.setup) r = await api('POST', '/api/auth/setup', { username: 'admin', password: 'admin12345' })
    else               r = await api('POST', '/api/auth/login', { username: 'admin', password: 'admin12345' })
    if (r.status !== 200) throw new Error(`connexion : ${r.status} ${JSON.stringify(r.data)}`)

    r = await api('POST', '/api/settings', { mediaPath: '/downloads/media', completePath: '/downloads/temp', organizeMode, category: 'fankai', autoImport, nfoSupport: false })
    if (r.status !== 200) throw new Error(`réglages : ${r.status} ${JSON.stringify(r.data)}`)

    const clients = (await api('GET', '/api/torrent-clients')).data
    let client = Array.isArray(clients) ? clients.find(c => c.type === 'rtorrent') : null
    if (!client) {
        r = await api('POST', '/api/torrent-clients', { name: 'rtorrent', type: 'rtorrent', config: {
            url: 'http://rtorrent:8000', rpcPath: '/RPC2', username: 'fankarr', password: 'secret', category: 'fankai' } })
        if (r.status !== 200) throw new Error(`client : ${r.status} ${JSON.stringify(r.data)}`)
        client = r.data
    }
    const test = await api('POST', `/api/torrent-clients/${client.uuid}/test`)
    return { client, test: test.data }
}

if (process.argv[1]?.endsWith('setup.mjs')) {
    const { client, test } = await setup()
    console.log('client', client.uuid, 'test', JSON.stringify(test))
    const s = await api('GET', '/api/series/9001')
    console.log('series/9001', s.status)
    const trunc = (o, d = 0) => Array.isArray(o) ? (o.length ? [trunc(o[0], d + 1), `…(${o.length})`] : [])
        : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, d > 4 ? '…' : trunc(v, d + 1)]))
        : typeof o === 'string' && o.length > 70 ? o.slice(0, 70) + '…' : o
    console.log(JSON.stringify(trunc(s.data), null, 1).slice(0, 5000))
}
