// Utility: human-readable file size
function fmt(b) {
  if (b < 1024)    return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

// Settings controls -- fetch current values and send changes on input
(function () {
  var rSpeed  = document.getElementById('rSpeed');
  var rBright = document.getElementById('rBright');
  var btnMute = document.getElementById('btnMute');
  var vSpeed  = document.getElementById('vSpeed');
  var vBright = document.getElementById('vBright');
  var _muted  = false;

  function updateMuteBtn() {
    btnMute.textContent = _muted ? 'OFF' : 'ON';
    btnMute.classList.toggle('muted', _muted);
  }

  // Fetch current settings from device
  fetch('/api/settings').then(function (r) { return r.json(); }).then(function (s) {
    rSpeed.value  = s.speed;       vSpeed.textContent  = s.speed;
    rBright.value = s.brightness;  vBright.textContent = s.brightness;
    _muted = s.volume === 0;
    updateMuteBtn();
  }).catch(function () {});

  // Debounce helper -- sends POST after user stops dragging for 150ms
  var _t = null;
  function send(key, val) {
    clearTimeout(_t);
    _t = setTimeout(function () {
      fetch('/api/settings?' + key + '=' + val, { method: 'POST' });
    }, 150);
  }

  rSpeed.addEventListener('input', function () {
    vSpeed.textContent = rSpeed.value;
    send('speed', rSpeed.value);
  });
  rBright.addEventListener('input', function () {
    vBright.textContent = rBright.value;
    send('brightness', rBright.value);
  });
  btnMute.addEventListener('click', function () {
    _muted = !_muted;
    updateMuteBtn();
    send('volume', _muted ? 0 : 100);
  });

  // Save button -- persist current settings to NVS
  var btnSave = document.getElementById('btnSave');
  btnSave.addEventListener('click', function () {
    btnSave.disabled = true;
    fetch('/api/settings?save=1', { method: 'POST' })
      .then(function () {
        btnSave.classList.add('saved');
        btnSave.textContent = 'Saved';
      })
      .catch(function () {})
      .finally(function () {
        btnSave.disabled = false;
        setTimeout(function () {
          btnSave.classList.remove('saved');
          btnSave.textContent = 'Save';
        }, 2000);
      });
  });
})();

// Fetch and display storage info
async function ls() {
  try {
    var r = await (await fetch('/api/storage')).json();
    document.getElementById('sU').textContent = fmt(r.used);
    document.getElementById('sT').textContent = fmt(r.total);
    var p = r.total ? ((r.used / r.total) * 100).toFixed(1) : '0';
    document.getElementById('sP').textContent = p;
    document.getElementById('sF').style.width  = p + '%';
  } catch (e) { /* ignore */ }
}

// Fetch and display file list
async function lf() {
  try {
    var files = await (await fetch('/api/list')).json();
    var el  = document.getElementById('fl');
    if (!files.length) {
      el.innerHTML = '<div class="card-title">Files</div>'
                   + '<div class="empty">No .qgif files yet.</div>';
      return;
    }

    var hdr = '<div class="card-title">Files <span class="file-count">' + files.length + '</span></div>';
    el.innerHTML = hdr + '<div class="file-list">' + files.map(function (f) {
      return '<div class="file">'
        + '<span class="file-name' + (f.playing ? ' playing' : '') + '">' + f.name + '</span>'
        + '<span class="file-size">' + fmt(f.size) + '</span>'
        + '<button class="btn btn-play" onclick="pf(\'' + f.name + '\')">Play</button>'
        + '<button class="btn btn-del"  onclick="df(\'' + f.name + '\')">Del</button>'
        + '</div>';
    }).join('') + '</div>';
  } catch (e) {
    var el = document.getElementById('fl');
    el.innerHTML = '<div class="card-title">Files</div>'
                 + '<div class="empty">Error loading files</div>';
  }
}

// Play a file
async function pf(n) {
  await fetch('/api/play?name=' + encodeURIComponent(n), { method: 'POST' });
  lf();
}

// Delete a file
async function df(n) {
  if (!confirm('Delete ' + n + '?')) return;
  await fetch('/api/delete?name=' + encodeURIComponent(n), { method: 'POST' });
  lf();
  ls();
}

// Upload a single file
async function uf1(file) {
  var fd = new FormData();
  fd.append('file', file);
  var r = await fetch('/api/upload', { method: 'POST', body: fd });
  var d = await r.json();
  return { ok: r.ok, name: file.name, error: d.error || 'Upload failed' };
}

// Upload multiple files sequentially
async function uf(files) {
  var m = document.getElementById('msg');
  m.className = 'msg';
  m.style.display = 'none';

  var ok = 0, fail = 0, errs = [];

  for (var i = 0; i < files.length; i++) {
    m.className   = 'msg ok';
    m.textContent = 'Uploading ' + (i + 1) + '/' + files.length + ': ' + files[i].name + '...';
    m.style.display = 'block';

    try {
      var r = await uf1(files[i]);
      if (r.ok) ok++;
      else { fail++; errs.push(r.name + ': ' + r.error); }
    } catch (e) {
      fail++;
      errs.push(files[i].name + ': error');
    }
  }

  if (fail == 0) {
    m.className   = 'msg ok';
    m.textContent = 'Uploaded ' + ok + ' file' + (ok > 1 ? 's' : '') + '.';
  } else {
    m.className   = 'msg error';
    m.textContent = ok + ' ok, ' + fail + ' failed: ' + errs.join('; ');
  }
  m.style.display = 'block';
  lf();
  ls();
}

// File input handler
document.getElementById('fi').addEventListener('change', function (e) {
  if (e.target.files.length) uf(e.target.files);
  e.target.value = '';
});

// Drag-and-drop handlers
var dz = document.getElementById('dz');
dz.addEventListener('dragover', function (e) {
  e.preventDefault();
  dz.classList.add('drag');
});
dz.addEventListener('dragleave', function () {
  dz.classList.remove('drag');
});
dz.addEventListener('drop', function (e) {
  e.preventDefault();
  dz.classList.remove('drag');
  if (e.dataTransfer.files.length) uf(e.dataTransfer.files);
});

// Theme toggle (dark / light), persisted in localStorage
(function () {
  var saved = localStorage.getItem('theme');
  if (saved === 'light') document.documentElement.classList.add('light-mode');

  var btn = document.getElementById('themeBtn');
  function updateIcon() {
    // crescent moon for dark, sun for light
    btn.innerHTML = document.documentElement.classList.contains('light-mode')
      ? '&#9728;'   // sun
      : '&#9790;';  // moon
  }
  updateIcon();

  btn.addEventListener('click', function () {
    document.documentElement.classList.toggle('light-mode');
    var isLight = document.documentElement.classList.contains('light-mode');
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
    updateIcon();
  });
})();

// Initial load
ls();
lf();
