import nodemailer from "nodemailer";

function resetMessage(token: string) {
  const link = `sagha://reset-password?token=${encodeURIComponent(token)}`;
  return [
    "A password reset was requested for this Sagha house.",
    "",
    "Open the app with this link:",
    link,
    "",
    "Or enter this code on the reset screen:",
    token,
    "",
    "The code expires in 30 minutes. If you did not ask for this, ignore the message.",
  ].join("\n");
}

/** Sends the reset note when SMTP is configured. In local development the code is logged instead. */
export async function sendPasswordResetEmail(to: string, token: string) {
  const text = resetMessage(token);
  const host = process.env.SMTP_HOST?.trim();
  if (!host) {
    if (process.env.NODE_ENV === "production") {
      console.error("[sagha] SMTP_HOST is not set; password reset email was not sent");
      return;
    }
    console.info(`[sagha] password reset for ${to}\n${text}`);
    return;
  }

  const port = Number(process.env.SMTP_PORT ?? 587);
  const user = process.env.SMTP_USER?.trim();
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user ? { user, pass: process.env.SMTP_PASS ?? "" } : undefined,
  });
  await transporter.sendMail({
    from: process.env.MAIL_FROM ?? "Sagha <support@sagha-platform.com>",
    to,
    subject: "Reset your Sagha password",
    text,
  });
}
