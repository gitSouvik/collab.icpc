const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// ─── Precompile bits/stdc++.h on startup ──────────────────────────────────────
const INCLUDE_DIR = path.join(__dirname, "include");
const PCH_SRC = path.join(INCLUDE_DIR, "bits", "stdc++.h");
const PCH_OUT = path.join(INCLUDE_DIR, "bits", "stdc++.h.gch");

if (!fs.existsSync(PCH_OUT)) {
  console.log("Precompiling bits/stdc++.h (one-time, speeds up all future runs)…");
  const pch = spawnSync("g++", ["-O0", "-std=c++17", PCH_SRC, "-o", PCH_OUT]);
  if (pch.status === 0) {
    console.log("Precompiled header ready.");
  } else {
    console.warn("PCH precompile failed (non-fatal):", pch.stderr?.toString());
  }
}

// ─── Binary cache: hash(code) → { binPath, tmpDir } ──────────────────────────
const binaryCache = new Map(); // hash → { binPath, tmpDir }
const MAX_CACHE = 20;          // keep at most 20 cached binaries

function hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

function evictOldCache() {
  if (binaryCache.size > MAX_CACHE) {
    const oldest = binaryCache.keys().next().value;
    const entry = binaryCache.get(oldest);
    binaryCache.delete(oldest);
    fs.rm(entry.tmpDir, { recursive: true, force: true }, () => {});
  }
}

// ─── In-memory room state ─────────────────────────────────────────────────────
const rooms = {};
const roomProcesses = {};
const defaultCode = `#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    cout << "Hello, world!" << endl;\n    return 0;\n}\n`;

const ROOMS_DIR = path.join(__dirname, "rooms");
if (!fs.existsSync(ROOMS_DIR)) fs.mkdirSync(ROOMS_DIR);

function getRoom(roomId) {
  if (!rooms[roomId]) {
    let savedCode = defaultCode;
    const roomFile = path.join(ROOMS_DIR, `${roomId}.cpp`);
    if (fs.existsSync(roomFile)) {
      savedCode = fs.readFileSync(roomFile, "utf8");
    }
    rooms[roomId] = { code: savedCode, input: "", users: {} };
  }
  return rooms[roomId];
}

function applyDeltasToCode(code, deltas) {
  let lines = code.split('\n');
  for (const delta of deltas) {
    const { action, start, end, lines: deltaLines } = delta;
    if (action === "insert") {
      const row = start.row;
      const col = start.column;
      if (lines[row] === undefined) throw new Error("Delta insert row out of bounds");
      const before = lines[row].substring(0, col);
      const after = lines[row].substring(col);
      const newLines = [...deltaLines];
      newLines[0] = before + newLines[0];
      newLines[newLines.length - 1] += after;
      lines.splice(row, 1, ...newLines);
    } else if (action === "remove") {
      const startRow = start.row, startCol = start.column;
      const endRow = end.row, endCol = end.column;
      if (lines[startRow] === undefined || lines[endRow] === undefined) throw new Error("Delta remove row out of bounds");
      const before = lines[startRow].substring(0, startCol);
      const after = lines[endRow].substring(endCol);
      lines.splice(startRow, endRow - startRow + 1, before + after);
    }
  }
  return lines.join('\n');
}

