import "server-only";

export function isDevStage() {
  return process.env.OTEL_DEPLOYMENT_ENVIRONMENT === "dev";
}
