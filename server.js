const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// In-memory room state: { code, cursors: { socketId: {name, pos} } }
const rooms = {};
const roomProcesses = {}; // track active child processes per room
const defaultCode = `#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    cout << "Hello, world!" << endl;\n    return 0;\n}\n`;

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      code: defaultCode,
      input: "",
      users: {}, // socketId -> { name, color }
    };
  }
  return rooms[roomId];
}

const COLORS = ["#5b8dfc", "#f2994a", "#27ae60", "#eb5757", "#9b51e0", "#2d9cdb"];

io.on("connection", (socket) => {
  let currentRoom = null;

  socket.on("join", ({ room, name }) => {
    currentRoom = room || "default";
    socket.join(currentRoom);
    const isNew = !rooms[currentRoom];
    const r = getRoom(currentRoom);
    const color = COLORS[Object.keys(r.users).length % COLORS.length];
    r.users[socket.id] = { name: name || "Anonymous", color };

    // send current state to the joining client
    socket.emit("init", { code: r.code, input: r.input, users: Object.values(r.users), isNew });
    // tell everyone else who's here now
    io.to(currentRoom).emit("users", Object.values(r.users));
    socket.to(currentRoom).emit("system", `${r.users[socket.id].name} joined`);
  });

  // Broadcast full-document edits (simple last-write-wins sync — fine for 3 collaborators)
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

  socket.on("run", ({ room, code, stdin }) => {
    // Kill any existing process for this room
    if (roomProcesses[room]) {
      try { roomProcesses[room].kill("SIGKILL"); } catch (_) {}
      delete roomProcesses[room];
    }
    // Clear terminal for everyone in the room
    io.to(room).emit("terminal", { type: "clear" });
    io.to(room).emit("terminal", { type: "status", data: "Compiling…" });
    compileAndRun(code, stdin || "", room, (event) => {
      io.to(room).emit("terminal", event);
    });
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

function compileAndRun(code, stdin, room, emit) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cide-"));
  const srcPath = path.join(tmpDir, "main.cpp");
  const binPath = path.join(tmpDir, "main.out");
  fs.writeFileSync(srcPath, code);

  const compile = spawn("g++", ["-O0", "-std=c++17", "-I" + path.join(__dirname, "include"), srcPath, "-o", binPath]);
  roomProcesses[room] = compile;
  let compileErr = "";
  compile.stderr.on("data", (d) => (compileErr += d.toString()));

  compile.on("close", (compileCode) => {
    if (compileCode !== 0) {
      emit({ type: "stderr", data: compileErr });
      emit({ type: "exit", data: `Compilation failed (exit ${compileCode})\n` });
      cleanup();
      return;
    }
    emit({ type: "status", data: "Running\u2026" });
    const run = spawn(binPath, [], { timeout: 8000 });
    roomProcesses[room] = run;
    if (stdin) run.stdin.write(stdin);
    run.stdin.end();

    run.stdout.on("data", (d) => emit({ type: "stdout", data: d.toString() }));
    run.stderr.on("data", (d) => emit({ type: "stderr", data: d.toString() }));
    run.on("close", (code, signal) => {
      delete roomProcesses[room];
      emit({
        type: "exit",
        data: signal
          ? `\nTerminated (${signal}) — likely timeout or infinite loop\n`
          : `\nProcess exited with code ${code}\n`,
      });
      cleanup();
    });
    run.on("error", (err) => {
      delete roomProcesses[room];
      emit({ type: "stderr", data: `Failed to run: ${err.message}\n` });
      cleanup();
    });
  });

  compile.on("error", (err) => {
    delete roomProcesses[room];
    emit({
      type: "stderr",
      data: `g++ not found on this server. Install build-essential (Linux) or Xcode CLT (Mac): ${err.message}\n`,
    });
    cleanup();
  });

  function cleanup() {
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Collab IDE running on http://localhost:${PORT}`));
