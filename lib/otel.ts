import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-grpc";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

type OtelState = {
  sdk?: NodeSDK;
  started?: boolean;
};

const globalForOtel = globalThis as typeof globalThis & {
  __divesOtel?: OtelState;
};

function isOtelConfigured() {
  return !!(
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  );
}

function getResource() {
  const attributes: Record<string, string> = {
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "dives",
  };

  if (process.env.OTEL_SERVICE_VERSION) {
    attributes[ATTR_SERVICE_VERSION] = process.env.OTEL_SERVICE_VERSION;
  }

  if (process.env.OTEL_DEPLOYMENT_ENVIRONMENT) {
    attributes[ATTR_DEPLOYMENT_ENVIRONMENT_NAME] =
      process.env.OTEL_DEPLOYMENT_ENVIRONMENT;
  }

  return resourceFromAttributes(attributes);
}

function setupDiagnostics() {
  const logLevel = process.env.OTEL_LOG_LEVEL?.toLowerCase();

  if (logLevel === "debug") {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }
}

export function registerOpenTelemetry() {
  globalForOtel.__divesOtel ??= {};

  if (globalForOtel.__divesOtel.started) return;
  if (process.env.OTEL_SDK_DISABLED === "true") return;

  if (!isOtelConfigured()) return;

  setupDiagnostics();

  const sdk = new NodeSDK({
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": {
          enabled: false,
        },
      }),
    ],
    resource: getResource(),
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
      }),
    ],
    logRecordProcessors: [
      new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() }),
    ],
  });

  sdk.start();
  globalForOtel.__divesOtel = {
    sdk,
    started: true,
  };

  process.once("SIGTERM", () => {
    void sdk.shutdown().finally(() => process.exit(0));
  });
}
