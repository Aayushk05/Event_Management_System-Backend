const express = require("express");
const { Parser } = require("json2csv");
const ics = require("ics");
const Event = require("../models/Event");
const Organizer = require("../models/Organiser");
const Registration = require("../models/Registration");
const User = require("../models/User");
const authMiddleware = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");
const sendTicketEmail = require("../utils/emailService");
const postEventToDiscord = require("../utils/discordService");

const router = express.Router();

const generateTicketId = () =>
  `TKT-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

const getEffectiveStatus = (event) => {
  if (["Draft", "Closed"].includes(event.statusOverride)) return event.statusOverride;
  if (event.statusOverride === "Completed") return "Completed";
  const now = new Date();
  if (now < event.startDate) return "Published";
  if (now >= event.startDate && now <= event.endDate) return "Ongoing";
  return "Completed";
};

const toGCalDate = (d) =>
  new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

// Create Event (Draft)
router.post(
  "/",
  authMiddleware,
  roleMiddleware("organizer"),
  async (req, res) => {
    try {
      const organizer = await Organizer.findOne({ userId: req.user.id });
      if (!organizer) return res.status(404).json({ message: "Organizer profile not found." });

      const event = await Event.create({
        ...req.body,
        organizerId:    organizer._id,
        statusOverride: "Draft"
      });

      res.status(201).json({ message: "Event created as draft.", event });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Edit / Publish Event (with strict status rules)
router.put(
  "/:id",
  authMiddleware,
  roleMiddleware("organizer"),
  async (req, res) => {
    try {
      const organizer = await Organizer.findOne({ userId: req.user.id });
      if (!organizer) return res.status(404).json({ message: "Organizer profile not found." });

      const event = await Event.findById(req.params.id);
      if (!event) return res.status(404).json({ message: "Event not found." });
      if (event.organizerId.toString() !== organizer._id.toString()) {
        return res.status(403).json({ message: "Not authorized." });
      }

      const currentStatus = getEffectiveStatus(event);
      const updates = req.body;
      const wasPublishing =
        currentStatus === "Draft" && updates.statusOverride === "Published";

      if (currentStatus === "Draft") {
        Object.assign(event, updates);
      } else if (currentStatus === "Published") {
        const allowed = ["description", "registrationDeadline", "registrationLimit", "statusOverride"];
        for (const key of Object.keys(updates)) {
          if (!allowed.includes(key))
            return res.status(400).json({ message: `Cannot edit "${key}" once published.` });
          if (key === "registrationDeadline" && new Date(updates[key]) < event.registrationDeadline)
            return res.status(400).json({ message: "Can only extend the deadline." });
          if (key === "registrationLimit" && updates[key] < event.registrationLimit)
            return res.status(400).json({ message: "Can only increase the registration limit." });
          event[key] = updates[key];
        }
      } else if (["Ongoing", "Completed"].includes(currentStatus)) {
        const keys = Object.keys(updates);
        if (keys.length !== 1 || keys[0] !== "statusOverride")
          return res.status(400).json({ message: "Only status can be changed at this stage." });
        event.statusOverride = updates.statusOverride;
      }

      await event.save();

      // Fire Discord webhook when an event is first published
      if (wasPublishing) {
        const org = await Organizer.findById(event.organizerId);
        if (org?.discordWebhookUrl) {
          postEventToDiscord(org.discordWebhookUrl, event); // non-blocking
        }
      }

      res.json({ message: "Saved.", event });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Delete Event (organizer can only delete their own Draft events)
router.delete(
  "/:id",
  authMiddleware,
  roleMiddleware("organizer"),
  async (req, res) => {
    try {
      const organizer = await Organizer.findOne({ userId: req.user.id });
      if (!organizer) return res.status(404).json({ message: "Organizer profile not found." });

      const event = await Event.findById(req.params.id);
      if (!event) return res.status(404).json({ message: "Event not found." });
      if (event.organizerId.toString() !== organizer._id.toString())
        return res.status(403).json({ message: "Not authorized." });
      if (getEffectiveStatus(event) !== "Draft")
        return res.status(400).json({ message: "Only Draft events can be deleted." });

      await Event.findByIdAndDelete(req.params.id);
      await Registration.deleteMany({ eventId: req.params.id });

      res.json({ message: "Event deleted." });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Trending - top 5 events by registrations in last 24h
router.get("/trending", authMiddleware, async (req, res) => {
  try {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const topEventIds = await Registration.aggregate([
      { $match: { createdAt: { $gte: oneDayAgo } } },
      { $group: { _id: "$eventId", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 }
    ]);

    const ids = topEventIds.map((t) => t._id);
    const events = await Event.find({ _id: { $in: ids } })
      .populate("organizerId", "organizerName category");

    // Attach registration counts and sort by them
    const withCounts = events.map((ev) => {
      const entry = topEventIds.find((t) => t._id.toString() === ev._id.toString());
      return { ...ev.toObject(), recentRegistrations: entry?.count || 0, effectiveStatus: getEffectiveStatus(ev) };
    });
    withCounts.sort((a, b) => b.recentRegistrations - a.recentRegistrations);

    res.json({ trending: withCounts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Browse Events with search + filters
router.get("/", authMiddleware, async (req, res) => {
  try {
    const { search, type, eligibility, startDate, endDate, filter } = req.query;
    const now = new Date();

    // Base: only show publicly visible events (not Draft/Closed), not ended
    let query = {
      statusOverride: { $nin: ["Draft", "Closed"] },
      endDate: { $gte: now }
    };

    // Partial/fuzzy search on name and tags
    if (search) {
      query.$or = [
        { name:        { $regex: search, $options: "i" } },
        { tags:        { $elemMatch: { $regex: search, $options: "i" } } },
        { description: { $regex: search, $options: "i" } }
      ];
    }

    if (type)        query.type        = type;
    if (eligibility) query.eligibility = eligibility;

    if (startDate || endDate) {
      query.startDate = {};
      if (startDate) query.startDate.$gte = new Date(startDate);
      if (endDate)   query.startDate.$lte = new Date(endDate);
    }

    // Followed clubs filter
    if (filter === "followed") {
      const user = await User.findById(req.user.id).select("followedOrganizers");
      query.organizerId = { $in: user.followedOrganizers || [] };
    }

    let events = await Event.find(query)
      .populate("organizerId", "organizerName category")
      .sort({ startDate: 1 });

    // Inject effectiveStatus into each event (virtual → toObject)
    const result = events.map((ev) => ({
      ...ev.toObject(),
      effectiveStatus: getEffectiveStatus(ev)
    }));

    res.json({ count: result.length, events: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Single Event Detail
router.get("/:id", authMiddleware, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id)
      .populate("organizerId", "organizerName category description contactEmail contactNumber");

    if (!event) return res.status(404).json({ message: "Event not found." });

    // Check if the participant is already registered (useful for UI)
    let isRegistered = false;
    if (req.user.role === "participant") {
      const reg = await Registration.findOne({
        eventId:       event._id,
        participantId: req.user.id
      });
      isRegistered = !!reg;
    }

    res.json({
      event: { ...event.toObject(), effectiveStatus: getEffectiveStatus(event) },
      isRegistered
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Normal Event Registration
router.post(
  "/:id/register",
  authMiddleware,
  roleMiddleware("participant"),
  async (req, res) => {
    try {
      const event = await Event.findById(req.params.id);
      const participant = await User.findById(req.user.id);

      if (!event) return res.status(404).json({ message: "Event not found." });
      if (event.type !== "normal")
        return res.status(400).json({ message: "Use /order for merchandise events." });

      const status = getEffectiveStatus(event);
      if (!["Published", "Ongoing"].includes(status))
        return res.status(400).json({ message: `Registration not available (event is ${status}).` });
      if (new Date() > event.registrationDeadline)
        return res.status(400).json({ message: "Registration deadline has passed." });

      // Eligibility check
      if (event.eligibility === "iiit" && participant.participantType !== "iiit")
        return res.status(403).json({ message: "This event is for IIIT students only." });
      if (event.eligibility === "non-iiit" && participant.participantType !== "non-iiit")
        return res.status(403).json({ message: "This event is for non-IIIT participants only." });

      // Capacity check
      if (event.registrationLimit) {
        const count = await Registration.countDocuments({ eventId: event._id });
        if (count >= event.registrationLimit)
          return res.status(400).json({ message: "Registration limit reached." });
      }

      const existing = await Registration.findOne({ eventId: event._id, participantId: req.user.id });
      if (existing) return res.status(400).json({ message: "Already registered." });

      const ticketId = generateTicketId();

      const registration = await Registration.create({
        eventId:       event._id,
        participantId: req.user.id,
        ticketId,
        formData:      req.body.formData || {},
        paymentStatus: "Not Applicable"
      });

      // Lock form after first registration
      if (!event.isFormLocked) {
        event.isFormLocked = true;
        await event.save();
      }

      sendTicketEmail(participant.email, ticketId, event.name, participant.firstName);

      res.status(201).json({ message: "Registered.", ticketId, registration });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Place Merchandise Order
router.post(
  "/:id/order",
  authMiddleware,
  roleMiddleware("participant"),
  async (req, res) => {
    try {
      const event = await Event.findById(req.params.id);
      const participant = await User.findById(req.user.id);

      if (!event) return res.status(404).json({ message: "Event not found." });
      if (event.type !== "merchandise")
        return res.status(400).json({ message: "This endpoint is for merchandise events only." });

      const status = getEffectiveStatus(event);
      if (!["Published", "Ongoing"].includes(status))
        return res.status(400).json({ message: `Orders not available (event is ${status}).` });
      if (new Date() > event.registrationDeadline)
        return res.status(400).json({ message: "Order deadline has passed." });

      // Eligibility
      if (event.eligibility === "iiit" && participant.participantType !== "iiit")
        return res.status(403).json({ message: "This event is for IIIT students only." });
      if (event.eligibility === "non-iiit" && participant.participantType !== "non-iiit")
        return res.status(403).json({ message: "This event is for non-IIIT participants only." });

      const { variantId, quantity = 1 } = req.body;
      if (!variantId) return res.status(400).json({ message: "variantId is required." });

      const variant = event.merchandiseVariants.id(variantId);
      if (!variant) return res.status(404).json({ message: "Variant not found." });

      // Check per-user purchase limit
      const pastOrders = await Registration.find({ eventId: event._id, participantId: req.user.id });
      const totalBought = pastOrders.reduce((sum, r) => sum + (r.quantity || 0), 0);
      if (totalBought + quantity > event.purchaseLimitPerUser)
        return res.status(400).json({ message: `Purchase limit per user is ${event.purchaseLimitPerUser}.` });

      // Duplicate check (one registration doc per user per event)
      const existing = await Registration.findOne({ eventId: event._id, participantId: req.user.id });
      if (existing)
        return res.status(400).json({ message: "You already have an active order for this event." });

      if (event.requiresPaymentApproval) {
        const registration = await Registration.create({
          eventId:       event._id,
          participantId: req.user.id,
          variantId,
          quantity,
          paymentStatus: "Pending"
          // ticketId generated only after approval
        });
        return res.status(201).json({
          message: "Order placed. Please upload your payment proof.",
          registrationId: registration._id,
          registration
        });
      } else {
        if (variant.stock < quantity)
          return res.status(400).json({ message: "Insufficient stock." });

        variant.stock -= quantity;
        await event.save();

        const ticketId = generateTicketId();
        const registration = await Registration.create({
          eventId:       event._id,
          participantId: req.user.id,
          ticketId,
          variantId,
          quantity,
          paymentStatus: "Approved"
        });

        sendTicketEmail(participant.email, ticketId, event.name, participant.firstName);
        return res.status(201).json({ message: "Order placed.", ticketId, registration });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Upload Payment Proof URL (participant)
router.patch(
  "/:id/orders/:regId/proof",
  authMiddleware,
  roleMiddleware("participant"),
  async (req, res) => {
    try {
      const { paymentProofUrl } = req.body;
      if (!paymentProofUrl)
        return res.status(400).json({ message: "paymentProofUrl is required." });

      const reg = await Registration.findOne({
        _id:           req.params.regId,
        eventId:       req.params.id,
        participantId: req.user.id
      });
      if (!reg) return res.status(404).json({ message: "Order not found." });
      if (reg.paymentStatus !== "Pending")
        return res.status(400).json({ message: "Only Pending orders can have proof uploaded." });

      reg.paymentProofUrl = paymentProofUrl;
      await reg.save();

      res.json({ message: "Payment proof submitted. Awaiting organizer approval.", registration: reg });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// List Pending Orders (organizer)
router.get(
  "/:id/orders/pending",
  authMiddleware,
  roleMiddleware("organizer"),
  async (req, res) => {
    try {
      const organizer = await Organizer.findOne({ userId: req.user.id });
      if (!organizer) return res.status(404).json({ message: "Organizer profile not found." });

      const event = await Event.findById(req.params.id);
      if (!event) return res.status(404).json({ message: "Event not found." });
      if (event.organizerId.toString() !== organizer._id.toString())
        return res.status(403).json({ message: "Not authorized." });

      const orders = await Registration.find({
        eventId:       event._id,
        paymentStatus: "Pending"
      }).populate("participantId", "firstName lastName email contactNumber");

      const result = orders.map((o) => {
        const variant = event.merchandiseVariants.id(o.variantId);
        return {
          registrationId:  o._id,
          participant:     o.participantId,
          variant:         variant ? { size: variant.size, color: variant.color, price: variant.price } : null,
          quantity:        o.quantity,
          paymentProofUrl: o.paymentProofUrl,
          paymentStatus:   o.paymentStatus,
          placedAt:        o.createdAt
        };
      });

      res.json({ count: result.length, orders: result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Approve Order (organizer)
router.put(
  "/:id/orders/:regId/approve",
  authMiddleware,
  roleMiddleware("organizer"),
  async (req, res) => {
    try {
      const organizer = await Organizer.findOne({ userId: req.user.id });
      if (!organizer) return res.status(404).json({ message: "Organizer profile not found." });

      const event = await Event.findById(req.params.id);
      if (!event) return res.status(404).json({ message: "Event not found." });
      if (event.organizerId.toString() !== organizer._id.toString())
        return res.status(403).json({ message: "Not authorized." });

      const reg = await Registration.findOne({ _id: req.params.regId, eventId: event._id });
      if (!reg) return res.status(404).json({ message: "Order not found." });
      if (reg.paymentStatus !== "Pending")
        return res.status(400).json({ message: "Only Pending orders can be approved." });

      const variant = event.merchandiseVariants.id(reg.variantId);
      if (!variant || variant.stock < reg.quantity)
        return res.status(400).json({ message: "Insufficient stock to approve." });

      variant.stock -= reg.quantity;
      await event.save();

      const ticketId = generateTicketId();
      reg.paymentStatus = "Approved";
      reg.ticketId      = ticketId;
      await reg.save();

      const participant = await User.findById(reg.participantId);
      sendTicketEmail(participant.email, ticketId, event.name, participant.firstName);

      res.json({ message: "Order approved. Ticket generated and email sent.", ticketId });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Reject Order (organizer)
router.put(
  "/:id/orders/:regId/reject",
  authMiddleware,
  roleMiddleware("organizer"),
  async (req, res) => {
    try {
      const organizer = await Organizer.findOne({ userId: req.user.id });
      if (!organizer) return res.status(404).json({ message: "Organizer profile not found." });

      const event = await Event.findById(req.params.id);
      if (!event) return res.status(404).json({ message: "Event not found." });
      if (event.organizerId.toString() !== organizer._id.toString())
        return res.status(403).json({ message: "Not authorized." });

      const reg = await Registration.findOne({ _id: req.params.regId, eventId: event._id });
      if (!reg) return res.status(404).json({ message: "Order not found." });
      if (reg.paymentStatus !== "Pending")
        return res.status(400).json({ message: "Only Pending orders can be rejected." });

      reg.paymentStatus = "Rejected";
      await reg.save();

      res.json({ message: "Order rejected." });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

router.get(
  "/:id/organizer-details",
  authMiddleware,
  roleMiddleware("organizer"),
  async (req, res) => {
    try {
      const organizer = await Organizer.findOne({ userId: req.user.id });
      if (!organizer) return res.status(404).json({ message: "Organizer profile not found." });

      const event = await Event.findById(req.params.id);
      if (!event) return res.status(404).json({ message: "Event not found." });
      if (event.organizerId.toString() !== organizer._id.toString())
        return res.status(403).json({ message: "Not authorized." });

      const registrations = await Registration.find({ eventId: event._id })
        .populate("participantId", "firstName lastName email participantType collegeName")
        .sort({ createdAt: -1 });

      const totalRegistrations = registrations.length;
      const attendedCount      = registrations.filter((r) => r.attended).length;

      let totalRevenue = 0;
      if (event.type === "normal") {
        totalRevenue = totalRegistrations * (event.registrationFee || 0);
      } else {
        registrations.forEach((reg) => {
          const variant = event.merchandiseVariants.id(reg.variantId);
          if (variant) totalRevenue += reg.quantity * variant.price;
        });
      }

      const participantsList = registrations.map((reg) => ({
        name:             `${reg.participantId.firstName} ${reg.participantId.lastName}`,
        email:            reg.participantId.email,
        participantType:  reg.participantId.participantType,
        college:          reg.participantId.collegeName,
        registrationDate: reg.createdAt,
        paymentStatus:    reg.paymentStatus,
        attendance:       reg.attended ? "Present" : "Absent",
        formData:         Object.fromEntries(reg.formData || new Map()),
        ticketId:         reg.ticketId
      }));

      res.json({
        overview: {
          name:        event.name,
          type:        event.type,
          status:      getEffectiveStatus(event),
          dates:       { start: event.startDate, end: event.endDate },
          eligibility: event.eligibility,
          pricing:     event.registrationFee
        },
        analytics: {
          totalRegistrations,
          attendanceCount:        attendedCount,
          attendanceRate:         totalRegistrations > 0 ? ((attendedCount / totalRegistrations) * 100).toFixed(1) + "%" : "0%",
          revenue:                totalRevenue
        },
        participants: participantsList
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Export Participants as CSV
router.get(
  "/:id/export-participants",
  authMiddleware,
  roleMiddleware("organizer"),
  async (req, res) => {
    try {
      const organizer = await Organizer.findOne({ userId: req.user.id });
      if (!organizer) return res.status(404).json({ message: "Organizer profile not found." });

      const event     = await Event.findById(req.params.id);
      if (!event) return res.status(404).json({ message: "Event not found." });
      if (event.organizerId.toString() !== organizer._id.toString())
        return res.status(403).json({ message: "Not authorized." });

      const registrations = await Registration.find({ eventId: event._id })
        .populate("participantId", "firstName lastName email participantType collegeName")
        .lean();

      const data = registrations.map((reg) => ({
        Name:            `${reg.participantId.firstName} ${reg.participantId.lastName}`,
        Email:           reg.participantId.email,
        Type:            reg.participantId.participantType,
        College:         reg.participantId.collegeName || "",
        RegistrationDate: new Date(reg.createdAt).toLocaleDateString(),
        PaymentStatus:   reg.paymentStatus,
        Attendance:      reg.attended ? "Present" : "Absent",
        TicketID:        reg.ticketId || "",
        ...(reg.formData ? Object.fromEntries(Object.entries(reg.formData)) : {})
      }));

      const csv = new Parser().parse(data);
      res.header("Content-Type", "text/csv");
      res.attachment(`${event.name.replace(/\s+/g, "_")}_Participants.csv`);
      return res.send(csv);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Scan QR Code - mark attendance
router.post(
  "/:id/scan",
  authMiddleware,
  roleMiddleware("organizer"),
  async (req, res) => {
    try {
      const { ticketId } = req.body;
      if (!ticketId) return res.status(400).json({ message: "ticketId is required." });

      const organizer = await Organizer.findOne({ userId: req.user.id });
      if (!organizer) return res.status(404).json({ message: "Organizer profile not found." });

      const event     = await Event.findById(req.params.id);
      if (!event) return res.status(404).json({ message: "Event not found." });
      if (event.organizerId.toString() !== organizer._id.toString())
        return res.status(403).json({ message: "Not authorized." });

      const reg = await Registration.findOne({ ticketId })
        .populate("participantId", "firstName lastName email participantType");
      if (!reg) return res.status(404).json({ message: "Ticket not found." });
      if (reg.eventId.toString() !== req.params.id)
        return res.status(400).json({ message: "This ticket belongs to a different event." });

      if (reg.attended) {
        return res.status(409).json({
          message: "Duplicate scan - already marked present.",
          alreadyScannedAt: reg.attendanceTimestamp,
          participant: reg.participantId
        });
      }

      reg.attended            = true;
      reg.attendanceTimestamp = new Date();
      await reg.save();

      // Return live attendance count
      const totalRegs   = await Registration.countDocuments({ eventId: event._id });
      const totalScanned = await Registration.countDocuments({ eventId: event._id, attended: true });

      res.json({
        message: "Attendance marked.",
        participant: reg.participantId,
        attendanceTimestamp: reg.attendanceTimestamp,
        liveDashboard: { totalRegistrations: totalRegs, scanned: totalScanned, remaining: totalRegs - totalScanned }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Live Attendance Dashboard
router.get(
  "/:id/attendance",
  authMiddleware,
  roleMiddleware("organizer"),
  async (req, res) => {
    try {
      const organizer = await Organizer.findOne({ userId: req.user.id });
      if (!organizer) return res.status(404).json({ message: "Organizer profile not found." });

      const event     = await Event.findById(req.params.id);
      if (!event) return res.status(404).json({ message: "Event not found." });
      if (event.organizerId.toString() !== organizer._id.toString())
        return res.status(403).json({ message: "Not authorized." });

      const registrations = await Registration.find({ eventId: event._id })
        .populate("participantId", "firstName lastName email participantType")
        .sort({ attendanceTimestamp: -1 });

      const scanned     = registrations.filter((r) => r.attended);
      const notScanned  = registrations.filter((r) => !r.attended);

      res.json({
        summary: {
          total:      registrations.length,
          present:    scanned.length,
          absent:     notScanned.length,
          rate:       registrations.length > 0 ? ((scanned.length / registrations.length) * 100).toFixed(1) + "%" : "0%"
        },
        scanned: scanned.map((r) => ({
          participant:         r.participantId,
          ticketId:            r.ticketId,
          attendanceTimestamp: r.attendanceTimestamp,
          manualOverride:      r.manualOverride
        })),
        notScanned: notScanned.map((r) => ({
          participant: r.participantId,
          ticketId:    r.ticketId
        }))
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Manual Attendance Override (with audit log)
router.put(
  "/:id/attendance/:regId/override",
  authMiddleware,
  roleMiddleware("organizer"),
  async (req, res) => {
    try {
      const { attended, reason } = req.body;
      if (typeof attended !== "boolean" || !reason)
        return res.status(400).json({ message: "attended (boolean) and reason are required." });

      const organizer = await Organizer.findOne({ userId: req.user.id });
      if (!organizer) return res.status(404).json({ message: "Organizer profile not found." });

      const event     = await Event.findById(req.params.id);
      if (!event) return res.status(404).json({ message: "Event not found." });
      if (event.organizerId.toString() !== organizer._id.toString())
        return res.status(403).json({ message: "Not authorized." });

      const reg = await Registration.findOne({ _id: req.params.regId, eventId: event._id });
      if (!reg) return res.status(404).json({ message: "Registration not found." });

      reg.attended            = attended;
      reg.attendanceTimestamp = attended ? new Date() : null;
      reg.manualOverride      = true;
      reg.overrideReason      = reason;
      reg.overriddenBy        = req.user.id;
      await reg.save();

      res.json({ message: `Attendance manually set to ${attended ? "Present" : "Absent"}.`, registration: reg });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Export Attendance as CSV
router.get(
  "/:id/attendance/export",
  authMiddleware,
  roleMiddleware("organizer"),
  async (req, res) => {
    try {
      const organizer = await Organizer.findOne({ userId: req.user.id });
      if (!organizer) return res.status(404).json({ message: "Organizer profile not found." });

      const event     = await Event.findById(req.params.id);
      if (!event) return res.status(404).json({ message: "Event not found." });
      if (event.organizerId.toString() !== organizer._id.toString())
        return res.status(403).json({ message: "Not authorized." });

      const registrations = await Registration.find({ eventId: event._id })
        .populate("participantId", "firstName lastName email participantType collegeName")
        .lean();

      const data = registrations.map((reg) => ({
        Name:            `${reg.participantId.firstName} ${reg.participantId.lastName}`,
        Email:           reg.participantId.email,
        Type:            reg.participantId.participantType,
        TicketID:        reg.ticketId || "",
        Attendance:      reg.attended ? "Present" : "Absent",
        ScannedAt:       reg.attendanceTimestamp ? new Date(reg.attendanceTimestamp).toLocaleString() : "",
        ManualOverride:  reg.manualOverride ? "Yes" : "No",
        OverrideReason:  reg.overrideReason || ""
      }));

      const csv = new Parser().parse(data);
      res.header("Content-Type", "text/csv");
      res.attachment(`${event.name.replace(/\s+/g, "_")}_Attendance.csv`);
      return res.send(csv);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// Download .ics file
router.get("/:id/calendar.ics", authMiddleware, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id)
      .populate("organizerId", "organizerName");
    if (!event) return res.status(404).json({ message: "Event not found." });

    const start = new Date(event.startDate);
    const end   = new Date(event.endDate);

    const icsString = await new Promise((resolve, reject) => {
      ics.createEvent(
        {
          title:       event.name,
          description: event.description,
          start: [
            start.getFullYear(), start.getMonth() + 1, start.getDate(),
            start.getHours(), start.getMinutes()
          ],
          end: [
            end.getFullYear(), end.getMonth() + 1, end.getDate(),
            end.getHours(), end.getMinutes()
          ],
          uid:         `${event._id}@felicity.iiit.ac.in`,
          organizer:   { name: event.organizerId?.organizerName || "Felicity" },
          url:         `${process.env.FRONTEND_URL || "http://localhost:3000"}/events/${event._id}`
        },
        (error, value) => (error ? reject(error) : resolve(value))
      );
    });

    res.header("Content-Type", "text/calendar; charset=utf-8");
    res.attachment(`${event.name.replace(/\s+/g, "_")}.ics`);
    return res.send(icsString);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get Google Calendar + Outlook links
router.get("/:id/calendar-links", authMiddleware, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ message: "Event not found." });

    const gcalParams = new URLSearchParams({
      action:  "TEMPLATE",
      text:    event.name,
      dates:   `${toGCalDate(event.startDate)}/${toGCalDate(event.endDate)}`,
      details: event.description.substring(0, 500),
      sprop:   `website:${process.env.FRONTEND_URL || "http://localhost:3000"}`
    });

    const outlookParams = new URLSearchParams({
      subject:  event.name,
      startdt:  new Date(event.startDate).toISOString(),
      enddt:    new Date(event.endDate).toISOString(),
      body:     event.description.substring(0, 500)
    });

    res.json({
      googleCalendar: `https://www.google.com/calendar/render?${gcalParams.toString()}`,
      outlookLive:    `https://outlook.live.com/calendar/0/deeplink/compose?${outlookParams.toString()}`,
      icsDownload:    `/api/events/${event._id}/calendar.ics`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;