const mongoose = require("mongoose");

const reactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  emoji:  { type: String, required: true }
}, { _id: false });

const messageSchema = new mongoose.Schema(
  {
    eventId:  { type: mongoose.Schema.Types.ObjectId, ref: "Event", required: true },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    content:  { type: String, required: true, maxlength: 2000 },

    // Threading: replies point to a parent message
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: "Message", default: null },

    // Organizer moderation flags
    isPinned:        { type: Boolean, default: false },
    isAnnouncement:  { type: Boolean, default: false },
    isDeleted:       { type: Boolean, default: false },

    reactions: [reactionSchema]
  },
  { timestamps: true }
);

messageSchema.index({ eventId: 1, createdAt: 1 });

module.exports = mongoose.model("Message", messageSchema);