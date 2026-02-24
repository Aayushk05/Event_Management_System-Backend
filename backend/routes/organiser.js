const express = require("express");
const Organizer = require("../models/Organiser");
const Event = require("../models/Event");
const Registration = require("../models/Registration");
const PasswordResetRequest = require("../models/PasswordResetRequest");
const authMiddleware = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");

const router = express.Router();
const guard = [authMiddleware, roleMiddleware("organizer")];

router.get("/profile", ...guard, async (req, res) => {
  try {
    const organizer = await Organizer.findOne({ userId: req.user.id });
    if (!organizer) return res.status(404).json({ message: "Organizer profile not found." });
    res.json({ organizer });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login email is non-editable; all other fields can be updated
router.put("/profile", ...guard, async (req, res) => {
  try {
    const { organizerName, category, description, contactEmail, contactNumber, discordWebhookUrl } = req.body;

    const organizer = await Organizer.findOne({ userId: req.user.id });
    if (!organizer) return res.status(404).json({ message: "Organizer profile not found." });

    if (organizerName)     organizer.organizerName     = organizerName;
    if (category)          organizer.category          = category;
    if (description)       organizer.description       = description;
    if (contactEmail)      organizer.contactEmail      = contactEmail;
    if (contactNumber)     organizer.contactNumber     = contactNumber;
    if (discordWebhookUrl !== undefined) organizer.discordWebhookUrl = discordWebhookUrl;

    await organizer.save();
    res.json({ message: "Saved.", organizer });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/profile/test-discord", ...guard, async (req, res) => {
  try {
    const organizer = await Organizer.findOne({ userId: req.user.id });
    if (!organizer?.discordWebhookUrl)
      return res.status(400).json({ message: "No Discord webhook URL configured." });

    const axios = require("axios");
    await axios.post(organizer.discordWebhookUrl, {
      username: "Felicity",
      content:  `Webhook test from **${organizer.organizerName}** - integration is working!`
    });

    res.json({ message: "Discord test sent." });
  } catch (err) {
    res.status(500).json({ error: "Discord webhook test failed: " + err.message });
  }
});

router.get("/dashboard", ...guard, async (req, res) => {
  try {
    const organizer = await Organizer.findOne({ userId: req.user.id });
    if (!organizer) return res.status(404).json({ message: "Organizer not found." });

    const events = await Event.find({ organizerId: organizer._id })
      .sort({ createdAt: -1 });

    // For completed events, compute analytics
    const completedEvents = events.filter(
      (e) => e.statusOverride === "Completed" || new Date() > e.endDate
    );

    let totalRevenue       = 0;
    let totalRegistrations = 0;
    let totalAttendance    = 0;

    for (const ev of completedEvents) {
      const regs = await Registration.find({ eventId: ev._id });
      totalRegistrations += regs.length;
      totalAttendance    += regs.filter((r) => r.attended).length;

      if (ev.type === "normal") {
        totalRevenue += regs.length * (ev.registrationFee || 0);
      } else {
        for (const reg of regs) {
          const variant = ev.merchandiseVariants.id(reg.variantId);
          if (variant) totalRevenue += reg.quantity * variant.price;
        }
      }
    }

    res.json({
      organizer,
      eventsSummary: {
        total:       events.length,
        draft:       events.filter((e) => e.statusOverride === "Draft").length,
        published:   events.filter((e) => e.statusOverride === "Published").length,
        ongoing:     events.filter((e) => e.statusOverride === "Ongoing").length,
        completed:   completedEvents.length
      },
      aggregateAnalytics: {
        totalRegistrations,
        totalAttendance,
        totalRevenue
      },
      events: events.map((e) => ({
        id:             e._id,
        name:           e.name,
        type:           e.type,
        statusOverride: e.statusOverride,
        startDate:      e.startDate,
        endDate:        e.endDate
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/password-reset-request", ...guard, async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ message: "Reason is required." });

    const organizer = await Organizer.findOne({ userId: req.user.id });
    if (!organizer) return res.status(404).json({ message: "Organizer not found." });

    // Block if already has a Pending request
    const existing = await PasswordResetRequest.findOne({
      organizerId: organizer._id,
      status:      "Pending"
    });
    if (existing)
      return res.status(400).json({ message: "You already have a pending password reset request." });

    const request = await PasswordResetRequest.create({
      organizerId: organizer._id,
      userId:      req.user.id,
      reason
    });

    res.status(201).json({
      message: "Password reset request submitted. Admin will action it shortly.",
      requestId: request._id
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/password-reset-requests", ...guard, async (req, res) => {
  try {
    const organizer = await Organizer.findOne({ userId: req.user.id });
    if (!organizer) return res.status(404).json({ message: "Organizer not found." });

    const requests = await PasswordResetRequest.find({ organizerId: organizer._id })
      .sort({ createdAt: -1 });

    res.json({ requests });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;