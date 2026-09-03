import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-grpc";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { diag, DiagConsoleLogger, DiagLogLevel, metrics } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

let sdk;
let cronjobStartCounter;

export function bootstrapOpenTelemetry() {
  if (sdk) return sdk;
  if (process.env.OTEL_SDK_DISABLED === "true") return null;
  if (!isOtelConfigured()) return null;

  if (process.env.OTEL_LOG_LEVEL?.toLowerCase() === "debug") {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  sdk = new NodeSDK({
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
  return sdk;
}

export async function shutdownOpenTelemetry() {
  if (!sdk) return;

  const activeSdk = sdk;
  sdk = undefined;
  await activeSdk.shutdown();
}

export function recordCronjobStart(attributes) {
  const meter = metrics.getMeter("dives-notifications");
  cronjobStartCounter ??= meter.createCounter("cronjob.starts", {
    description: "Notification worker CronJob start attempts",
  });
  cronjobStartCounter.add(1, attributes);
}

function isOtelConfigured() {
  return !!(
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  );
}

function getResource() {
  const attributes = {
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? "dives-notification-worker",
  };

  if (process.env.OTEL_SERVICE_VERSION) {
    attributes[ATTR_SERVICE_VERSION] = process.env.OTEL_SERVICE_VERSION;
  }

  if (process.env.OTEL_DEPLOYMENT_ENVIRONMENT) {
    attributes[ATTR_DEPLOYMENT_ENVIRONMENT_NAME] = process.env.OTEL_DEPLOYMENT_ENVIRONMENT;
  }

  return resourceFromAttributes(attributes);
}
