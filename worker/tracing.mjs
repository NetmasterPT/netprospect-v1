// NetProspect — bootstrap de tracing OpenTelemetry para os WORKERS. Carregado antes do worker via
// `node --import ./worker/tracing.mjs worker/worker.mjs` (ver worker/Dockerfile). Exporta OTLP para o
// Jaeger (np-server, via tailnet). Ver docs/observability.md.
//
// OPT-IN: só ativa com OTEL_ENABLED=1 (os workers fazem MUITO HTTP de saída → amostragem baixa via
// OTEL_TRACES_SAMPLER_ARG). FAIL-SOFT: se as libs/colector falharem, o worker corre na mesma.
if (process.env.OTEL_ENABLED === '1') {
  try {
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { getNodeAutoInstrumentations } = await import('@opentelemetry/auto-instrumentations-node');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
    const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://100.114.17.74:4318').replace(/\/$/, '');
    const sdk = new NodeSDK({
      serviceName: process.env.OTEL_SERVICE_NAME || 'netprospect-worker',
      traceExporter: new OTLPTraceExporter({ url: endpoint + '/v1/traces' }),
      instrumentations: [getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
      })],
    });
    sdk.start();
    // eslint-disable-next-line no-console
    console.log('[otel] worker tracing ativo → ' + endpoint + ' (host=' + (process.env.FLEET_HOST || '?') + ')');
    process.on('SIGTERM', () => { sdk.shutdown().catch(() => {}); });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[otel] worker desativado: ' + (e && e.message));
  }
}
