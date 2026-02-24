const mongoose = require("mongoose");

const organizerSchema = new mongoose.Schema(
  {
    organizerName:     { type: String, required: true },
    category:          { type: String, required: true },
    description:       { type: String, required: true },
    contactEmail:      { type: String, required: true, unique: true },
    contactNumber:     { type: String },
    discordWebhookUrl: { type: String },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Organizer", organizerSchema);