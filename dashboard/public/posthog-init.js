import posthog from '/vendor/posthog-js/dist/module.full.js'

const CONFIG_URL = '/api/posthog-config'
const DEFAULTS_DATE = '2026-05-30'
let initialized = false

async function loadConfig() {
  try {
    const response = await fetch(CONFIG_URL, { credentials: 'same-origin' })
    if (!response.ok) return null
    const config = await response.json()
    if (!config?.enabled || !config?.key || !config?.host) return null
    return config
  } catch {
    return null
  }
}

function buildApiHeaders(headers = {}) {
  if (!initialized) return headers
  const distinctId = posthog.get_distinct_id?.()
  const sessionId = posthog.get_session_id?.()
  return {
    ...headers,
    ...(distinctId ? { 'X-POSTHOG-DISTINCT-ID': distinctId } : {}),
    ...(sessionId ? { 'X-POSTHOG-SESSION-ID': sessionId } : {}),
  }
}

function capture(event, properties = {}) {
  if (!initialized) return
  posthog.capture(event, properties)
}

function captureException(error, properties = {}) {
  if (!initialized) return
  posthog.captureException(error, properties)
}

async function init() {
  const config = await loadConfig()
  if (!config) return

  posthog.init(config.key, {
    api_host: config.host,
    defaults: DEFAULTS_DATE,
    capture_pageview: false,
    persistence: 'localStorage+cookie',
  })

  initialized = true

  posthog.register({
    app_name: 'netprospect_dashboard',
    app_section: 'dashboard',
  })

  // SPA pageviews (Web Analytics): o dashboard usa hash routing (#/directory, #/coverage…) e o SDK está
  // com capture_pageview:false → o PostHog não deteta a navegação. Capturamos manualmente a cada mudança
  // de rota (hashchange) + no arranque, com a rota normalizada (sem query) como nome de página.
  const routeName = () => (window.location.hash || '#/').split('?')[0]
  let lastRoute = null
  const capturePageview = () => {
    if (!initialized) return
    const route = routeName()
    if (route === lastRoute) return
    lastRoute = route
    posthog.capture('$pageview', { $current_url: window.location.href, route })
  }
  window.addEventListener('hashchange', capturePageview)
  capturePageview()

  window.addEventListener('error', (event) => {
    if (event?.error) {
      captureException(event.error, { source: 'window_error' })
    }
  })

  window.addEventListener('unhandledrejection', (event) => {
    captureException(event?.reason || new Error('Unhandled promise rejection'), {
      source: 'unhandledrejection',
    })
  })
}

await init()

window.posthogAnalytics = {
  capture,
  captureException,
  buildApiHeaders,
  getDistinctId: () => (initialized ? posthog.get_distinct_id?.() : undefined),
  getSessionId: () => (initialized ? posthog.get_session_id?.() : undefined),
  isEnabled: () => initialized,
}
