const { ipcRenderer } = require('electron');
const io = require('socket.io-client');
// ВАЖНО: Убедись, что тут правильная ссылка (Render или localhost)
const socket = io('https://flash-dzmk.onrender.com');

// === STATE VARIABLES ===
let myName = "";
let audioContext, micGainNode, analyser, myVoiceStream, myScreenStream;
// Хранилища WebRTC
let peers = {}; // { socketId: RTCPeerConnection }
let connectedUsers = []; 
const rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

let isSharing = false, isMicMuted = false, isDeafened = false;
let ctxId = null, ctxText = null, ctxIsMe = false;

// Настройки
let notifyVolume = parseFloat(localStorage.getItem('notifyVolume')) || 0.8;
let notifyEnabled = localStorage.getItem('notifyEnabled') !== 'false';

// === DOM ELEMENTS ===
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
    spkSelect: document.getElementById('speaker-select'),
    micLevel: document.getElementById('mic-level'),
    audioContainer: document.getElementById('audio-container')
};

// === INITIALIZATION ===
document.getElementById('notify-toggle').checked = notifyEnabled;
document.getElementById('notify-vol').value = notifyVolume;
document.getElementById('notify-vol-grp').style.opacity = notifyEnabled ? '1' : '0.5';

// === WINDOW CONTROLS ===
document.getElementById('btn-min').onclick = () => ipcRenderer.send('minimize-app');
document.getElementById('btn-max').onclick = () => ipcRenderer.send('maximize-app');
document.getElementById('btn-close').onclick = () => ipcRenderer.send('close-app');

// === LOGIN ===
document.getElementById('btn-login').onclick = login;
els.usernameInput.addEventListener('keypress', e => { if(e.key === 'Enter') login() });

// === CHAT ===
document.getElementById('btn-send').onclick = sendMessage;
els.msgInput.addEventListener('keypress', e => { if(e.key === 'Enter') sendMessage() });

// === SETTINGS ===
document.getElementById('btn-settings').onclick = async () => {
    els.settingsModal.style.display = 'flex';
    await updateDeviceList();
    drawMicLevel(); // Запуск визуализации
};
document.getElementById('close-settings').onclick = () => els.settingsModal.style.display = 'none';

els.micSelect.onchange = () => { localStorage.setItem('micId', els.micSelect.value); initAudio(); };
els.spkSelect.onchange = () => { localStorage.setItem('spkId', els.spkSelect.value); changeSpeaker(); };

// Усиление микрофона
document.getElementById('mic-gain').oninput = (e) => { 
    if(micGainNode) micGainNode.gain.value = e.target.value; 
};

// Тест звука (динамики)
document.getElementById('btn-test-sound').onclick = () => {
    const audio = document.getElementById('audio-test');
    // Принудительно ставим выбранное устройство
    if(audio.setSinkId && els.spkSelect.value) {
        audio.setSinkId(els.spkSelect.value).then(() => audio.play());
    } else {
        audio.play();
    }
};

document.getElementById('voice-vol').oninput = (e) => { /* Глобальная громкость не используется в P2P напрямую, но можно добавить */ };

document.getElementById('notify-toggle').onchange = (e) => {
    notifyEnabled = e.target.checked;
    localStorage.setItem('notifyEnabled', notifyEnabled);
    document.getElementById('notify-vol-grp').style.opacity = notifyEnabled ? '1' : '0.5';
};
document.getElementById('notify-vol').oninput = (e) => {
    notifyVolume = e.target.value;
    localStorage.setItem('notifyVolume', notifyVolume);
};
document.getElementById('btn-clear-cache').onclick = () => { if(confirm('Удалить переписку?')) ipcRenderer.send('clear-cache'); };

// === TOOLBAR ===
document.getElementById('btn-mic').onclick = toggleMic;
document.getElementById('btn-sound').onclick = toggleSound;
document.getElementById('btn-screen').onclick = toggleScreen;

document.getElementById('close-source').onclick = () => els.sourceModal.style.display = 'none';
document.getElementById('close-video').onclick = () => {
    els.videoOverlay.style.display = 'none';
    els.remoteVideo.srcObject = null;
};

// === LOGIC ===

