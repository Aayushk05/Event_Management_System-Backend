require("dotenv").config();
const http = require("http");
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { init: initSocket } = require("./socket");

// Import Routes
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


const allowedOrigins = [
  "https://eventmanagementsystema1-frontend.vercel.app", 
  "http://localhost:5173", 
  "http://localhost:3000"  
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = `The CORS policy for this site does not allow access from the specified Origin: ${origin}`;
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  credentials: true
}));

app.use(express.json({ limit: "10mb" }));

const io = initSocket(server);

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error("No token provided"));
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    socket.user = decoded;
    next();
  } catch (err) {
    next(new Error("Invalid token"));
  }
});

io.on("connection", (socket) => {
  console.log("New client connected:", socket.id);

  socket.on("join_forum", (eventId) => {
    socket.join(`forum_${eventId}`);
     console.log(`User ${socket.user.id} joined forum_${eventId}`);
  });

  socket.on("leave_forum", (eventId) => {
    socket.leave(`forum_${eventId}`);
  });

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

  socket.on("disconnect", () => {
     console.log("Client disconnected:", socket.id);
  });
});

// 
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
      console.log("Admin created successfully");
    } else {
      console.log("Admin already exists. Skipping seed.");
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
  .catch((err) => console.error("MongoDB connection error:", err.message));


app.use("/api/auth", authRoutes);
app.use("/api/participant", participantRoutes);
app.use("/api/events", eventRoutes);
app.use("/api/events", forumRoutes); 
app.use("/api/admin", adminRoutes);
app.use("/api/users", userRoutes);
app.use("/api/organiser", organizerRoutes);

app.get("/", (req, res) => res.json({ status: "Felicity API running", version: "1.0.0" }));

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));