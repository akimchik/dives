import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  serverExternalPackages: [
    "pino",
    "nodemailer",
    "@opentelemetry/api",
    "@opentelemetry/auto-instrumentations-node",
    "@opentelemetry/exporter-logs-otlp-grpc",
    "@opentelemetry/exporter-metrics-otlp-grpc",
    "@opentelemetry/exporter-trace-otlp-grpc",
    "@opentelemetry/resources",
    "@opentelemetry/sdk-logs",
    "@opentelemetry/sdk-metrics",
    "@opentelemetry/sdk-node",
    "@opentelemetry/semantic-conventions",
  ],
  compress: true,
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
  images: {
    dangerouslyAllowLocalIP: process.env.NODE_ENV === "development",
    remotePatterns: [
      {
        protocol: "http",
        hostname: "localhost",
        pathname: "/**",
        search: "",
      },
      {
        protocol: "http",
        hostname: "127.0.0.1",
        pathname: "/**",
        search: "",
      },
    ],
  },
  output: "standalone",
};

export default nextConfig;
