const nodemailer = require("nodemailer");
const QRCode = require("qrcode");

let transporter = null;

const getTransporter = async () => {
  if (transporter) return transporter;

  if (process.env.EMAIL_USER) {
    // Production: use real SMTP from environment
    transporter = nodemailer.createTransport({
      host:   process.env.EMAIL_HOST || "smtp.gmail.com",
      port:   parseInt(process.env.EMAIL_PORT || "587"),
      secure: false,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });
    console.log("📧 Email transporter: SMTP (", process.env.EMAIL_HOST, ")");
  } else {
    // Development fallback: Ethereal (created once and reused)
    const testAccount = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host:   "smtp.ethereal.email",
      port:   587,
      secure: false,
      auth: {
        user: testAccount.user,
        pass: testAccount.pass
      }
    });
    console.log("📧 Email transporter: Ethereal (", testAccount.user, ")");
    console.log("📧 Preview emails at: https://ethereal.email");
  }

  return transporter;
};

const sendTicketEmail = async (userEmail, ticketId, eventName, userName) => {
  try {
    const t = await getTransporter();

    // Generate QR as PNG buffer and attach as inline CID image.
    // Gmail and most clients block base64 data: URLs in <img> tags,
    // but CID attachments are rendered correctly.
    const qrBuffer = await QRCode.toBuffer(ticketId, {
      type:  "png",
      width: 300,
      margin: 2,
    });

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #ddd; border-radius: 8px; overflow: hidden;">
        <div style="background: #1a1a2e; color: white; padding: 24px; text-align: center;">
          <h1 style="margin: 0;">🎟️ Your Event Ticket</h1>
        </div>
        <div style="padding: 24px;">
          <p>Hello <strong>${userName}</strong>,</p>
          <p>You have successfully registered for <strong>${eventName}</strong>.</p>
          <p><strong>Ticket ID:</strong> <code style="background: #f0f0f0; padding: 4px 8px; border-radius: 4px;">${ticketId}</code></p>
          <p>Please present the QR code below at the event entrance:</p>
          <div style="text-align: center; margin: 24px 0;">
            <img src="cid:ticketqr" alt="Ticket QR Code" style="width: 200px; height: 200px; border: 2px solid #ddd; border-radius: 8px;" />
          </div>
          <p style="color: #666; font-size: 14px;">Keep this email safe - your ticket ID is your proof of registration.</p>
        </div>
      </div>
    `;

    const info = await t.sendMail({
      from:    process.env.EMAIL_FROM || '"Felicity" <noreply@events.iiit.ac.in>',
      to:      userEmail,
      subject: `Your Ticket for ${eventName}`,
      html,
      attachments: [
        {
          filename:    "ticket-qr.png",
          content:     qrBuffer,
          cid:         "ticketqr",   // matches src="cid:ticketqr" above
          contentType: "image/png",
        },
      ],
    });

    console.log(`🎟️  Ticket email sent to ${userEmail}`);
    const preview = nodemailer.getTestMessageUrl(info);
    if (preview) console.log("📬 Preview URL:", preview);

  } catch (err) {
    console.error("Email send error:", err.message);
    // Non-fatal: registration still succeeds even if email fails
  }
};

module.exports = sendTicketEmail;