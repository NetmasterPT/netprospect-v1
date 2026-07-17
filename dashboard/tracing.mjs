// NetProspect — bootstrap de tracing OpenTelemetry. Carregado ANTES do server via
// `node --import ./tracing.mjs server.mjs` (ver Dockerfile). Instrumenta HTTP/Express/Redis/PG/NATS
// automaticamente e exporta OTLP para o Jaeger (all-in-one no np-server). Ver docs/observability.md.
//
// FAIL-SOFT: se as libs OTel ou o colector falharem, o dashboard corre na mesma. OTEL_ENABLED=0 desliga.
if (process.env.OTEL_ENABLED !== '0') {
  try {
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { getNodeAutoInstrumentations } = await import('@opentelemetry/auto-instrumentations-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://jaeger:4318').replace(/\/$/, '');
    const sdk = new NodeSDK({
      serviceName: process.env.OTEL_SERVICE_NAME || 'netprospect-dashboard',
      traceExporter: new OTLPTraceExporter({ url: endpoint + '/v1/traces' }),
      instrumentations: [getNodeAutoInstrumentations({
        // ruído: fs (muito verboso) e dns desligados.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
      })],
    });
    sdk.start();
    // eslint-disable-next-line no-console
    console.log('[otel] tracing ativo → ' + endpoint + ' (service=netprospect-dashboard)');
    process.on('SIGTERM', () => { sdk.shutdown().catch(() => {}); });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[otel] desativado: ' + (e && e.message));
  }
}
