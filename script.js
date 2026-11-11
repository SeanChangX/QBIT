// QBIT Firmware Flasher
// Flashing handled by esp-web-tools <esp-web-install-button> via manifest.json

// UI elements
const ui = {
    themeBtn: document.getElementById('themeBtn'),
    versionEl: document.getElementById('version'),
    timestampEl: document.getElementById('timestamp'),
    firmwareSizeEl: document.getElementById('firmware-size'),
    firmwareMd5El: document.getElementById('firmware-md5'),
    refreshBtn: document.getElementById('refresh-btn'),
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    const savedTheme = localStorage.getItem('theme');
    const isLight = savedTheme === 'light';
    if (isLight) document.documentElement.classList.add('light-mode');
    syncThemeButton();
    ui.themeBtn.addEventListener('click', toggleTheme);

    loadLatestVersion();
    ui.refreshBtn.addEventListener('click', loadLatestVersion);
});

function toggleTheme() {
    document.documentElement.classList.toggle('light-mode');
    const isLight = document.documentElement.classList.contains('light-mode');
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
    syncThemeButton();
}

function syncThemeButton() {
    const isLight = document.documentElement.classList.contains('light-mode');
    ui.themeBtn.classList.toggle('is-light', isLight);
    ui.themeBtn.setAttribute('aria-pressed', isLight ? 'true' : 'false');
    ui.themeBtn.setAttribute('aria-label', isLight ? 'Switch to dark mode' : 'Switch to light mode');
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

        ui.versionEl.textContent = latestJson.version || 'Unknown';
        ui.timestampEl.textContent = formatDate(latestJson.timestamp) || 'Unknown';
        const fw = latestJson.files && latestJson.files['firmware.bin'];
        if (fw) {
            ui.firmwareSizeEl.textContent = typeof fw.size === 'number' ? formatBytes(fw.size) : 'Unknown';
            ui.firmwareMd5El.textContent = typeof fw.md5 === 'string' && fw.md5.length >= 16
                ? fw.md5.substring(0, 16) + '...'
                : 'Unknown';
        } else {
            ui.firmwareSizeEl.textContent = 'Unknown';
            ui.firmwareMd5El.textContent = 'Unknown';
        }
    } catch (error) {
        console.error('Load version failed:', error);
        ui.versionEl.textContent = '[ERR] Load failed';
    } finally {
        ui.refreshBtn.disabled = false;
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
