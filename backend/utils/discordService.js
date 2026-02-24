const axios = require("axios");

/**
 * Posts a new event announcement to the organizer's Discord channel
 * via their configured webhook URL.
 * Called when an event's statusOverride transitions Draft → Published.
 */
const postEventToDiscord = async (webhookUrl, event) => {
  if (!webhookUrl) return;

  try {
    const startDate = new Date(event.startDate).toLocaleDateString("en-IN", {
      day: "numeric", month: "long", year: "numeric"
    });
    const deadline = new Date(event.registrationDeadline).toLocaleDateString("en-IN", {
      day: "numeric", month: "long", year: "numeric"
    });

    const payload = {
      username: "Felicity",
      avatar_url: "https://i.imgur.com/AfFp7pu.png",
      embeds: [
        {
          title: `📢 New Event: ${event.name}`,
          description: event.description.substring(0, 200) + (event.description.length > 200 ? "..." : ""),
          color: 0x5865f2,
          fields: [
            { name: "Type",         value: event.type === "normal" ? "🎯 Normal" : "🛍️ Merchandise", inline: true },
            { name: "Eligibility",  value: event.eligibility.toUpperCase(), inline: true },
            { name: "Event Date",   value: startDate, inline: true },
            { name: "Reg Deadline", value: deadline, inline: true },
            ...(event.registrationFee > 0
              ? [{ name: "Fee", value: `₹${event.registrationFee}`, inline: true }]
              : [{ name: "Fee", value: "Free", inline: true }])
          ],
          footer: { text: "Felicity | IIIT Hyderabad" },
          timestamp: new Date().toISOString()
        }
      ]
    };

    await axios.post(webhookUrl, payload);
    console.log(`📣 Discord webhook fired for event: ${event.name}`);
  } catch (err) {
    console.error("Discord webhook error:", err.message);
    // Non-fatal: event publish still succeeds even if Discord fails
  }
};

module.exports = postEventToDiscord;