const COLORS = ["#5b8dfc", "#f2994a", "#27ae60", "#eb5757", "#9b51e0", "#2d9cdb"];

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

  socket.on("edit", ({ room, deltas, fullCodeFallback, cursor }) => {
    const r = getRoom(room);
    if (deltas && deltas.length > 0) {
      try {
        r.code = applyDeltasToCode(r.code, deltas);
        fs.writeFileSync(path.join(ROOMS_DIR, `${room}.cpp`), r.code);
      } catch (err) {
        console.error("Delta apply failed, falling back", err);
        if (fullCodeFallback) {
          r.code = fullCodeFallback;
          fs.writeFileSync(path.join(ROOMS_DIR, `${room}.cpp`), r.code);
        }
      }
      socket.to(room).emit("edit", { deltas, from: socket.id, cursor });
    } else if (fullCodeFallback !== undefined) {
      r.code = fullCodeFallback;
      fs.writeFileSync(path.join(ROOMS_DIR, `${room}.cpp`), r.code);
      socket.to(room).emit("edit", { fullCode: fullCodeFallback, from: socket.id, cursor });
    }
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
    io.to(room).emit("terminal", { type: "clear" });

    const hash = hashCode(code);
    const cached = binaryCache.get(hash);

    if (cached && fs.existsSync(cached.binPath)) {
      // Cache hit — skip compilation entirely
      io.to(room).emit("terminal", { type: "status", data: "Running…" });
      runBinary(cached.binPath, stdin || "", room, (event) => {
        io.to(room).emit("terminal", event);
      });
    } else {
      // Cache miss — compile then run
      io.to(room).emit("terminal", { type: "status", data: "Compiling…" });
      compileAndRun(code, hash, stdin || "", room, (event) => {
        io.to(room).emit("terminal", event);
      });
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

// ─── Compile → cache → run ────────────────────────────────────────────────────
function compileAndRun(code, hash, stdin, room, emit) {
  // Use Linux RAM disk (/dev/shm) if available for zero disk I/O, otherwise fallback to default tmp
  const baseTmp = fs.existsSync("/dev/shm") ? "/dev/shm" : os.tmpdir();
  const tmpDir = fs.mkdtempSync(path.join(baseTmp, "cide-"));
  const srcPath = path.join(tmpDir, "main.cpp");
  const binPath = path.join(tmpDir, "main.out");
  fs.writeFileSync(srcPath, code);

  // -O0: fastest compile; PCH is auto-used when stdc++.h.gch exists beside stdc++.h
  emit({ type: "status", data: "Compiling..." });
  const compile = spawn("g++", [
    "-O0", "-std=c++17",
    "-I" + INCLUDE_DIR,
    srcPath, "-o", binPath,
  ]);
  roomProcesses[room] = compile;
  let compileErr = "";
  compile.stderr.on("data", (d) => (compileErr += d.toString()));

  compile.on("close", (compileCode) => {
    if (roomProcesses[room] !== compile) {
      // Process was killed by a newer run request for the same room.
      // Clean up the temp dir and ignore the event.
      fs.rm(tmpDir, { recursive: true, force: true }, () => {});
      return;
    }

    if (compileCode !== 0) {
      emit({ type: "exit", data: { status: "Compilation error", output: compileErr } });
      fs.rm(tmpDir, { recursive: true, force: true }, () => {});
      return;
    }

    // Store in cache or use concurrent existing cache
    if (binaryCache.has(hash)) {
      fs.rm(tmpDir, { recursive: true, force: true }, () => {});
      const cached = binaryCache.get(hash);
      emit({ type: "status", data: "Running…" });
      runBinary(cached.binPath, stdin, room, emit);
      return;
    }

    binaryCache.set(hash, { binPath, tmpDir });
    evictOldCache();

    emit({ type: "status", data: "Running…" });
    runBinary(binPath, stdin, room, emit);
  });

  compile.on("error", (err) => {
    if (roomProcesses[room] !== compile) return;
    delete roomProcesses[room];
    emit({ type: "exit", data: { status: "Compilation error", output: `g++ not found: ${err.message}` } });
    fs.rm(tmpDir, { recursive: true, force: true }, () => {});
  });
}

function runBinary(binPath, stdin, room, emit) {
  const run = spawn(binPath, [], { timeout: 5000, killSignal: 'SIGKILL' });
  roomProcesses[room] = run;
  if (stdin) run.stdin.write(stdin);
  run.stdin.end();

  let outBuf = "";

  function handleData(d) {
    // Stop appending to buffer after a reasonable amount to avoid OOM, 
    // but do not kill the process early. Let the 5 second timeout handle it.
    if (outBuf.length < 50000) {
      outBuf += d.toString();
    }
  }

  run.stdout.on("data", handleData);
  run.stderr.on("data", handleData);
  run.on("close", (code, signal) => {
    if (roomProcesses[room] !== run) return;
    delete roomProcesses[room];
    
    if (signal === "SIGTERM" || signal === "SIGKILL") {
      emit({ type: "exit", data: { status: "Time limit exceeded", output: "" } });
    } else {
      let lines = outBuf.split('\n');
      if (lines.length > 150) {
        outBuf = lines.slice(0, 150).join('\n') + '\n...';
      }
      
      const statusStr = code === 0 ? "Successfully executed" : `Runtime error (exit ${code})`;
      emit({ type: "exit", data: { status: statusStr, output: outBuf } });
    }
  });
  run.on("error", (err) => {
    if (roomProcesses[room] !== run) return;
    delete roomProcesses[room];
    emit({ type: "exit", data: { status: "Failed to run", output: err.message } });
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Collab IDE running on http://localhost:${PORT}`));
