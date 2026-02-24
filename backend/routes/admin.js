const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");
const User = require("../models/User");
const Organizer = require("../models/Organiser");
const Event = require("../models/Event");
const Registration = require("../models/Registration");
const Message = require("../models/Message");
const PasswordResetRequest = require("../models/PasswordResetRequest");
const authMiddleware = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");

const router = express.Router();
const guard = [authMiddleware, roleMiddleware("admin")];

router.get("/organizers", ...guard, async (req, res) => {
  try {
    const organizers = await Organizer.find()
      .populate("userId", "email isActive createdAt");
    res.json({ count: organizers.length, organizers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/organizers", ...guard, async (req, res) => {
  try {
    const { organizerName, category, description } = req.body;

    if (!organizerName || !category || !description) {
      return res.status(400).json({ message: "All fields are required." });
    }

    const cleanName = organizerName.toLowerCase().replace(/[^a-z0-9]/g, "");
    const generatedEmail = `${cleanName}-iiit@clubs.iiit.ac.in`;

    const existing = await User.findOne({ email: generatedEmail });
    if (existing) {
      return res.status(400).json({ message: "An organizer with this name already exists." });
    }

    const generatedPassword = crypto.randomBytes(6).toString("hex"); // 12-char hex

    const newUser = await User.create({
      firstName: organizerName,
      lastName:  "Club",
      email:     generatedEmail,
      password:  generatedPassword,
      role:      "organizer",
      isActive:  true
    });

    const newOrganizer = await Organizer.create({
      organizerName,
      category,
      description,
      contactEmail: generatedEmail,
      userId:       newUser._id
    });

    res.status(201).json({
      message: "Organizer created.",
      organizer: newOrganizer,
      credentials: {
        email:    generatedEmail,
        password: generatedPassword   // Plaintext returned ONCE - not stored
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/organizers/:userId/toggle-status", ...guard, async (req, res) => {
  try {
    const user = await User.findOne({ _id: req.params.userId, role: "organizer" });
    if (!user) return res.status(404).json({ message: "Organizer not found." });

    user.isActive = !user.isActive;
    await user.save();

    res.json({
      message: `Account ${user.isActive ? "enabled" : "disabled"}.`,
      isActive: user.isActive
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/organizers/:userId", ...guard, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const user = await User.findOne({ _id: req.params.userId, role: "organizer" });
    if (!user) return res.status(404).json({ message: "Organizer not found." });

    const organizer = await Organizer.findOne({ userId: user._id });
    if (!organizer) return res.status(404).json({ message: "Organizer profile not found." });

    // 1. Find all events by this organizer
    const events = await Event.find({ organizerId: organizer._id });
    const eventIds = events.map((e) => e._id);

    // 2. Delete all messages in those event forums
    await Message.deleteMany({ eventId: { $in: eventIds } }, { session });

    // 3. Delete all registrations for those events
    await Registration.deleteMany({ eventId: { $in: eventIds } }, { session });

    // 4. Delete all events
    await Event.deleteMany({ organizerId: organizer._id }, { session });

    // 5. Delete password reset requests from this organizer
    await PasswordResetRequest.deleteMany({ organizerId: organizer._id }, { session });

    // 6. Delete organizer profile
    await Organizer.findByIdAndDelete(organizer._id, { session });

    // 7. Delete user account
    await User.findByIdAndDelete(user._id, { session });

    await session.commitTransaction();
    session.endSession();

    res.json({
      message: "Organizer and all associated data permanently deleted.",
      deletedEventCount: eventIds.length
    });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    res.status(500).json({ error: err.message });
  }
});

// List all requests
router.get("/password-reset-requests", ...guard, async (req, res) => {
  try {
    const requests = await PasswordResetRequest.find()
      .populate("organizerId", "organizerName category")
      .populate("userId", "email")
      .sort({ createdAt: -1 });

    res.json({ count: requests.length, requests });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approve request - generate new password, return it to admin
router.put("/password-reset-requests/:id/approve", ...guard, async (req, res) => {
  try {
    const request = await PasswordResetRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ message: "Request not found." });
    if (request.status !== "Pending") {
      return res.status(400).json({ message: "This request has already been actioned." });
    }

    const newPassword = crypto.randomBytes(6).toString("hex");

    // Update organizer user's password
    const user = await User.findById(request.userId);
    if (!user) return res.status(404).json({ message: "Organizer user not found." });
    user.password = newPassword;
    await user.save();

    // Mark request approved
    request.status = "Approved";
    request.adminComment = req.body.comment || "";
    await request.save();

    res.json({
      message: "Password reset approved. Share this password securely with the organizer.",
      newPassword,  // Plaintext returned ONCE to admin - not stored in DB
      request
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reject request
router.put("/password-reset-requests/:id/reject", ...guard, async (req, res) => {
  try {
    const request = await PasswordResetRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ message: "Request not found." });
    if (request.status !== "Pending") {
      return res.status(400).json({ message: "This request has already been actioned." });
    }

    request.status = "Rejected";
    request.adminComment = req.body.comment || "";
    await request.save();

    res.json({ message: "Request rejected.", request });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;