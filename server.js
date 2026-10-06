import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
app.use(cors());

// 1. Route de vérification pour Render (Health Check)
app.get("/", (req, res) => {
    res.send("🚀 Serveur Pierre Papier Ciseaux en ligne !");
});

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = {};
const AWAY_DELAY = 5 * 60 * 1000; // 5 minutes pour revenir pendant un match

function startMatch(room) {
    room.started = true;
    const [p1, p2] = room.players;
    io.to(p1.id).emit("gameStart", { opponentPseudo: p2.pseudo });
    io.to(p2.id).emit("gameStart", { opponentPseudo: p1.pseudo });
}

io.on("connection", (socket) => {
    console.log(`Connecté : ${socket.id}`);

    // Rejoindre un salon
    socket.on("joinRoom", ({ roomId, pseudo, playerId }) => {
        console.log(`JOIN ${pseudo} -> salle ${roomId} (${socket.id})`);

        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [],
                choices: {},
                scores: {},
                started: false
            };
        }

        const room = rooms[roomId];

        // Sécurité : même socket qui rejoint 2 fois
        if (room.players.some(p => p.id === socket.id)) return;

        // Reconnexion du même joueur (nouveau socket.id après une mise en veille)
        const existing = playerId && room.players.find(p => p.playerId === playerId);
        if (existing) {
            room.scores[socket.id] = room.scores[existing.id] ?? 0;
            delete room.scores[existing.id];
            if (room.choices[existing.id]) {
                room.choices[socket.id] = room.choices[existing.id];
                delete room.choices[existing.id];
            }
            existing.id = socket.id;
            existing.pseudo = pseudo;
            socket.join(roomId);

            if (room.players.length === 2) {
                if (!room.started) {
                    startMatch(room);
                } else {
                    // Match déjà lancé : on renvoie l'état au joueur revenu
                    const other = room.players.find(p => p.id !== socket.id);
                    socket.emit("resync", {
                        opponentPseudo: other.pseudo,
                        yourScore: room.scores[socket.id],
                        oppScore: room.scores[other.id]
                    });
                    socket.to(roomId).emit("opponentBack");
                }
            }
            return;
        }

        if (room.players.length >= 2) {
            socket.emit("roomFull");
            return;
        }

        room.players.push({ id: socket.id, pseudo, playerId });
        room.scores[socket.id] = 0;
        socket.join(roomId);

        if (room.players.length === 1) {
            socket.emit("waitingForOpponent");
        }

        // Dès que les 2 sont là, on lance le match
        if (room.players.length === 2) {
            startMatch(room);
        }
    });

    // Choix d'un joueur
    socket.on("makeChoice", ({ roomId, choice }) => {
        const room = rooms[roomId];
        if (!room || room.players.length < 2) return;

        room.choices[socket.id] = choice;
        socket.to(roomId).emit("opponentMadeChoice");

        // Quand les deux ont choisi
        if (Object.keys(room.choices).length === 2) {
            const [p1, p2] = room.players;
            const c1 = room.choices[p1.id];
            const c2 = room.choices[p2.id];

            let resultP1 = "draw";
            if (c1 === c2) {
                resultP1 = "draw";
            } else if (
                (c1 === "rock" && c2 === "scissors") ||
                (c1 === "scissors" && c2 === "paper") ||
                (c1 === "paper" && c2 === "rock")
            ) {
                resultP1 = "win";
                room.scores[p1.id]++;
            } else {
                resultP1 = "lose";
                room.scores[p2.id]++;
            }

            const p1Score = room.scores[p1.id];
            const p2Score = room.scores[p2.id];
            const isGameOver = p1Score >= 3 || p2Score >= 3;

            io.to(p1.id).emit("roundResult", {
                yourChoice: c1,
                oppChoice: c2,
                result: resultP1,
                yourScore: p1Score,
                oppScore: p2Score,
                isGameOver
            });

            io.to(p2.id).emit("roundResult", {
                yourChoice: c2,
                oppChoice: c1,
                result: resultP1 === "win" ? "lose" : (resultP1 === "lose" ? "win" : "draw"),
                yourScore: p2Score,
                oppScore: p1Score,
                isGameOver
            });

            if (isGameOver) {
                const winnerId = p1Score >= 3 ? p1.id : p2.id;
                io.to(p1.id).emit("matchEnd", { won: p1.id === winnerId });
                io.to(p2.id).emit("matchEnd", { won: p2.id === winnerId });
                delete rooms[roomId];
            } else {
                room.choices = {};
            }
        }
    });

    socket.on("disconnect", (reason) => {
        console.log(`DISCONNECT ${socket.id} : ${reason}`);

        for (const roomId in rooms) {
            const room = rooms[roomId];
            const index = room.players.findIndex(p => p.id === socket.id);
            if (index === -1) continue; // ancien socket déjà remplacé : on ignore

            if (!room.started) {
                // Salle d'attente : on retire juste ce joueur, la salle survit
                room.players.splice(index, 1);
                delete room.scores[socket.id];
                delete room.choices[socket.id];
                if (room.players.length === 0) delete rooms[roomId];
            } else {
                // Match en cours : on prévient l'autre joueur, puis on attend le retour
                const lostId = socket.id;
                socket.to(roomId).emit("opponentAway");
                setTimeout(() => {
                    const r = rooms[roomId];
                    if (!r) return;
                    const stillGone = r.players.some(p => p.id === lostId);
                    if (stillGone) {
                        io.to(roomId).emit("opponentLeft");
                        delete rooms[roomId];
                    }
                }, AWAY_DELAY);
            }
            break;
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur prêt sur http://localhost:${PORT}`));