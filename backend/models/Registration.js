const mongoose = require("mongoose");

const registrationSchema = new mongoose.Schema(
  {
    eventId:       { type: mongoose.Schema.Types.ObjectId, ref: "Event", required: true },
    participantId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    // Generated only when registration is complete / merch order is Approved
    ticketId: { type: String, unique: true, sparse: true },

    // Normal event: stores answers to custom form as key-value pairs
    formData: { type: Map, of: mongoose.Schema.Types.Mixed },

    // Merchandise order fields
    variantId: { type: mongoose.Schema.Types.ObjectId },
    quantity:  { type: Number, default: 1 },
    paymentProofUrl: { type: String },
    paymentStatus: {
      type: String,
      enum: ["Not Applicable", "Pending", "Approved", "Rejected"],
      default: "Not Applicable"
    },
    attended:             { type: Boolean, default: false },
    attendanceTimestamp:  { type: Date },
    manualOverride:       { type: Boolean, default: false },
    overrideReason:       { type: String },
    overriddenBy:         { type: mongoose.Schema.Types.ObjectId, ref: "User" }
  },
  { timestamps: true }
);

// One registration per participant per event (unique compound index)
registrationSchema.index({ eventId: 1, participantId: 1 }, { unique: true });

module.exports = mongoose.model("Registration", registrationSchema);