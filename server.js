const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// ─── In-memory room state ─────────────────────────────────────────────────────
const rooms = {};
const roomAbortControllers = {}; // cancel in-flight Piston requests per room
const defaultCode = `#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    cout << "Hello, world!" << endl;\n    return 0;\n}\n`;

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = { code: defaultCode, input: "", users: {} };
  }
  return rooms[roomId];
}

const COLORS = ["#5b8dfc", "#f2994a", "#27ae60", "#eb5757", "#9b51e0", "#2d9cdb"];

const PISTON_URL = "https://emkc.org/api/v2/piston/execute";

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  let currentRoom = null;

  socket.on("join", ({ room, name }) => {
    currentRoom = room || "default";
    socket.join(currentRoom);
    const isNew = !rooms[currentRoom];
    const r = getRoom(currentRoom);
    const color = COLORS[Object.keys(r.users).length % COLORS.length];
    r.users[socket.id] = { name: name || "Anonymous", color };

    socket.emit("init", { code: r.code, input: r.input, users: Object.values(r.users), isNew });
    io.to(currentRoom).emit("users", Object.values(r.users));
    socket.to(currentRoom).emit("system", `${r.users[socket.id].name} joined`);
  });

  socket.on("edit", ({ room, code, cursor }) => {
    const r = getRoom(room);
    r.code = code;
    socket.to(room).emit("edit", { code, from: socket.id, cursor });
  });

  socket.on("input", ({ room, input }) => {
    const r = getRoom(room);
    r.input = input;
    socket.to(room).emit("input", { input });
  });

  socket.on("cursor", ({ room, cursor }) => {
    socket.to(room).emit("cursor", { from: socket.id, cursor });
  });

  socket.on("run", async ({ room, code, stdin }) => {
    // Cancel any in-flight request for this room
    if (roomAbortControllers[room]) {
      roomAbortControllers[room].abort();
    }
    const controller = new AbortController();
    roomAbortControllers[room] = controller;

    io.to(room).emit("terminal", { type: "clear" });
    io.to(room).emit("terminal", { type: "status", data: "Running…" });

    try {
      const res = await fetch(PISTON_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          language: "c++",
          version: "10.2.0",
          files: [{ name: "main.cpp", content: code }],
          stdin: stdin || "",
          compile_timeout: 10000,
          run_timeout: 5000,
        }),
      });

      delete roomAbortControllers[room];

      if (!res.ok) {
        io.to(room).emit("terminal", { type: "stderr", data: `Piston API error: ${res.status}\n` });
        io.to(room).emit("terminal", { type: "exit" });
        return;
      }

      const data = await res.json();

      // Compilation errors
      if (data.compile && data.compile.stderr) {
        io.to(room).emit("terminal", { type: "stderr", data: data.compile.stderr });
      }
      if (data.compile && data.compile.code !== 0) {
        io.to(room).emit("terminal", { type: "exit", data: `\nCompilation failed\n` });
        return;
      }

      // Program output
      if (data.run.stdout) {
        io.to(room).emit("terminal", { type: "stdout", data: data.run.stdout });
      }
      if (data.run.stderr) {
        io.to(room).emit("terminal", { type: "stderr", data: data.run.stderr });
      }

      io.to(room).emit("terminal", {
        type: "exit",
        data: data.run.signal
          ? `\nTerminated (${data.run.signal})\n`
          : `\nProcess exited with code ${data.run.code}\n`,
      });

    } catch (err) {
      if (err.name === "AbortError") return;
      delete roomAbortControllers[room];
      io.to(room).emit("terminal", { type: "stderr", data: `Error: ${err.message}\n` });
      io.to(room).emit("terminal", { type: "exit" });
    }
  });

  socket.on("disconnect", () => {
    if (currentRoom && rooms[currentRoom]) {
      const r = rooms[currentRoom];
      const name = r.users[socket.id]?.name;
      delete r.users[socket.id];
      io.to(currentRoom).emit("users", Object.values(r.users));
      if (name) io.to(currentRoom).emit("system", `${name} left`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Collab IDE running on http://localhost:${PORT}`));
