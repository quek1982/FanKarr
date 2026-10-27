// Construit l'archive autonome Linux x64 (même contenu que les releases officielles) :
//   release/fankarr-linux-x64/{fankarr, organize-worker.js, public/, version.txt, .env.example}
// Prérequis : pnpm et bun dans le PATH. Fonctionne depuis Windows, Linux ou macOS.
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const out  = path.join(root, 'release', 'fankarr-linux-x64')
const run  = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' })

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(out, { recursive: true })

run('pnpm exec vite build')
run(`bun build server/index.ts --compile --target bun-linux-x64 --outfile "${path.join(out, 'fankarr')}"`)
run(`bun build server/organize-worker.ts --target node --outfile "${path.join(out, 'organize-worker.js')}"`)

fs.cpSync(path.join(root, 'dist', 'client'), path.join(out, 'public'), { recursive: true })
fs.copyFileSync(path.join(root, 'version.txt'),  path.join(out, 'version.txt'))
fs.copyFileSync(path.join(root, '.env.example'), path.join(out, '.env.example'))

// tar est fourni avec Windows 10+ ; depuis Windows, faire « chmod +x fankarr » après extraction
// Chemins relatifs : le tar de Git for Windows prend « D: » pour un hôte distant
const archive = path.join(root, 'release', 'fankarr-linux-x64.tar.gz')
fs.rmSync(archive, { force: true })
execSync('tar -czf fankarr-linux-x64.tar.gz fankarr-linux-x64', { cwd: path.dirname(archive), stdio: 'inherit' })

console.log(`\nArchive prête : ${archive}`)
