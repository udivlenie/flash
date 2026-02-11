const express = require('express');
const app = express();
const http = require('http').createServer(app);

// === ВАЖНОЕ ИСПРАВЛЕНИЕ: ДОБАВЛЕН CORS ===
// Это разрешает вашему приложению подключаться к серверу
const io = require('socket.io')(http, {
    cors: {
        origin: "*", // Разрешить всем (включая приложение Electron)
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 1e8 // 100 MB для отправки больших фото
});

let users = {};
let messages = [];

io.on('connection', (socket) => {
    
    // Обработка входа пользователя
    socket.on('join', (name) => {
        users[socket.id] = name;
        // Отправляем всем новый список участников
        io.emit('updateUserList', getUsersArray());
    });

    // Запрос истории сообщений
    socket.on('getHistory', () => {
        socket.emit('history', messages);
    });

    // Новое сообщение
    socket.on('chatMessage', (data) => {
        // Логика команд /dice и /coin
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
        
        // Сохраняем в память (последние 100 сообщений)
        messages.push(data);
        if (messages.length > 100) messages.shift();

        io.emit('chatMessage', data);
    });

    // Удаление сообщения
    socket.on('deleteMessage', (id) => {
        messages = messages.filter(m => m.id !== id);
        io.emit('messageDeleted', id);
    });

    // Редактирование сообщения
    socket.on('editMessage', (data) => {
        const msg = messages.find(m => m.id === data.id);
        if (msg) {
            msg.text = data.text;
            msg.isEdited = true;
            io.emit('messageEdited', { id: data.id, text: data.text });
        }
    });

    // Реакции на сообщения
    socket.on('reaction', (data) => {
        const msg = messages.find(m => m.id === data.id);
        if (msg) {
            const userName = users[socket.id];
            if (!userName) return;

            const existingIdx = msg.reactions.findIndex(r => r.user === userName);

            if (existingIdx !== -1) {
                // Если реакция та же самая — убираем её (toggle)
                if (msg.reactions[existingIdx].emoji === data.emoji) {
                    msg.reactions.splice(existingIdx, 1);
                } else {
                    // Если другая — заменяем
                    msg.reactions[existingIdx].emoji = data.emoji;
                }
            } else {
                // Если реакции не было — добавляем
                msg.reactions.push({ user: userName, emoji: data.emoji });
            }
            io.emit('reactionUpdate', { id: data.id, reactions: msg.reactions });
        }
    });

    // === WebRTC (Звонки и Демонстрация экрана) ===
    socket.on('request-peers-refresh', () => socket.emit('updateUserList', getUsersArray()));
    
    socket.on('offer', d => {
        if(users[d.target]) {
            io.to(d.target).emit('offer', {sdp:d.sdp, callerId:socket.id});
        }
    });
    
    socket.on('answer', d => {
        if(users[d.target]) {
            io.to(d.target).emit('answer', {sdp:d.sdp, responderId:socket.id});
        }
    });
    
    socket.on('ice-candidate', d => {
        if(users[d.target]) {
            io.to(d.target).emit('ice-candidate', {candidate:d.candidate, senderId:socket.id});
        }
    });

    socket.on('typing', (bool) => socket.broadcast.emit('typing', { user: users[socket.id], isTyping: bool }));

    // Отключение
    socket.on('disconnect', () => {
        delete users[socket.id];
        io.emit('updateUserList', getUsersArray());
    });
});

// Вспомогательная функция для списка юзеров
function getUsersArray() {
    return Object.keys(users).map(id => ({ id, name: users[id] }));
}

// Запуск сервера (обязательно 0.0.0.0 для Render)
const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
