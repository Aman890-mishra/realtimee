import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function loadEnvFile() {
  try {
    for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
      if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '')
    }
  } catch {}
}

loadEnvFile()
const port = Number(process.env.API_PORT || 8787)
const providerUrl = process.env.IRCTC_API_BASE_URL || 'http://indianrailapi.com/api/v2'
const providerKey = process.env.IRCTC_API_KEY
const root = fileURLToPath(new URL('.', import.meta.url))
const dist = join(root, 'dist')

const demoTrains = [{ number: '12345', name: 'New Delhi to Howrah Rajdhani Express', departure: '16:00', arrival: '20:27', fare: 1540, availability: 'AVAILABLE 12' }, { number: '12951', name: 'Mumbai Rajdhani Express', departure: '17:00', arrival: '06:13', fare: 1825, availability: 'RAC 4' }, { number: '12002', name: 'Bhopal Shatabdi Express', departure: '06:00', arrival: '14:25', fare: 850, availability: 'AVAILABLE 28' }]
const demoStatus = { '12345': { currentStation: 'Kanpur Central', nextStation: 'Prayagraj Jn', eta: '08:45 PM', delay: 18, status: 'Delayed' }, '12951': { currentStation: 'Kota Junction', nextStation: 'Sawai Madhopur', eta: '06:20 AM', delay: 7, status: 'Delayed' }, '12002': { currentStation: 'Gwalior', nextStation: 'Jhansi Jn', eta: '08:35 PM', delay: 0, status: 'On Time' }, '12295': { currentStation: 'Nagpur', nextStation: 'Itarsi Jn', eta: '11:15 AM', delay: 24, status: 'Delayed' } }

function json(response, status, body) { response.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); response.end(JSON.stringify(body)) }
function staticFile(response, requestUrl) { const requested = requestUrl === '/' ? '/index.html' : requestUrl.split('?')[0]; const file = join(dist, requested); const fallback = join(dist, 'index.html'); const target = existsSync(file) && !requested.endsWith('/') ? file : fallback; const types = { '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.xml': 'application/xml', '.txt': 'text/plain' }; response.writeHead(200, { 'Content-Type': types[extname(target)] || 'text/html' }); response.end(readFileSync(target)) }
function readBody(request) { return new Promise(resolve => { let body = ''; request.on('data', chunk => { body += chunk }); request.on('end', () => { try { resolve(JSON.parse(body || '{}')) } catch { resolve({}) } }) }) }
function normalizeStatus(number, payload) {
  const data = payload?.TrainData || payload?.trainData || payload?.data || payload
  const currentStation = data?.CurrentStation || data?.currentStation || data?.CurrentStationName || data?.current_station || 'Unavailable'
  const nextStation = data?.NextStation || data?.nextStation || data?.NextStationName || data?.next_station || 'Unavailable'
  const delayValue = data?.DelayInMinutes ?? data?.delay ?? data?.Delay ?? 0
  const delay = Number.parseInt(String(delayValue).replace(/[^\d-]/g, ''), 10) || 0
  const eta = data?.ETA || data?.eta || data?.ExpectedArrival || data?.expectedArrival || 'Unavailable'
  return { provider: 'Indian Rail API', number, currentStation, nextStation, eta: String(eta), delay, status: delay > 0 ? 'Delayed' : 'On Time' }
}
async function requestLiveStatus(number, date) {
  if (!providerKey) throw new Error('IRCTC_API_KEY is not configured')
  const endpoint = `${providerUrl.replace(/\/$/, '')}/livetrainstatus/apikey/${encodeURIComponent(providerKey)}/trainnumber/${encodeURIComponent(number)}/date/${encodeURIComponent(date)}/`
  const response = await fetch(endpoint)
  const payload = await response.json()
  if (!response.ok || payload?.error || payload?.ResponseCode === '404') throw new Error(payload?.Message || 'Indian Rail API request failed')
  return normalizeStatus(number, payload)
}

createServer(async (request, response) => {
  if (request.method === 'OPTIONS') return json(response, 204, {})
  if (request.method === 'GET' && request.url === '/api/health') return json(response, 200, { ok: true, provider: providerKey ? 'indianrailapi' : 'demo' })
  if (request.method === 'GET' && !request.url.startsWith('/api/')) return existsSync(dist) ? staticFile(response, request.url) : json(response, 503, { error: 'Frontend build not found. Run npm run build.' })
  if (request.method !== 'POST' || !['/api/availability', '/api/status'].includes(request.url)) return json(response, 404, { error: 'Not found' })
  const body = await readBody(request)
  try {
    if (request.url === '/api/status' && providerKey) {
      const number = String(body.number || '').trim()
      const date = String(body.date || new Date().toISOString().slice(0, 10).replace(/-/g, ''))
      return json(response, 200, await requestLiveStatus(number, date))
    }
    if (request.url === '/api/availability') return json(response, 200, { provider: 'RailSense demo', trains: demoTrains })
    const number = String(body.number || '')
    return demoStatus[number] ? json(response, 200, { provider: 'RailSense demo', number, ...demoStatus[number] }) : json(response, 404, { error: 'Train not found' })
  } catch { return json(response, 502, { error: 'Configured railway provider unavailable' }) }
}).listen(port, '0.0.0.0', () => console.log(`RailSense API listening on http://localhost:${port}`))