async function login() {
    const name = els.usernameInput.value.trim();
    if(!name) return;
    myName = name;
    
    els.loginScreen.style.display = 'none';
    els.appContainer.style.display = 'flex';
    
    await updateDeviceList();
    await initAudio(); // Получаем доступ к микрофону
    
    socket.emit('join', myName);
    socket.emit('getHistory');
}

// === AUDIO & VOICE CHAT LOGIC ===

async function initAudio() {
    const micId = els.micSelect.value || localStorage.getItem('micId');
    try {
        // Останавливаем старый стрим если был
        if(myVoiceStream) myVoiceStream.getTracks().forEach(t => t.stop());

        const stream = await navigator.mediaDevices.getUserMedia({ 
            audio: { 
                deviceId: micId ? { exact: micId } : undefined,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: false 
            } 
        });
        
        myVoiceStream = stream;

        // Настройка обработки звука
        if (audioContext) audioContext.close();
        audioContext = new AudioContext();
        const src = audioContext.createMediaStreamSource(stream);
        micGainNode = audioContext.createGain();
        analyser = audioContext.createAnalyser();
        
        micGainNode.gain.value = document.getElementById('mic-gain').value;
        analyser.fftSize = 256;

        // Цепь: Микрофон -> Gain -> Analyser (для визуализации) -> ... (В WebRTC уходит сам stream)
        src.connect(micGainNode);
        micGainNode.connect(analyser);
        // ВАЖНО: НЕ ПОДКЛЮЧАЕМ К destination, ЧТОБЫ НЕ СЛЫШАТЬ СЕБЯ

        // Если уже есть соединения, заменяем треки
        updatePeerTracks();

    } catch(e) { console.error("Ошибка аудио:", e); alert("Не удалось получить доступ к микрофону."); }
}

// Визуализация голоса в настройках
function drawMicLevel() {
    if(!analyser || els.settingsModal.style.display === 'none') return;
    const array = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(array);
    let values = 0;
    for (let i = 0; i < array.length; i++) values += array[i];
    const average = values / array.length;
    els.micLevel.style.width = Math.min(average * 2, 100) + '%';
    requestAnimationFrame(drawMicLevel);
}

// Обновление треков в существующих звонках
function updatePeerTracks() {
    if(!myVoiceStream) return;
    const audioTrack = myVoiceStream.getAudioTracks()[0];
    if(!audioTrack) return;

    Object.values(peers).forEach(pc => {
        const senders = pc.getSenders();
        const sender = senders.find(s => s.track && s.track.kind === 'audio');
        if(sender) {
            sender.replaceTrack(audioTrack);
        } else {
            pc.addTrack(audioTrack, myVoiceStream);
        }
    });
}

// === WEBRTC CORE ===

// Универсальная функция создания соединения
function createPeerConnection(targetId) {
    if (peers[targetId]) return peers[targetId];

    const pc = new RTCPeerConnection(rtcConfig);
    peers[targetId] = pc;

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', { target: targetId, candidate: event.candidate });
        }
    };

    // КОГДА ПОЛУЧАЕМ ПОТОК ОТ ДРУГА
    pc.ontrack = (event) => {
        const stream = event.streams[0];
        
        if (event.track.kind === 'audio') {
            // Это голос - создаем скрытый аудио-элемент
            let audioEl = document.getElementById(`audio-${targetId}`);
            if (!audioEl) {
                audioEl = document.createElement('audio');
                audioEl.id = `audio-${targetId}`;
                audioEl.autoplay = true;
                els.audioContainer.appendChild(audioEl);
            }
            audioEl.srcObject = stream;
            // Применяем настройки выхода (динамики)
            const spkId = els.spkSelect.value;
            if (spkId && audioEl.setSinkId) audioEl.setSinkId(spkId);
            
        } else if (event.track.kind === 'video') {
            // Это демонстрация экрана - открываем окно
            els.remoteVideo.srcObject = stream;
            els.videoOverlay.style.display = 'flex';
        }
    };

    // Добавляем свой голос в соединение
    if (myVoiceStream) {
        myVoiceStream.getTracks().forEach(track => pc.addTrack(track, myVoiceStream));
    }
    
    // Если идет демонстрация, добавляем и её
    if (isSharing && myScreenStream) {
        myScreenStream.getTracks().forEach(track => pc.addTrack(track, myScreenStream));
    }

    // Если нужна переговорка (renegotiation)
    pc.onnegotiationneeded = async () => {
        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            socket.emit('offer', { target: targetId, sdp: offer });
        } catch(e) { console.error(e); }
    };

    return pc;
}

