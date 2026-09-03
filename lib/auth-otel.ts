import "server-only";

import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("auth", "0.1.0");

export type AuthMethod = "password" | "oidc";

const signupCounter = meter.createCounter("auth.signups", {
  description: "Number of new user accounts created",
});
const signinCounter = meter.createCounter("auth.signins", {
  description: "Number of successful sign-ins (sessions issued)",
});
const logoutCounter = meter.createCounter("auth.logouts", {
  description: "Number of user logouts",
});

export function recordSignup(method: AuthMethod) {
  signupCounter.add(1, { method });
}

export function recordSignin(method: AuthMethod) {
  signinCounter.add(1, { method });
}

export function recordLogout(method: AuthMethod) {
  logoutCounter.add(1, { method });
}
