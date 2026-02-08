// QBIT Firmware Flasher
// Flashing handled by esp-web-tools <esp-web-install-button> via manifest.json
// Serial monitor uses Web Serial API directly

// UI elements
const ui = {
    themeBtn: document.getElementById('themeBtn'),
    versionEl: document.getElementById('version'),
    timestampEl: document.getElementById('timestamp'),
    firmwareSizeEl: document.getElementById('firmware-size'),
    firmwareMd5El: document.getElementById('firmware-md5'),
    refreshBtn: document.getElementById('refresh-btn'),
    monitorConnectBtn: document.getElementById('monitor-connect-btn'),
    monitorDisconnectBtn: document.getElementById('monitor-disconnect-btn'),
    monitorClearBtn: document.getElementById('monitor-clear-btn'),
    monitorNotConnected: document.getElementById('monitor-not-connected'),
    monitorConnected: document.getElementById('monitor-connected'),
    monitorOutput: document.getElementById('monitor-output'),
    monitorSendInput: document.getElementById('monitor-send-input'),
    monitorSendBtn: document.getElementById('monitor-send-btn'),
};

let releaseData = null;
let monitorPort = null;
let monitorReader = null;
let monitorReadAborted = false;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    const isDark = !localStorage.getItem('qbit-light-mode');
    if (!isDark) document.body.classList.add('light-mode');
    ui.themeBtn.addEventListener('click', toggleTheme);

    loadLatestVersion();
    ui.refreshBtn.addEventListener('click', loadLatestVersion);

    ui.monitorConnectBtn.addEventListener('click', monitorConnect);
    ui.monitorDisconnectBtn.addEventListener('click', monitorDisconnect);
    ui.monitorClearBtn.addEventListener('click', () => { ui.monitorOutput.textContent = ''; });
    ui.monitorSendBtn.addEventListener('click', monitorSend);
    ui.monitorSendInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') monitorSend(); });
});

function toggleTheme() {
    document.body.classList.toggle('light-mode');
    localStorage.setItem('qbit-light-mode', document.body.classList.contains('light-mode') ? 'true' : '');
}

// Firmware info
async function loadLatestVersion() {
    try {
        ui.refreshBtn.disabled = true;
        ui.versionEl.textContent = 'Loading...';
        ui.timestampEl.textContent = 'Loading...';
        ui.firmwareSizeEl.textContent = 'Loading...';
        ui.firmwareMd5El.textContent = 'Loading...';

        const response = await fetch('latest.json');
        if (!response.ok) throw new Error(`Failed to fetch latest.json: ${response.status}`);
        const latestJson = await response.json();

        releaseData = latestJson;
        ui.versionEl.textContent = latestJson.version || 'Unknown';
        ui.timestampEl.textContent = formatDate(latestJson.timestamp) || 'Unknown';
        if (latestJson.files && latestJson.files['firmware.bin']) {
            const fw = latestJson.files['firmware.bin'];
            ui.firmwareSizeEl.textContent = formatBytes(fw.size);
            ui.firmwareMd5El.textContent = fw.md5.substring(0, 16) + '...';
        }
    } catch (error) {
        console.error('Load version failed:', error);
        ui.versionEl.textContent = '[ERR] Load failed';
    } finally {
        ui.refreshBtn.disabled = false;
    }
}

// Serial Monitor
function setMonitorUI(connected) {
    ui.monitorNotConnected.style.display = connected ? 'none' : '';
    ui.monitorConnected.style.display = connected ? 'block' : 'none';
}

async function monitorConnect() {
    try {
        const port = await navigator.serial.requestPort();
        await port.open({ baudRate: 115200 });
        monitorPort = port;
        monitorReadAborted = false;
        setMonitorUI(true);
        appendMonitor('Connected.\n');
        readSerialLoop();
    } catch (e) {
        if (e.name !== 'NotFoundError') alert('Connect failed: ' + e.message);
    }
}

async function monitorDisconnect() {
    monitorReadAborted = true;
    if (monitorReader) try { await monitorReader.cancel(); } catch (_) {}
    if (monitorPort) try { await monitorPort.close(); } catch (_) {}
    monitorPort = null;
    monitorReader = null;
    setMonitorUI(false);
    appendMonitor('Disconnected.\n');
}

async function readSerialLoop() {
    if (!monitorPort || monitorReadAborted) return;
    const decoder = new TextDecoder();
    try {
        monitorReader = monitorPort.readable.getReader();
        while (!monitorReadAborted) {
            const { value, done } = await monitorReader.read();
            if (done) break;
            if (value && value.length) appendMonitor(decoder.decode(value));
        }
    } catch (e) {
        if (!monitorReadAborted) appendMonitor('\nRead error: ' + e.message + '\n');
    } finally {
        try { if (monitorReader) await monitorReader.releaseLock(); } catch (_) {}
    }
}

function appendMonitor(text) {
    ui.monitorOutput.textContent += text;
    ui.monitorOutput.scrollTop = ui.monitorOutput.scrollHeight;
}

async function monitorSend() {
    if (!monitorPort || !monitorPort.writable) return;
    const line = ui.monitorSendInput.value + '\n';
    ui.monitorSendInput.value = '';
    const writer = monitorPort.writable.getWriter();
    try {
        await writer.write(new TextEncoder().encode(line));
    } finally {
        writer.releaseLock();
    }
}

// Helpers
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

function formatDate(isoString) {
    if (!isoString) return null;
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return null;
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');
    return `${y}-${m}-${d} ${h}:${min}:${s}`;
}