// === SOCKET EVENTS (WEBRTC) ===

socket.on('updateUserList', users => {
    connectedUsers = users;
    els.usersList.innerHTML = '';
    
    // Инициируем соединение со всеми (Mesh Topology)
    users.forEach(u => {
        const isMe = u.name === myName;
        els.usersList.innerHTML += `<li class="user-item ${isMe?'me':''}"><div class="avatar">${u.name[0].toUpperCase()}<div class="status-dot"></div></div>${u.name} ${isMe?'(Вы)':''}</li>`;
        
        if (!isMe && !peers[u.id]) {
            // Если это новый пользователь, звоним ему
            const pc = createPeerConnection(u.id);
            // onnegotiationneeded сработает и создаст offer
        }
    });

    // Чистим старые соединения
    const activeIds = users.map(u => u.id);
    Object.keys(peers).forEach(id => {
        if (!activeIds.includes(id)) {
            peers[id].close();
            delete peers[id];
            const el = document.getElementById(`audio-${id}`);
            if(el) el.remove();
        }
    });
});

socket.on('offer', async (data) => {
    const pc = createPeerConnection(data.callerId);
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('answer', { target: data.callerId, sdp: answer });
});

socket.on('answer', async (data) => {
    const pc = peers[data.responderId];
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
});

socket.on('ice-candidate', async (data) => {
    const pc = peers[data.senderId];
    if (pc) try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch(e){}
});

// === SCREEN SHARE ===

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
    } catch(e) { grid.innerHTML = 'Ошибка драйвера'; }
}

async function startShare(sourceId) {
    els.sourceModal.style.display = 'none';
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: false, // Звук экрана обычно не стримится через WebRTC без танцев с бубном, пока только видео
            video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } }
        });
        myScreenStream = stream;
        isSharing = true;
        document.getElementById('btn-screen').classList.add('active');

        // Добавляем видео трек во все существующие соединения
        const videoTrack = stream.getVideoTracks()[0];
        Object.values(peers).forEach(pc => {
            pc.addTrack(videoTrack, stream); // Это вызовет onnegotiationneeded
        });

        videoTrack.onended = () => stopScreenShare();

    } catch(e) { console.error('Ошибка шаринга:', e); }
}

function stopScreenShare() {
    if(myScreenStream) {
        myScreenStream.getTracks().forEach(t => t.stop());
        
        // Удаляем видео треки из соединений
        Object.values(peers).forEach(pc => {
            const senders = pc.getSenders();
            const sender = senders.find(s => s.track && s.track.kind === 'video');
            if (sender) pc.removeTrack(sender);
        });
        
        myScreenStream = null;
    }
    isSharing = false;
    document.getElementById('btn-screen').classList.remove('active');
}

// === UTILS (CHAT & DEVICE) ===

async function updateDeviceList() {
    const d = await navigator.mediaDevices.enumerateDevices();
    els.micSelect.innerHTML = ''; els.spkSelect.innerHTML = '';
    d.forEach(dev => {
        const o = document.createElement('option'); o.value = dev.deviceId; o.text = dev.label || dev.kind;
        if(dev.kind === 'audioinput') els.micSelect.appendChild(o);
        if(dev.kind === 'audiooutput') els.spkSelect.appendChild(o.cloneNode(true));
    });
    const savedMic = localStorage.getItem('micId'); if(savedMic) els.micSelect.value = savedMic;
    const savedSpk = localStorage.getItem('spkId'); if(savedSpk) els.spkSelect.value = savedSpk;
}

function changeSpeaker() {
    const id = els.spkSelect.value;
    localStorage.setItem('spkId', id);
    // Меняем выход для всех аудио-элементов участников
    document.querySelectorAll('audio').forEach(el => {
        if(el.setSinkId) el.setSinkId(id);
    });
}

function toggleMic() { 
    isMicMuted = !isMicMuted;
    document.getElementById('btn-mic').classList.toggle('off', isMicMuted);
    if(myVoiceStream) {
        myVoiceStream.getAudioTracks()[0].enabled = !isMicMuted;
    }
}

function toggleSound() { 
    isDeafened = !isDeafened;
    document.getElementById('btn-sound').classList.toggle('off', isDeafened);
    // Глушим все входящие звуки
    document.querySelectorAll('#audio-container audio').forEach(el => el.muted = isDeafened);
}

