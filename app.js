const { ipcRenderer } = require('electron');
const io = require('socket.io-client');
const socket = io('https://flash-dzmk.onrender.com');

// === STATE VARIABLES (Состояние приложения) ===
let myName = "";
let audioContext, micGainNode, localStream;
let peerConnection; // Для входящего потока (когда смотрим чужой)
const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// Хранилища WebRTC
let peers = {}; // Исходящие соединения: { socketId: RTCPeerConnection }
let connectedUsers = []; // Список онлайн пользователей (КРИТИЧЕСКИ ВАЖНО ДЛЯ ЗВОНКА)

let isSharing = false, isMicMuted = false, isDeafened = false;
let ctxId = null, ctxText = null, ctxIsMe = false;

// Загрузка настроек из памяти (localStorage)
let notifyVolume = parseFloat(localStorage.getItem('notifyVolume')) || 0.8;
let notifyEnabled = localStorage.getItem('notifyEnabled') !== 'false';

// === DOM ELEMENTS (Кэширование элементов) ===
const els = {
    loginScreen: document.getElementById('login-screen'),
    appContainer: document.getElementById('app-container'),
    usernameInput: document.getElementById('username-input'),
    msgInput: document.getElementById('message-input'),
    msgContainer: document.getElementById('messages-container'),
    usersList: document.getElementById('users-list'),
    ctxMenu: document.getElementById('context-menu'),
    settingsModal: document.getElementById('settings-modal'),
    sourceModal: document.getElementById('source-modal'),
    videoOverlay: document.getElementById('video-overlay'),
    remoteVideo: document.getElementById('remote-video'),
    lightbox: document.getElementById('lightbox'),
    micSelect: document.getElementById('mic-select'),
    spkSelect: document.getElementById('speaker-select')
};

// === INITIALIZATION (При старте) ===
document.getElementById('notify-toggle').checked = notifyEnabled;
document.getElementById('notify-vol').value = notifyVolume;
document.getElementById('notify-vol-grp').style.opacity = notifyEnabled ? '1' : '0.5';

// === WINDOW CONTROLS (Кнопки окна) ===
document.getElementById('btn-min').onclick = () => ipcRenderer.send('minimize-app');
document.getElementById('btn-max').onclick = () => ipcRenderer.send('maximize-app');
document.getElementById('btn-close').onclick = () => ipcRenderer.send('close-app');

// === LOGIN & CHAT HANDLERS ===
document.getElementById('btn-login').onclick = login;
els.usernameInput.addEventListener('keypress', e => { if(e.key === 'Enter') login() });

document.getElementById('btn-send').onclick = sendMessage;
els.msgInput.addEventListener('keypress', e => { if(e.key === 'Enter') sendMessage() });

// === SETTINGS HANDLERS (Настройки) ===
document.getElementById('btn-settings').onclick = async () => {
    els.settingsModal.style.display = 'flex';
    await updateDeviceList(); // Обновляем список устройств при открытии
};
document.getElementById('close-settings').onclick = () => els.settingsModal.style.display = 'none';

// Логика изменения аудио-устройств
els.micSelect.onchange = () => { localStorage.setItem('micId', els.micSelect.value); initAudio(); };
els.spkSelect.onchange = () => { localStorage.setItem('spkId', els.spkSelect.value); changeSpeaker(); };

document.getElementById('mic-gain').oninput = (e) => { 
    if(micGainNode) micGainNode.gain.value = e.target.value; 
};
document.getElementById('voice-vol').oninput = (e) => { 
    document.getElementById('audio-call').volume = e.target.value; 
};
document.getElementById('notify-toggle').onchange = (e) => {
    notifyEnabled = e.target.checked;
    localStorage.setItem('notifyEnabled', notifyEnabled);
    document.getElementById('notify-vol-grp').style.opacity = notifyEnabled ? '1' : '0.5';
};
document.getElementById('notify-vol').oninput = (e) => {
    notifyVolume = e.target.value;
    localStorage.setItem('notifyVolume', notifyVolume);
};
document.getElementById('btn-clear-cache').onclick = () => { 
    if(confirm('Удалить всю переписку безвозвратно?')) ipcRenderer.send('clear-cache'); 
};

// === TOOLBAR CONTROLS (Нижняя панель) ===
document.getElementById('btn-mic').onclick = toggleMic;
document.getElementById('btn-sound').onclick = toggleSound;
document.getElementById('btn-screen').onclick = toggleScreen;

// === MODALS & OVERLAYS ===
document.getElementById('close-source').onclick = () => els.sourceModal.style.display = 'none';
// Закрытие просмотра чужой демонстрации
document.getElementById('close-video').onclick = () => {
    els.videoOverlay.style.display = 'none';
    els.remoteVideo.srcObject = null;
    if(peerConnection) peerConnection.close();
};

