const express = require("express");
const Registration = require("../models/Registration");
const authMiddleware = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");

const router = express.Router();

router.get("/me/events", authMiddleware, roleMiddleware("participant"), async (req, res) => {
  try {
    const participantId = req.user.id;

    const registrations = await Registration.find({ participantId })
      .populate({
        path:   "eventId",
        select: "name type startDate endDate statusOverride organizerId registrationFee",
        populate: { path: "organizerId", select: "organizerName category" }
      })
      .sort({ createdAt: -1 });

    const dashboard = {
      upcoming: [],
      history: {
        normal:            [],
        merchandise:       [],
        completed:         [],
        cancelledRejected: []
      }
    };

    const now = new Date();

    registrations.forEach((reg) => {
      if (!reg.eventId) return; // skip orphan registrations

      const event       = reg.eventId;
      const isCompleted = event.statusOverride === "Completed" || event.endDate < now;
      const isCancelled = event.statusOverride === "Closed";
      const isUpcoming  = event.startDate > now && !isCompleted && !isCancelled;

      const record = {
        registrationId:   reg._id,
        ticketId:         reg.ticketId,
        eventName:        event.name,
        eventType:        event.type,
        organizerName:    event.organizerId?.organizerName || "Unknown",
        schedule:         { start: event.startDate, end: event.endDate },
        participationStatus: reg.paymentStatus === "Rejected"
          ? "Rejected"
          : reg.attended
          ? "Attended"
          : "Registered",
        paymentStatus: reg.paymentStatus
      };

      if (reg.paymentStatus === "Rejected" || isCancelled) {
        dashboard.history.cancelledRejected.push(record);
      } else if (isCompleted || reg.attended) {
        dashboard.history.completed.push(record);
      } else {
        if (isUpcoming) dashboard.upcoming.push(record);
        if (event.type === "normal")       dashboard.history.normal.push(record);
        else if (event.type === "merchandise") dashboard.history.merchandise.push(record);
      }
    });

    res.json({ message: "Dashboard fetched.", dashboard });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;