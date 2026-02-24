const express = require("express");
const Message = require("../models/Message");
const Registration = require("../models/Registration");
const Organizer = require("../models/Organiser");
const Event = require("../models/Event");
const authMiddleware = require("../middleware/authMiddleware");
const { getIo } = require("../socket");

const router = express.Router();

const canAccessForum = async (userId, userRole, eventId) => {
  if (userRole === "admin") return true;
  if (userRole === "organizer") {
    const organizer = await Organizer.findOne({ userId });
    const event     = await Event.findById(eventId);
    return event && organizer && event.organizerId.toString() === organizer._id.toString();
  }
  if (userRole === "participant") {
    const reg = await Registration.findOne({ participantId: userId, eventId });
    return !!reg;
  }
  return false;
};

// GET /api/events/:id/forum
router.get("/:id/forum", authMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 50, parentId = null } = req.query;

    const filter = {
      eventId:   req.params.id,
      isDeleted: false,
      parentId:  parentId || null
    };

    const messages = await Message.find(filter)
      .populate("authorId", "firstName lastName role")
      .sort({ isPinned: -1, createdAt: 1 })  // Pinned first, then chronological
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    const total = await Message.countDocuments(filter);

    // For each top-level message, attach reply count
    const withReplyCounts = await Promise.all(
      messages.map(async (msg) => {
        const replyCount = await Message.countDocuments({
          parentId:  msg._id,
          isDeleted: false
        });
        return { ...msg.toObject(), replyCount };
      })
    );

    res.json({ total, page: parseInt(page), messages: withReplyCounts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/events/:id/forum
router.post("/:id/forum", authMiddleware, async (req, res) => {
  try {
    const { content, parentId, isAnnouncement = false } = req.body;

    if (!content?.trim())
      return res.status(400).json({ message: "Message content cannot be empty." });

    const canPost = await canAccessForum(req.user.id, req.user.role, req.params.id);
    if (!canPost)
      return res.status(403).json({ message: "Only registered participants or the event organizer can post here." });

    // Only organizers can post announcements
    if (isAnnouncement && req.user.role !== "organizer")
      return res.status(403).json({ message: "Only organizers can post announcements." });

    const message = await Message.create({
      eventId:        req.params.id,
      authorId:       req.user.id,
      content:        content.trim(),
      parentId:       parentId || null,
      isAnnouncement: isAnnouncement && req.user.role === "organizer"
    });

    const populated = await Message.findById(message._id)
      .populate("authorId", "firstName lastName role");

    // Emit real-time event to everyone in this forum room
    const io = getIo();
    const eventName = isAnnouncement ? "new_announcement" : "new_message";
    io.to(`forum_${req.params.id}`).emit(eventName, populated);

    res.status(201).json({ message: "Sent.", data: populated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/events/:id/forum/:messageId
router.delete("/:id/forum/:messageId", authMiddleware, async (req, res) => {
  try {
    const msg = await Message.findById(req.params.messageId);
    if (!msg || msg.eventId.toString() !== req.params.id)
      return res.status(404).json({ message: "Message not found." });

    // Organizer can delete any message; author can delete their own
    let canDelete = false;
    if (req.user.role === "organizer") {
      const organizer = await Organizer.findOne({ userId: req.user.id });
      const event     = await Event.findById(req.params.id);
      canDelete = !!(event && organizer && event.organizerId.toString() === organizer._id.toString());
    } else if (msg.authorId.toString() === req.user.id) {
      canDelete = true;
    }

    if (!canDelete)
      return res.status(403).json({ message: "Not authorized to delete this message." });

    msg.isDeleted = true;
    msg.content   = "[Message deleted]";
    await msg.save();

    const io = getIo();
    io.to(`forum_${req.params.id}`).emit("message_deleted", { messageId: msg._id });

    res.json({ message: "Deleted." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/events/:id/forum/:messageId/pin
router.put("/:id/forum/:messageId/pin", authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== "organizer")
      return res.status(403).json({ message: "Only organizers can pin messages." });

    const organizer = await Organizer.findOne({ userId: req.user.id });
    const event     = await Event.findById(req.params.id);
    if (!event || !organizer || event.organizerId.toString() !== organizer._id.toString())
      return res.status(403).json({ message: "Not your event." });

    const msg = await Message.findById(req.params.messageId);
    if (!msg) return res.status(404).json({ message: "Message not found." });

    msg.isPinned = !msg.isPinned;
    await msg.save();

    const io = getIo();
    io.to(`forum_${req.params.id}`).emit("message_pinned", {
      messageId: msg._id,
      isPinned:  msg.isPinned
    });

    res.json({ message: `Message ${msg.isPinned ? "pinned" : "unpinned"}.` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/events/:id/forum/:messageId/react
router.post("/:id/forum/:messageId/react", authMiddleware, async (req, res) => {
  try {
    const { emoji } = req.body;
    if (!emoji) return res.status(400).json({ message: "emoji is required." });

    const canPost = await canAccessForum(req.user.id, req.user.role, req.params.id);
    if (!canPost)
      return res.status(403).json({ message: "Must be a registered participant or organizer." });

    const msg = await Message.findById(req.params.messageId);
    if (!msg) return res.status(404).json({ message: "Message not found." });

    // Toggle reaction: if same user + same emoji exists, remove it
    const existingIdx = msg.reactions.findIndex(
      (r) => r.userId.toString() === req.user.id && r.emoji === emoji
    );

    if (existingIdx >= 0) {
      msg.reactions.splice(existingIdx, 1);
    } else {
      msg.reactions.push({ userId: req.user.id, emoji });
    }

    await msg.save();

    const io = getIo();
    io.to(`forum_${req.params.id}`).emit("reaction_updated", {
      messageId: msg._id,
      reactions: msg.reactions
    });

    res.json({ message: "Reaction updated.", reactions: msg.reactions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;