// === CONTEXT MENU (ПКМ Меню) ===
document.addEventListener('click', e => {
    if(els.ctxMenu.style.display === 'flex' && !els.ctxMenu.contains(e.target)) {
        els.ctxMenu.style.display = 'none';
    }
});
document.getElementById('ctx-copy').onclick = () => { navigator.clipboard.writeText(ctxText); els.ctxMenu.style.display='none'; };
document.getElementById('ctx-delete').onclick = () => { socket.emit('deleteMessage', ctxId); els.ctxMenu.style.display='none'; };
document.getElementById('ctx-edit').onclick = () => { startEdit(ctxId, ctxText); els.ctxMenu.style.display='none'; };

document.querySelectorAll('.ctx-emoji').forEach(btn => {
    btn.onclick = () => { 
        socket.emit('reaction', { id: ctxId, emoji: btn.dataset.emoji }); 
        els.ctxMenu.style.display='none'; 
    };
});

// === FILES & LIGHTBOX ===
document.getElementById('btn-attach').onclick = () => document.getElementById('file-input').click();
document.getElementById('file-input').onchange = sendFile;
els.lightbox.onclick = () => els.lightbox.style.display = 'none';
document.getElementById('cancel-edit-btn').onclick = cancelEdit;

// === DRAG AND DROP ===
const dropZone = document.getElementById('drop-zone');
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, e => { e.preventDefault(); e.stopPropagation(); }, false);
    document.body.addEventListener(eventName, e => { e.preventDefault(); e.stopPropagation(); }, false);
});
dropZone.addEventListener('dragover', () => dropZone.classList.add('drag-over'));
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
});

// Paste (Ctrl+V)
els.msgInput.addEventListener('paste', (e) => {
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (let item of items) { if (item.type.indexOf('image') === 0) handleFile(item.getAsFile()); }
});

// =============================================================================
//                              WEBRTC LOGIC (Экран и Звонки)
// =============================================================================

// 1. Входящий звонок (Offer) - Кто-то начал шарить экран
socket.on('offer', async (data) => {
    // Если мы уже что-то смотрим - сброс
    if (peerConnection) peerConnection.close();
    
    peerConnection = new RTCPeerConnection(rtcConfig);

    // Когда придет поток видео - показываем его
    peerConnection.ontrack = (event) => {
        els.remoteVideo.srcObject = event.streams[0];
        els.videoOverlay.style.display = 'flex'; // Открываем окно просмотра
    };

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', { target: data.callerId, candidate: event.candidate });
        }
    };

    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    
    socket.emit('answer', { target: data.callerId, sdp: answer });
});

// 2. Ответ зрителя (Answer)
socket.on('answer', async (data) => {
    const pc = peers[data.responderId];
    if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    }
});

// 3. ICE Candidate (Путь сети)
socket.on('ice-candidate', async (data) => {
    // Если мы стример - ищем в peers, если зритель - peerConnection
    const pc = peers[data.senderId] || peerConnection;
    if (pc) {
        try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch(e) {}
    }
});

// Универсальная функция создания соединения
function createPeerConnection(targetId) {
    if (peers[targetId]) peers[targetId].close();

    const pc = new RTCPeerConnection(rtcConfig);
    peers[targetId] = pc;

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', { target: targetId, candidate: event.candidate });
        }
    };

    // Добавляем локальный поток (экран) в соединение
    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    return pc;
}

// === SCREEN SHARING FUNCTIONS ===

async function toggleScreen() {
    if(isSharing) { stopScreenShare(); return; }
    
    els.sourceModal.style.display = 'flex';
    const grid = document.getElementById('sources-grid');
    grid.innerHTML = 'Загрузка...';
    
    try {
        const sources = await ipcRenderer.invoke('get-sources');
        grid.innerHTML = '';
        sources.forEach(src => {
            const d = document.createElement('div'); d.className = 'grid-item';
            d.onclick = () => startShare(src.id);
            d.innerHTML = `<img src="${src.thumbnail}" class="grid-thumb"><div style="font-size:10px;">${src.name}</div>`;
            grid.appendChild(d);
        });
    } catch(e) { grid.innerHTML = 'Ошибка драйвера: ' + e; }
}

async function startShare(sourceId) {
    els.sourceModal.style.display = 'none';
    try {
        // 1. Захват экрана
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } }
        });
        
        localStream = stream;
        isSharing = true;
        document.getElementById('btn-screen').classList.add('active');

        // 2. Звоним ВСЕМ пользователям из списка connectedUsers
        connectedUsers.forEach(async (user) => {
            if (user.id === socket.id) return; // Не звоним себе

            const pc = createPeerConnection(user.id);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            
            socket.emit('offer', { target: user.id, sdp: offer });
        });

        // Если нажали "Закрыть доступ" в системной панели
        stream.getVideoTracks()[0].onended = () => stopScreenShare();

    } catch(e) { console.error('Sharing failed:', e); }
}

