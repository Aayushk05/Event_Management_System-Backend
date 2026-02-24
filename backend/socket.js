let io;

const init = (server) => {
  const { Server } = require("socket.io");
  
  const allowedOrigins = [
    "https://eventmanagementsystema1-frontend.vercel.app",
    "http://localhost:5173",
    "http://localhost:3000"
  ];

  io = new Server(server, {
    cors: {
      origin: allowedOrigins,
      methods: ["GET", "POST", "PUT", "DELETE"],
      credentials: true
    }
  });
  
  return io;
};

const getIo = () => {
  if (!io) throw new Error("Socket.io not initialized");
  return io;
};

module.exports = { init, getIo };