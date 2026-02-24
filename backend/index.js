require("dotenv").config();
const http = require("http");
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { init: initSocket } = require("./socket");

const authRoutes = require("./routes/auth");
const participantRoutes = require("./routes/participant");
const eventRoutes = require("./routes/event");
const adminRoutes = require("./routes/admin");
const userRoutes = require("./routes/user");
const organizerRoutes = require("./routes/organiser");
const forumRoutes = require("./routes/forum");

const User = require("./models/User");

const app = express();
const server = http.createServer(app);
const io = initSocket(server);

app.use(cors({ origin: process.env.FRONTEND_URL || "*" }));
app.use(express.json({ limit: "10mb" }));

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("No token provided"));
  try {
    socket.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    next(new Error("Invalid token"));
  }
});

io.on("connection", (socket) => {
  // Forum rooms - join/leave per event
  socket.on("join_forum", (eventId) => {
    socket.join(`forum_${eventId}`);
  });
  socket.on("leave_forum", (eventId) => {
    socket.leave(`forum_${eventId}`);
  });

  // Typing indicator - broadcast to others in same forum room
  socket.on("typing", ({ eventId }) => {
    socket.to(`forum_${eventId}`).emit("user_typing", {
      userId: socket.user.id,
      role: socket.user.role
    });
  });
  socket.on("stop_typing", ({ eventId }) => {
    socket.to(`forum_${eventId}`).emit("user_stop_typing", {
      userId: socket.user.id
    });
  });

  socket.on("disconnect", () => {});
});

const seedAdmin = async () => {
  try {
    const adminExists = await User.findOne({ role: "admin" });
    if (!adminExists) {
      await User.create({
        firstName: "System",
        lastName: "Admin",
        email: process.env.ADMIN_EMAIL,
        password: process.env.ADMIN_PASSWORD,
        role: "admin",
        isActive: true
      });
      console.log("Admin created");
    } else {
      console.log("Admin already exists. Skipping.");
    }
  } catch (err) {
    console.error("Admin seed error:", err.message);
  }
};

mongoose
  .connect(process.env.MONGO_URI)
  .then(async () => {
    console.log("MongoDB connected");
    await seedAdmin();
  })
  .catch((err) => console.error("MongoDB error:", err.message));

app.use("/api/auth", authRoutes);
app.use("/api/participant", participantRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/events", forumRoutes);  // forum lives under /api/events/:id/forum
app.use("/api/admin", adminRoutes);
app.use("/api/users", userRoutes);
app.use("/api/organiser", organizerRoutes);

app.get("/", (req, res) => res.json({ status: "Felicity API running" }));

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));