import nodemailer from "nodemailer";

function envValue(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }

  return "";
}

function getMailSettings() {
  return {
    host: envValue("email_host", "EMAIL_HOST", "DIVES_EMAIL_HOST"),
    port: Number(envValue("email_port", "EMAIL_PORT", "DIVES_EMAIL_PORT") || 587),
    user: envValue(
      "email_host_user",
      "EMAIL_HOST_USER",
      "DIVES_EMAIL_HOST_USER",
    ),
    password: envValue(
      "email_host_password",
      "EMAIL_HOST_PASSWORD",
      "DIVES_EMAIL_HOST_PASSWORD",
    ),
    starttls:
      envValue(
        "email_use_starttls",
        "EMAIL_USE_STARTTLS",
        "DIVES_EMAIL_USE_STARTTLS",
      ) !== "false",
  };
}

function isMailerConfigured() {
  const settings = getMailSettings();

  return Boolean(settings.host && settings.port && settings.user && settings.password);
}

export async function sendMail({ to, subject, text, html }) {
  const settings = getMailSettings();

  if (!isMailerConfigured()) {
    console.log(`[DEV] Email to ${to} skipped; SMTP is not configured. Subject: ${subject}`);
    return { sent: false };
  }

  const transporter = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: false,
    requireTLS: settings.starttls,
    auth: { user: settings.user, pass: settings.password },
  });

  await transporter.sendMail({
    from: { name: "Dives", address: settings.user },
    to,
    subject,
    text,
    html,
  });

  return { sent: true };
}
