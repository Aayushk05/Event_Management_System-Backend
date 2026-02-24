const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

router.post("/register", async (req, res) => {
  try {
    const { firstName, lastName, email, password, participantType, collegeName, contactNumber } = req.body;

    if (!firstName || !lastName || !email || !password || !participantType) {
      return res.status(400).json({ message: "All required fields must be provided." });
    }
    if (!["iiit", "non-iiit"].includes(participantType)) {
      return res.status(400).json({ message: "Invalid participant type." });
    }

    // IIIT email domain validation
    if (participantType === "iiit") {
      const validDomains = ["@research.iiit.ac.in", "@students.iiit.ac.in", "@iiit.ac.in"];
      const isValid = validDomains.some((d) => email.toLowerCase().endsWith(d));
      if (!isValid) {
        return res.status(400).json({
          message: "IIIT participants must use @iiit.ac.in, @students.iiit.ac.in, or @research.iiit.ac.in."
        });
      }
    }

    const existing = await User.findOne({ email: email.toLowerCase() });
    if (existing) {
      return res.status(400).json({ message: "This email is already registered." });
    }

    const user = await User.create({
      firstName,
      lastName,
      email,
      password,
      role: "participant",
      participantType,
      collegeName:    collegeName || "",
      contactNumber:  contactNumber || ""
    });

    res.status(201).json({
      message: "Registration successful.",
      userId: user._id
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required." });
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(400).json({ message: "Invalid credentials." });
    }

    if (!user.isActive) {
      return res.status(403).json({
        message: "This account has been disabled. Please contact the Admin."
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid credentials." });
    }

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      message: "Login successful.",
      token,
      user: {
        id:              user._id,
        role:            user.role,
        firstName:       user.firstName,
        participantType: user.participantType
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// JWT is stateless - logout is handled by the client deleting the token.
// This endpoint exists so the frontend has a consistent API call to make.
router.post("/logout", authMiddleware, (req, res) => {
  res.json({ message: "Logged out." });
});

module.exports = router;