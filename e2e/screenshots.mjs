// README screenshots (docs/screenshots/*.png) of the dashboard, against its in-memory fake API:
//   (cd dashboard && npm run dev:mock -- --port 5299) and then  node e2e/screenshots.mjs [http://localhost:5299]
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'

const BASE = process.argv[2] ?? 'http://localhost:5299'
const OUT = fileURLToPath(new URL('../docs/screenshots/', import.meta.url))
const browser = await chromium.launch()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function signedIn(email, theme = 'dark') {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme })
  const p = await context.newPage()
  await p.goto(BASE)
  await p.getByLabel('Email').fill(email)
  await p.getByLabel('Password').fill('password-12345')
  await p.getByRole('button', { name: 'Sign in' }).click()
  await sleep(800)
  return p
}

async function shot(p, name) {
  await p.screenshot({ path: `${OUT}${name}.png` })
  console.log(`docs/screenshots/${name}.png`)
}

let p = await signedIn('owner@example.com')
await p.goto(`${BASE}/#/workspaces`)
await sleep(600)
await shot(p, '01-workspaces')
await p.getByRole('link', { name: 'Team notes' }).first().click()
await sleep(600)
const nav = (label) => p.getByRole('navigation', { name: 'Workspace sections' }).getByRole('link', { name: label })
await nav('Notes').click()
await sleep(700)
await shot(p, '02-notes')
await nav('Members').click()
await sleep(700)
await shot(p, '03-members')
await p.goto(`${BASE}/#/device?code=ABCD-EFGH`)
await sleep(700)
await shot(p, '04-approve-desktop-sign-in')

p = await signedIn('super@example.com', 'light')
await p.goto(`${BASE}/#/`)
await sleep(800)
await shot(p, '05-admin-overview')

await browser.close()
