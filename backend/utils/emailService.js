const nodemailer = require("nodemailer");
const QRCode = require("qrcode");
const dns = require("dns");
const util = require("util");

// Promisify DNS resolve to use with await
const resolve4 = util.promisify(dns.resolve4);

let transporter = null;

const getTransporter = async () => {
  if (transporter) return transporter;

  if (process.env.EMAIL_USER) {
    try {
      console.log("🌐 Resolving smtp.gmail.com to IPv4 manually...");
      
      // 1. Manually find the IPv4 address for Gmail
      const addresses = await resolve4("smtp.gmail.com");
      const gmailIp = addresses[0]; // Take the first IPv4 address found
      
      console.log(`✅ Resolved Gmail to: ${gmailIp} (Bypassing DNS lookup)`);

      console.log("🚀 Creating Transporter with DIRECT IP connection...");
      
      transporter = nodemailer.createTransport({
        host: gmailIp,           // 2. Connect directly to the IP, not the domain
        port: 465,
        secure: true,
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS,
        },
        tls: {
          // 3. IMPORTANT: Tell TLS we are actually visiting smtp.gmail.com
          // (Required because the IP address doesn't match the certificate)
          servername: "smtp.gmail.com", 
        }
      });
      
      console.log(`📧 Email transporter active for: ${process.env.EMAIL_USER}`);
      
    } catch (error) {
      console.error("❌ Failed to resolve Gmail IP:", error.message);
      // Fallback: Try standard connection if manual resolution fails
      transporter = nodemailer.createTransport({
        service: "gmail",
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
      });
    }
  } else {
    // Development fallback
    console.log("⚠️ No EMAIL_USER found in .env, using Ethereal");
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

    console.log(`✅ Ticket email sent to ${userEmail}`);
    
    const preview = nodemailer.getTestMessageUrl(info);
    if (preview) console.log("📬 Preview URL:", preview);

  } catch (err) {
    console.error("❌ Email send error:", err.message);
  }
};

module.exports = sendTicketEmail;