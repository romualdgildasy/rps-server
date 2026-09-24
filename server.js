
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = {};

io.on("connection", (socket) => {
    console.log(`Connecté : ${socket.id}`);

    // Rejoindre un salon
    socket.on("joinRoom", ({ roomId, pseudo }) => {
        if (!rooms[roomId]) {
            rooms[roomId] = {
                players: [],
                choices: {},
                scores: {} // Stocke { socketId: points }
            };
        }

        const room = rooms[roomId];

        if (room.players.length >= 2) {
            socket.emit("roomFull");
            return;
        }

        room.players.push({ id: socket.id, pseudo });
        room.scores[socket.id] = 0; // Démarre à 0 point
        socket.join(roomId);

        if (room.players.length === 1) {
            socket.emit("waitingForOpponent");
        }

        // Dès que les 2 sont là, on lance le match
        if (room.players.length === 2) {
            const [p1, p2] = room.players;
            io.to(p1.id).emit("gameStart", { opponentPseudo: p2.pseudo });
            io.to(p2.id).emit("gameStart", { opponentPseudo: p1.pseudo });
        }
    });

    // Choix d'un joueur
    socket.on("makeChoice", ({ roomId, choice }) => {
        const room = rooms[roomId];
        if (!room) return;

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
                room.scores[p1.id]++; // +1 point pour P1
            } else {
                resultP1 = "lose";
                room.scores[p2.id]++; // +1 point pour P2
            }

            const p1Score = room.scores[p1.id];
            const p2Score = room.scores[p2.id];
            const isGameOver = p1Score >= 3 || p2Score >= 3;

            // Envoi des résultats de la manche
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

            // Si quelqu'un a atteint 3 points -> Fin du match
            if (isGameOver) {
                const winnerId = p1Score >= 3 ? p1.id : p2.id;
                io.to(p1.id).emit("matchEnd", { won: p1.id === winnerId });
                io.to(p2.id).emit("matchEnd", { won: p2.id === winnerId });
                delete rooms[roomId]; // On nettoie le salon
            } else {
                room.choices = {}; // Prêt pour la manche suivante
            }
        }
    });

    socket.on("disconnect", () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const index = room.players.findIndex(p => p.id === socket.id);
            if (index !== -1) {
                socket.to(roomId).emit("opponentLeft");
                delete rooms[roomId];
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Serveur prêt sur http://localhost:${PORT}`));