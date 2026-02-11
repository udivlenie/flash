const express = require('express');
const app = express();
const http = require('http').createServer(app);
// === ИСПРАВЛЕНИЕ: УВЕЛИЧЕН ЛИМИТ РАЗМЕРА ФАЙЛА ДО 100МБ ===
const io = require('socket.io')(http, {
    maxHttpBufferSize: 1e8 // 100 MB
});

let users = {};
let messages = [];

io.on('connection', (socket) => {
    
    socket.on('join', (name) => {
        users[socket.id] = name;
        io.emit('updateUserList', getUsersArray());
    });

    socket.on('getHistory', () => {
        socket.emit('history', messages);
    });

    socket.on('chatMessage', (data) => {
        // Команды
        if (data.type === 'text') {
            const txt = data.text.trim();
            if (txt === '/dice') {
                data.type = 'dice';
                data.value = Math.floor(Math.random() * 6) + 1;
            } else if (txt === '/coin') {
                data.type = 'coin';
                data.value = Math.random() > 0.5 ? 'heads' : 'tails';
            }
        }

        data.reactions = []; 
        if (!data.id) data.id = Date.now();
        
        messages.push(data);
        if (messages.length > 100) messages.shift();

        io.emit('chatMessage', data);
    });

    socket.on('deleteMessage', (id) => {
        messages = messages.filter(m => m.id !== id);
        io.emit('messageDeleted', id);
    });

    socket.on('editMessage', (data) => {
        const msg = messages.find(m => m.id === data.id);
        if (msg) {
            msg.text = data.text;
            msg.isEdited = true;
            io.emit('messageEdited', { id: data.id, text: data.text });
        }
    });

    socket.on('reaction', (data) => {
        const msg = messages.find(m => m.id === data.id);
        if (msg) {
            const userName = users[socket.id];
            if (!userName) return;

            const existingIdx = msg.reactions.findIndex(r => r.user === userName);

            if (existingIdx !== -1) {
                if (msg.reactions[existingIdx].emoji === data.emoji) {
                    msg.reactions.splice(existingIdx, 1);
                } else {
                    msg.reactions[existingIdx].emoji = data.emoji;
                }
            } else {
                msg.reactions.push({ user: userName, emoji: data.emoji });
            }
            io.emit('reactionUpdate', { id: data.id, reactions: msg.reactions });
        }
    });

    // WebRTC
    socket.on('request-peers-refresh', () => socket.emit('updateUserList', getUsersArray()));
    socket.on('offer', d => io.to(d.target).emit('offer', {sdp:d.sdp, callerId:socket.id}));
    socket.on('answer', d => io.to(d.target).emit('answer', {sdp:d.sdp, responderId:socket.id}));
    socket.on('ice-candidate', d => io.to(d.target).emit('ice-candidate', {candidate:d.candidate, senderId:socket.id}));
    socket.on('typing', (bool) => socket.broadcast.emit('typing', { user: users[socket.id], isTyping: bool }));

    socket.on('disconnect', () => {
        delete users[socket.id];
        io.emit('updateUserList', getUsersArray());
    });
});

function getUsersArray() {
    return Object.keys(users).map(id => ({ id, name: users[id] }));
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));