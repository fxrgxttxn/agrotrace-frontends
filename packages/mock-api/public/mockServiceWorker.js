const seen = new Set()
const pending = new Map()
const waiters = new Map()

addEventListener('message', function (event) {
  const clientId = Reflect.get(event.source || {}, 'id')
  if (event.data === 'MOCK_ACTIVATE' && waiters.has(clientId)) {
    activeClientIds.add(clientId)
    waiters.get(clientId)()
  }
  if (event.data === 'CLIENT_CLOSED') {
    seen.delete(clientId)
  }
})

addEventListener('fetch', function (event) {
  const request = event.request
  const clientId = event.clientId

  if (request.mode === 'navigate') {
    if (event.resultingClientId) seen.add(event.resultingClientId)
    return
  }

  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') {
    return
  }

  if (!clientId || activeClientIds.has(clientId) || (seen.has(clientId) && !pending.has(clientId))) {
    return
  }

  event.stopImmediatePropagation()
  const interceptedAt = Date.now()
  event.respondWith(
    revive(clientId).then(function () {
      return activeClientIds.size === 0
        ? fetch(request)
        : handleRequest(event, crypto.randomUUID(), interceptedAt)
    }),
  )
})

function revive(clientId) {
  if (!pending.has(clientId)) {
    seen.add(clientId)
    pending.set(
      clientId,
      ask(clientId).finally(function () {
        pending.delete(clientId)
      }),
    )
  }
  return pending.get(clientId)
}

async function ask(clientId) {
  const client = await self.clients.get(clientId)
  if (!client || client.type !== 'window') return
  await new Promise(function (resolve) {
    waiters.set(clientId, resolve)
    client.postMessage({ type: 'MOCK_REVIVE' })
    setTimeout(resolve, 1000)
  })
  waiters.delete(clientId)
}

importScripts('./msw/mockServiceWorker.js')