function stopScreenShare() {
    if(localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }
    isSharing = false;
    document.getElementById('btn-screen').classList.remove('active');
    
    // Закрываем все исходящие соединения
    Object.values(peers).forEach(pc => pc.close());
    peers = {};
}

// =============================================================================
//                              MAIN APP LOGIC
// =============================================================================

async function login() {
    const name = els.usernameInput.value.trim();
    if(!name) return;
    myName = name;
    
    els.loginScreen.style.display = 'none';
    els.appContainer.style.display = 'flex';
    
    await updateDeviceList();
    await initAudio(); // Включаем микрофон
    
    socket.emit('join', myName);
    socket.emit('getHistory');
}

function sendMessage() {
    const text = els.msgInput.value.trim();
    if (!text) return;

    const editId = els.msgInput.getAttribute('data-edit-id');
    
    if (editId) {
        socket.emit('editMessage', { id: Number(editId), text });
        cancelEdit();
    } else {
        socket.emit('chatMessage', { user: myName, text, type: 'text', id: Date.now() });
    }
    els.msgInput.value = '';
}

function startEdit(id, text) {
    els.msgInput.value = text;
    els.msgInput.focus();
    els.msgInput.setAttribute('data-edit-id', id);
    document.getElementById('cancel-edit-btn').style.display = 'block';
    els.msgInput.parentElement.style.borderColor = '#FFD700';
}

function cancelEdit() {
    els.msgInput.value = '';
    els.msgInput.removeAttribute('data-edit-id');
    document.getElementById('cancel-edit-btn').style.display = 'none';
    els.msgInput.parentElement.style.borderColor = 'rgba(255, 255, 255, 0.08)';
}

function handleFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const type = file.type.startsWith('image/') ? 'image' : 'file'; 
        // Для MVP отправляем только картинки в Base64
        if (type === 'image') {
            socket.emit('chatMessage', { user: myName, text: e.target.result, type: 'image', id: Date.now() });
        }
    };
    reader.readAsDataURL(file);
}
function sendFile() { const file = document.getElementById('file-input').files[0]; if (file) handleFile(file); }

