const mongoose = require("mongoose");
const bcrypt = require("bcrypt");

const userSchema = new mongoose.Schema(
  {
    firstName:       { type: String, required: true },
    lastName:        { type: String, required: true },
    email:           { type: String, required: true, unique: true, lowercase: true },
    password:        { type: String, required: true },
    role:            { type: String, enum: ["participant", "organizer", "admin"], required: true },

    // Participant-specific
    participantType: { type: String, enum: ["iiit", "non-iiit"] },
    collegeName:     { type: String },
    contactNumber:   { type: String },

    // Preferences (participants only)
    areasOfInterest: { type: [String], default: [] },
    followedOrganizers: [
      { type: mongoose.Schema.Types.ObjectId, ref: "Organizer" }
    ],

    isActive: { type: Boolean, default: true }
  },
  { timestamps: true }
);

// Hash password before save if modified
userSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

module.exports = mongoose.model("User", userSchema);