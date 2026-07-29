const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

// قاعدة بيانات اللاعبين للمزاد
const playersPool = [
    { id: 1, name: "ليونيل ميسي", overall: 93, position: "RW", photo: "https://via.placeholder.com/120?text=Messi" },
    { id: 2, name: "كريستيانو رونالدو", overall: 91, position: "ST", photo: "https://via.placeholder.com/120?text=Ronaldo" },
    { id: 3, name: "كيليان مبابي", overall: 92, position: "ST", photo: "https://via.placeholder.com/120?text=Mbappe" },
    { id: 4, name: "كيفين دي بروين", overall: 91, position: "CM", photo: "https://via.placeholder.com/120?text=De+Bruyne" },
    { id: 5, name: "فيرجيل فان دايك", overall: 89, position: "CB", photo: "https://via.placeholder.com/120?text=Van+Dijk" }
];

let rooms = {};

io.on('connection', (socket) => {
    console.log('مستخدم جديد متصل:', socket.id);

    // 1. إنشاء غرفة
    socket.on('createRoom', ({ roomId, playerName }) => {
        const cleanRoomId = String(roomId).trim().toUpperCase();
        
        socket.join(cleanRoomId);
        rooms[cleanRoomId] = {
            id: cleanRoomId,
            players: [{ id: socket.id, name: playerName || 'اللاعب 1', budget: 100, squad: [] }],
            currentRound: 0,
            currentBid: 0,
            highestBidder: null,
            currentPlayer: null,
            status: 'waiting',
            timer: null,
            timeLeft: 15
        };

        console.log(`تم إنشاء الغرفة: ${cleanRoomId} بواسطة ${playerName}`);
        socket.emit('roomCreated', { roomId: cleanRoomId, player: rooms[cleanRoomId].players[0] });
    });

    // 2. الانضمام لغرفة
    socket.on('joinRoom', ({ roomId, playerName }) => {
        const cleanRoomId = String(roomId).trim().toUpperCase();
        const room = rooms[cleanRoomId];

        if (!room) {
            return socket.emit('errorMsg', 'الغرفة غير موجودة! تأكد من الكود');
        }
        if (room.players.length >= 2) {
            return socket.emit('errorMsg', 'الغرفة ممتلئة بالكامل!');
        }

        socket.join(cleanRoomId);
        const newPlayer = { id: socket.id, name: playerName || 'اللاعب 2', budget: 100, squad: [] };
        room.players.push(newPlayer);
        room.status = 'playing';

        console.log(`انضم ${playerName} للغرفة: ${cleanRoomId}`);

        io.to(cleanRoomId).emit('gameStart', {
            players: room.players
        });

        io.to(cleanRoomId).emit('updateAuctionLog', 'اكتملت الغرفة! ستبدأ اللعبة خلال 3 ثوانٍ... ⏳');

        setTimeout(() => {
            startNextRound(cleanRoomId);
        }, 3000);
    });

    // 3. المزايدة
    socket.on('placeBid', ({ roomId, amount }) => {
        const cleanRoomId = String(roomId).trim().toUpperCase();
        const room = rooms[cleanRoomId];

        if (!room || room.status !== 'playing') return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        if (amount <= room.currentBid) {
            return socket.emit('errorMsg', 'يجب أن تكون زايدت بمبلغ أعلى من المزاد الحالي!');
        }

        if (amount > player.budget) {
            return socket.emit('errorMsg', 'ميزانيتك لا تكفي!');
        }

        room.currentBid = amount;
        room.highestBidder = player;
        room.timeLeft = 15; // إعادة ضبط العداد مع كل مزايدة جديدة

        io.to(cleanRoomId).emit('bidUpdated', {
            currentBid: room.currentBid,
            highestBidderName: player.name,
            highestBidderId: player.id
        });

        io.to(cleanRoomId).emit('updateAuctionLog', `قدم ${player.name} عرضاً بقيمة $${amount}M`);
    });

    // الفصل
    socket.on('disconnect', () => {
        console.log('مستخدم قطع الاتصال:', socket.id);
    });
});

// دالة بدء الجولة
function startNextRound(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    if (room.currentRound >= playersPool.length) {
        room.status = 'ended';
        clearInterval(room.timer);
        return io.to(roomId).emit('gameOver', { players: room.players });
    }

    room.currentPlayer = playersPool[room.currentRound];
    room.currentBid = 0;
    room.highestBidder = null;
    room.timeLeft = 15;
    room.currentRound++;

    io.to(roomId).emit('newRound', {
        playerToAuction: room.currentPlayer,
        roundNumber: room.currentRound,
        totalRounds: playersPool.length
    });

    io.to(roomId).emit('updateAuctionLog', `بدأ المزاد على اللاعب: ${room.currentPlayer.name}`);

    // العداد التنازلي للمزاد
    if (room.timer) clearInterval(room.timer);
    
    room.timer = setInterval(() => {
        room.timeLeft--;
        io.to(roomId).emit('timerUpdate', room.timeLeft);

        if (room.timeLeft <= 0) {
            clearInterval(room.timer);
            endRound(roomId);
        }
    }, 1000);
}

// دالة إنهاء الجولة وتوزيع اللاعب
function endRound(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    if (room.highestBidder) {
        const winner = room.players.find(p => p.id === room.highestBidder.id);
        if (winner) {
            winner.budget -= room.currentBid;
            winner.squad.push(room.currentPlayer);

            io.to(roomId).emit('playerSold', {
                winnerId: winner.id,
                winnerName: winner.name,
                player: room.currentPlayer,
                price: room.currentBid,
                playersState: room.players
            });

            io.to(roomId).emit('updateAuctionLog', `فاز ${winner.name} باللاعب ${room.currentPlayer.name} مقابل $${room.currentBid}M! 🎉`);
        }
    } else {
        io.to(roomId).emit('updateAuctionLog', `لم يزايد أحد على ${room.currentPlayer.name}، انتهى المزاد!`);
    }

    setTimeout(() => {
        startNextRound(roomId);
    }, 3000);
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`السيرفر يعمل بنجاح على المنفذ ${PORT}`);
});