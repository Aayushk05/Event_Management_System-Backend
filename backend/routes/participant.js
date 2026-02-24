const express = require("express");
const User = require("../models/User");
const Organizer = require("../models/Organiser");
const authMiddleware = require("../middleware/authMiddleware");
const roleMiddleware = require("../middleware/roleMiddleware");

const router = express.Router();
const guard = [authMiddleware, roleMiddleware("participant")];

router.get("/profile", ...guard, async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .select("-password")
      .populate("followedOrganizers", "organizerName category description contactEmail");
    if (!user) return res.status(404).json({ message: "User not found." });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/profile", ...guard, async (req, res) => {
  try {
    const { firstName, lastName, contactNumber, collegeName } = req.body;

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found." });

    // email and participantType are non-editable per spec
    if (firstName)     user.firstName     = firstName;
    if (lastName)      user.lastName      = lastName;
    if (contactNumber) user.contactNumber = contactNumber;
    if (collegeName)   user.collegeName   = collegeName;

    await user.save();
    res.json({ message: "Saved.", user: { firstName: user.firstName, lastName: user.lastName, contactNumber: user.contactNumber, collegeName: user.collegeName } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/change-password", ...guard, async (req, res) => {
  try {
    const bcrypt = require("bcrypt");
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword)
      return res.status(400).json({ message: "Both currentPassword and newPassword are required." });
    if (newPassword.length < 6)
      return res.status(400).json({ message: "New password must be at least 6 characters." });

    const user = await User.findById(req.user.id);
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch)
      return res.status(400).json({ message: "Current password is incorrect." });

    user.password = newPassword;
    await user.save();
    res.json({ message: "Password changed." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/preferences", ...guard, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "User not found." });

    if (Array.isArray(req.body.areasOfInterest))
      user.areasOfInterest = req.body.areasOfInterest;
    if (Array.isArray(req.body.followedOrganizers))
      user.followedOrganizers = req.body.followedOrganizers;

    await user.save();
    res.json({
      message: "Saved.",
      areasOfInterest:    user.areasOfInterest,
      followedOrganizers: user.followedOrganizers
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/preferences", ...guard, async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .select("areasOfInterest followedOrganizers")
      .populate("followedOrganizers", "organizerName category");
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/follow/:organizerId", ...guard, async (req, res) => {
  try {
    const organizer = await Organizer.findById(req.params.organizerId);
    if (!organizer) return res.status(404).json({ message: "Organizer not found." });

    const user = await User.findById(req.user.id);
    if (user.followedOrganizers.includes(req.params.organizerId))
      return res.status(400).json({ message: "Already following this organizer." });

    user.followedOrganizers.push(req.params.organizerId);
    await user.save();
    res.json({ message: `Now following ${organizer.organizerName}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/follow/:organizerId", ...guard, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    user.followedOrganizers = user.followedOrganizers.filter(
      (id) => id.toString() !== req.params.organizerId
    );
    await user.save();
    res.json({ message: "Unfollowed." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/clubs", authMiddleware, async (req, res) => {
  try {
    // Available to all logged-in users (not just participants)
    const organizers = await Organizer.find()
      .select("organizerName category description contactEmail")
      .sort({ organizerName: 1 });

    // If participant: mark which ones they follow
    let followedIds = [];
    if (req.user.role === "participant") {
      const user = await User.findById(req.user.id).select("followedOrganizers");
      followedIds = (user.followedOrganizers || []).map((id) => id.toString());
    }

    const result = organizers.map((o) => ({
      ...o.toObject(),
      isFollowing: followedIds.includes(o._id.toString())
    }));

    res.json({ count: result.length, organizers: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/clubs/:organizerId", authMiddleware, async (req, res) => {
  try {
    const organizer = await Organizer.findById(req.params.organizerId)
      .select("organizerName category description contactEmail contactNumber");
    if (!organizer) return res.status(404).json({ message: "Organizer not found." });

    const now = new Date();
    const Event = require("../models/Event");
    const allEvents = await Event.find({ organizerId: organizer._id })
      .select("name type startDate endDate statusOverride registrationFee eligibility");

    const upcoming = allEvents.filter((e) => e.startDate > now && !["Draft", "Closed"].includes(e.statusOverride));
    const past     = allEvents.filter((e) => e.endDate < now || e.statusOverride === "Completed");

    let isFollowing = false;
    if (req.user.role === "participant") {
      const user = await User.findById(req.user.id).select("followedOrganizers");
      isFollowing = (user.followedOrganizers || []).map(String).includes(organizer._id.toString());
    }

    res.json({ organizer, isFollowing, events: { upcoming, past } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;