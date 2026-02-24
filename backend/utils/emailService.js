const nodemailer = require("nodemailer");
const QRCode = require("qrcode");
const dns = require("dns");
const util = require("util");

// Promisify DNS resolve
const resolve4 = util.promisify(dns.resolve4);

let transporter = null;

const getTransporter = async () => {
  if (transporter) return transporter;

  if (process.env.EMAIL_USER) {
    try {
      console.log("🌐 Resolving smtp.gmail.com to IPv4 manually...");
      
      // 1. Manually find the IPv4 address
      const addresses = await resolve4("smtp.gmail.com");
      const gmailIp = addresses[0]; 
      
      console.log(`✅ Resolved Gmail to: ${gmailIp}`);
      console.log("🚀 Connecting via Port 587 (STARTTLS)...");
      
      transporter = nodemailer.createTransport({
        host: gmailIp,           // Direct IP
        port: 587,               // 🔹 CHANGE: Use Port 587
        secure: false,           // 🔹 CHANGE: Must be false for 587
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS,
        },
        tls: {
          // Tell TLS we are visiting smtp.gmail.com (matches cert)
          servername: "smtp.gmail.com", 
          rejectUnauthorized: true,
        }
      });
      
      console.log(`📧 Email transporter configured for: ${process.env.EMAIL_USER}`);
      
    } catch (error) {
      console.error("❌ Setup Failed:", error.message);
    }
  } else {
    // Development fallback
    const testAccount = await nodemailer.createTestAccount();
    transporter = nodemailer.createTransport({
      host: "smtp.ethereal.email",
      port: 587,
      secure: false,
      auth: { user: testAccount.user, pass: testAccount.pass },
    });
  }

  return transporter;
};

const sendTicketEmail = async (userEmail, ticketId, eventName, userName) => {
  try {
    const t = await getTransporter();

    const qrBuffer = await QRCode.toBuffer(ticketId, {
      type: "png",
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
      from: process.env.EMAIL_FROM || '"Felicity Events" <noreply@felicity.iiit.ac.in>',
      to: userEmail,
      subject: `Your Ticket for ${eventName}`,
      html,
      attachments: [
        {
          filename: "ticket-qr.png",
          content: qrBuffer,
          cid: "ticketqr",
          contentType: "image/png",
        },
      ],
    });

    console.log(`Ticket email sent to ${userEmail}`);
    
    const preview = nodemailer.getTestMessageUrl(info);
    if (preview) console.log("Preview URL:", preview);

  } catch (err) {
    console.error("Email send error:", err.message);
  }
};

module.exports = sendTicketEmail;