// === STANDARD CHAT FUNCTIONS (NO CHANGES) ===
function sendMessage() {
    const text = els.msgInput.value.trim();
    if (!text) return;
    const editId = els.msgInput.getAttribute('data-edit-id');
    if (editId) { socket.emit('editMessage', { id: Number(editId), text }); cancelEdit(); } 
    else { socket.emit('chatMessage', { user: myName, text, type: 'text', id: Date.now() }); }
    els.msgInput.value = '';
}
function handleFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        if (file.type.startsWith('image/')) socket.emit('chatMessage', { user: myName, text: e.target.result, type: 'image', id: Date.now() });
    };
    reader.readAsDataURL(file);
}
// ... Остальные функции чата (renderMessage, showContext и т.д.) такие же, как были ...
function renderMessage(data) {
    let div = document.getElementById(`msg-${data.id}`);
    const isMe = data.user === myName;
    if(!div) { div = document.createElement('div'); div.id = `msg-${data.id}`; div.className = `message ${isMe?'me':'other'}`; els.msgContainer.appendChild(div); }
    const time = new Date(data.id).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    let content = '';
    if(data.type === 'image') content = `<img src="${data.text}" class="chat-image" onclick="document.getElementById('lb-img').src=this.src; document.getElementById('lightbox').style.display='flex'">`;
    else content = data.text.replace(/</g, "&lt;") + (data.isEdited ? ' <i style="font-size:10px;opacity:0.6">(изм)</i>' : '');
    
    div.innerHTML = `${!isMe?`<div class="msg-header">${data.user}</div>`:''}<div class="bubble" oncontextmenu="showContext(event, ${data.id}, '${data.text.replace(/'/g,"\\'")} ', ${isMe})"><span class="bubble-content">${content}</span><div class="msg-time">${time}</div></div><div class="reactions-row"></div>`;
    updateReactionsDOM(div, data.reactions, data.id);
    els.msgContainer.scrollTop = els.msgContainer.scrollHeight;
}
function updateReactionsDOM(div, reactions, msgId) {
    const rRow = div.querySelector('.reactions-row'); rRow.innerHTML = '';
    if(!reactions) return;
    const counts = {}; reactions.forEach(r => { if(!counts[r.emoji]) counts[r.emoji]=[]; counts[r.emoji].push(r.user); });
    for (let [emoji, users] of Object.entries(counts)) {
        const tag = document.createElement('div'); tag.className = `reaction-tag ${users.includes(myName)?'active':''}`;
        tag.innerHTML = `${emoji} <span style="opacity:0.7;margin-left:4px">${users.length}</span>`;
        tag.onclick = () => socket.emit('reaction', { id: msgId, emoji });
        rRow.appendChild(tag);
    }
}
function showContext(e, id, text, isMe) {
    e.preventDefault(); ctxId = id; ctxText = text; ctxIsMe = isMe;
    document.getElementById('ctx-edit').style.display = (isMe && text) ? 'flex' : 'none';
    document.getElementById('ctx-delete').style.display = isMe ? 'flex' : 'none';
    els.ctxMenu.style.left = e.clientX + 'px'; els.ctxMenu.style.top = e.clientY + 'px'; els.ctxMenu.style.display = 'flex';
}
function startEdit(id, text) { els.msgInput.value = text; els.msgInput.focus(); els.msgInput.setAttribute('data-edit-id', id); document.getElementById('cancel-edit-btn').style.display = 'block'; }
function cancelEdit() { els.msgInput.value = ''; els.msgInput.removeAttribute('data-edit-id'); document.getElementById('cancel-edit-btn').style.display = 'none'; }

socket.on('chatMessage', renderMessage);
socket.on('history', msgs => msgs.forEach(renderMessage));
socket.on('messageDeleted', id => document.getElementById(`msg-${id}`)?.remove());
socket.on('messageEdited', data => {
    const el = document.getElementById(`msg-${data.id}`);
    if(el) { el.querySelector('.bubble-content').innerHTML = data.text.replace(/</g, "&lt;") + ' <i style="font-size:10px;opacity:0.6">(изм)</i>'; }
});
socket.on('reactionUpdate', data => { const el = document.getElementById(`msg-${data.id}`); if(el) updateReactionsDOM(el, data.reactions, data.id); });