function renderMessage(data) {
    let div = document.getElementById(`msg-${data.id}`);
    const isMe = data.user === myName;

    if (!div) {
        div = document.createElement('div');
        div.id = `msg-${data.id}`;
        div.className = `message ${isMe ? 'me' : 'other'}`;
        els.msgContainer.appendChild(div);
    }

    const time = new Date(data.id).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    let content = '';

    if (data.type === 'image') {
        content = `<img src="${data.text}" class="chat-image" onclick="document.getElementById('lb-img').src=this.src; document.getElementById('lightbox').style.display='flex'">`;
    } else if (data.type === 'dice') {
        content = `<div style="font-size:24px;">🎲 ${data.value}</div>`;
    } else if (data.type === 'coin') {
        content = `<div style="font-size:24px;">🪙 ${data.value === 'heads' ? 'Орёл' : 'Решка'}</div>`;
    } else {
        const safeText = data.text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
        content = safeText;
        if(data.isEdited) content += ' <i style="font-size:10px; opacity:0.6; margin-left:5px;">(изм)</i>';
    }

    const ticks = isMe ? `<i class="material-icons" style="font-size:12px; color:black;">done_all</i>` : '';
    // Экранирование для JS
    const jsText = (data.type === 'text' ? data.text.replace(/'/g, "\\'") : "");

    div.innerHTML = `
        ${!isMe ? `<div class="msg-header">${data.user}</div>` : ''}
        <div class="bubble" oncontextmenu="showContext(event, ${data.id}, '${jsText}', ${isMe})">
            <span class="bubble-content">${content}</span>
            <div class="msg-time">${time} ${ticks}</div>
        </div>
        <div class="reactions-row"></div>
    `;

    updateReactionsDOM(div, data.reactions, data.id);

    if (!isMe && !document.hasFocus() && notifyEnabled) {
        const audio = document.getElementById('audio-sms');
        audio.volume = notifyVolume;
        audio.play().catch(()=>{});
    }
    els.msgContainer.scrollTop = els.msgContainer.scrollHeight;
}

function updateReactionsDOM(divElement, reactions, msgId) {
    const rRow = divElement.querySelector('.reactions-row');
    if (!rRow) return;
    
    rRow.innerHTML = '';
    if (!reactions || reactions.length === 0) return;

    const counts = {};
    reactions.forEach(r => {
        if(!counts[r.emoji]) counts[r.emoji] = [];
        counts[r.emoji].push(r.user);
    });

    for (let [emoji, users] of Object.entries(counts)) {
        const tag = document.createElement('div');
        const active = users.includes(myName) ? 'active' : '';
        tag.className = `reaction-tag ${active}`;
        tag.innerHTML = `${emoji} <span style="font-size:10px; opacity:0.7; margin-left:4px;">${users.length}</span>`;
        tag.onclick = () => socket.emit('reaction', { id: msgId, emoji });
        rRow.appendChild(tag);
    }
}

function showContext(e, id, text, isMe) {
    e.preventDefault();
    ctxId = id; ctxText = text; ctxIsMe = isMe;
    
    document.getElementById('ctx-edit').style.display = (isMe && text) ? 'flex' : 'none';
    document.getElementById('ctx-delete').style.display = isMe ? 'flex' : 'none';

    let x = e.clientX, y = e.clientY;
    if(x + 180 > window.innerWidth) x -= 180;
    if(y + 200 > window.innerHeight) y -= 200;

    els.ctxMenu.style.left = x + 'px';
    els.ctxMenu.style.top = y + 'px';
    els.ctxMenu.style.display = 'flex';
}

// === SOCKET EVENTS ===

socket.on('chatMessage', renderMessage);
socket.on('history', msgs => msgs.forEach(renderMessage));
socket.on('messageDeleted', id => { const e=document.getElementById(`msg-${id}`); if(e) e.remove(); ipcRenderer.send('delete-message-file', id); });

socket.on('messageEdited', data => {
    ipcRenderer.send('update-message', data);
    const el = document.getElementById(`msg-${data.id}`);
    if (el) {
        const contentSpan = el.querySelector('.bubble-content');
        if (contentSpan) {
            const safeText = data.text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
            contentSpan.innerHTML = safeText + ' <i style="font-size:10px; opacity:0.6; margin-left:5px;">(изм)</i>';
        }
        const bubble = el.querySelector('.bubble');
        if (bubble) {
            const isMe = el.classList.contains('me');
            const jsText = data.text.replace(/'/g, "\\'");
            bubble.oncontextmenu = (event) => showContext(event, data.id, jsText, isMe);
        }
    }
});

socket.on('reactionUpdate', data => { 
    const el = document.getElementById(`msg-${data.id}`); 
    if(el) updateReactionsDOM(el, data.reactions, data.id); 
});

socket.on('updateUserList', users => {
    connectedUsers = users; // <--- ВАЖНО: СОХРАНЯЕМ СПИСОК ДЛЯ ЗВОНКОВ
    els.usersList.innerHTML = '';
    users.forEach(u => {
        const isMe = u.name === myName;
        els.usersList.innerHTML += `<li class="user-item ${isMe?'me':''}"><div class="avatar">${u.name[0].toUpperCase()}<div class="status-dot"></div></div>${u.name} ${isMe?'(Вы)':''}</li>`;
    });
});

socket.on('history-cleared', () => els.msgContainer.innerHTML = '');

// === AUDIO ===

async function initAudio() {
    if (audioContext) await audioContext.close();
    const micId = els.micSelect.value || localStorage.getItem('micId');
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: micId ? { exact: micId } : undefined } });
        audioContext = new AudioContext();
        const src = audioContext.createMediaStreamSource(stream);
        micGainNode = audioContext.createGain();
        micGainNode.gain.value = document.getElementById('mic-gain').value;
        micGainNode.connect(audioContext.destination);
    } catch(e) {}
}

async function updateDeviceList() {
    const d = await navigator.mediaDevices.enumerateDevices();
    els.micSelect.innerHTML = ''; els.spkSelect.innerHTML = '';
    d.forEach(dev => {
        const o = document.createElement('option'); o.value = dev.deviceId; o.text = dev.label || dev.kind;
        if(dev.kind === 'audioinput') els.micSelect.appendChild(o);
        if(dev.kind === 'audiooutput') els.spkSelect.appendChild(o.cloneNode(true));
    });
    // Restore
    const savedMic = localStorage.getItem('micId'); if(savedMic) els.micSelect.value = savedMic;
    const savedSpk = localStorage.getItem('spkId'); if(savedSpk) els.spkSelect.value = savedSpk;
}

function changeSpeaker() {
    const id = els.spkSelect.value;
    localStorage.setItem('spkId', id);
    if(document.getElementById('audio-call').setSinkId) {
        document.getElementById('audio-call').setSinkId(id);
        document.getElementById('audio-sms').setSinkId(id);
    }
}

function toggleMic() { isMicMuted=!isMicMuted; document.getElementById('btn-mic').classList.toggle('off', isMicMuted); }
function toggleSound() { isDeafened=!isDeafened; document.getElementById('btn-sound').classList.toggle('off', isDeafened); document.getElementById('audio-call').volume = isDeafened?0:1; }