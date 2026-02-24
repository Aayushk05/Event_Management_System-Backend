const mongoose = require("mongoose");

const formFieldSchema = new mongoose.Schema({
  label:      { type: String, required: true },
  fieldType:  { type: String, enum: ["text", "dropdown", "checkbox", "file"], required: true },
  isRequired: { type: Boolean, default: false },
  options:    [String]  // Used for dropdown / checkbox
});

const merchandiseVariantSchema = new mongoose.Schema({
  size:  { type: String },
  color: { type: String },
  stock: { type: Number, required: true, min: 0 },
  price: { type: Number, required: true, min: 0 }
});

const eventSchema = new mongoose.Schema(
  {
    name:        { type: String, required: true },
    description: { type: String, required: true },
    type:        { type: String, enum: ["normal", "merchandise"], required: true },
    organizerId: { type: mongoose.Schema.Types.ObjectId, ref: "Organizer", required: true },
    eligibility: { type: String, enum: ["iiit", "non-iiit", "all"], required: true },
    tags:        [{ type: String }],

    // Dates & Limits
    registrationDeadline: { type: Date, required: true },
    startDate:            { type: Date, required: true },
    endDate:              { type: Date, required: true },
    registrationLimit:    { type: Number },

    // Manual status override - Draft and Closed are always manual;
    // Published/Ongoing auto-derive from time (see effectiveStatus virtual)
    statusOverride: {
      type: String,
      enum: ["Draft", "Published", "Ongoing", "Completed", "Closed"],
      default: "Draft"
    },

    // Normal event fields
    registrationFee: { type: Number, default: 0 },
    customForm:      [formFieldSchema],
    isFormLocked:    { type: Boolean, default: false },

    // Merchandise event fields
    merchandiseVariants:       [merchandiseVariantSchema],
    purchaseLimitPerUser:      { type: Number, default: 1 },
    requiresPaymentApproval:   { type: Boolean, default: false }
  },
  {
    timestamps: true,
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true }
  }
);

// Draft and Closed always stay as-is. Otherwise derive from time.
eventSchema.virtual("effectiveStatus").get(function () {
  if (["Draft", "Closed"].includes(this.statusOverride)) return this.statusOverride;
  if (this.statusOverride === "Completed") return "Completed";
  const now = new Date();
  if (now < this.startDate) return "Published";
  if (now >= this.startDate && now <= this.endDate) return "Ongoing";
  return "Completed";
});

module.exports = mongoose.model("Event", eventSchema);