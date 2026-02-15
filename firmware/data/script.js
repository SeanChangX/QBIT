// Utility: human-readable file size
function fmt(b) {
  if (b < 1024)    return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

// Device info -- fetch ID and name, allow renaming
(function () {
  var devId = document.getElementById('devId');
  var devName = document.getElementById('devName');
  var btnDevSave = document.getElementById('btnDevSave');

  fetch('/api/device').then(function (r) { return r.json(); }).then(function (d) {
    devId.textContent = d.id;
    devName.value = d.name;
  }).catch(function () {});

  btnDevSave.addEventListener('click', function () {
    btnDevSave.disabled = true;
    fetch('/api/device?name=' + encodeURIComponent(devName.value) + '&save=1', { method: 'POST' })
      .then(function () {
        btnDevSave.classList.add('saved');
        btnDevSave.textContent = 'Saved';
      })
      .catch(function () {})
      .finally(function () {
        btnDevSave.disabled = false;
        setTimeout(function () {
          btnDevSave.classList.remove('saved');
          btnDevSave.textContent = 'Save Name';
        }, 2000);
      });
  });
})();

// MQTT settings -- fetch config and allow saving
(function () {
  var btnMqtt     = document.getElementById('btnMqtt');
  var mqttHost    = document.getElementById('mqttHost');
  var mqttPort    = document.getElementById('mqttPort');
  var mqttUser    = document.getElementById('mqttUser');
  var mqttPass    = document.getElementById('mqttPass');
  var mqttPrefix  = document.getElementById('mqttPrefix');
  var btnMqttSave = document.getElementById('btnMqttSave');
  var _mqttOn = false;

  function updateMqttBtn() {
    btnMqtt.textContent = _mqttOn ? 'ON' : 'OFF';
    btnMqtt.classList.toggle('muted', !_mqttOn);
  }

  fetch('/api/mqtt').then(function (r) { return r.json(); }).then(function (d) {
    _mqttOn = d.enabled;
    mqttHost.value   = d.host;
    mqttPort.value   = d.port;
    mqttUser.value   = d.user;
    mqttPass.value   = d.pass;
    mqttPrefix.value = d.prefix;
    updateMqttBtn();
  }).catch(function () {});

  btnMqtt.addEventListener('click', function () {
    _mqttOn = !_mqttOn;
    updateMqttBtn();
  });

  btnMqttSave.addEventListener('click', function () {
    btnMqttSave.disabled = true;
    var params = 'host=' + encodeURIComponent(mqttHost.value)
               + '&port=' + encodeURIComponent(mqttPort.value)
               + '&user=' + encodeURIComponent(mqttUser.value)
               + '&pass=' + encodeURIComponent(mqttPass.value)
               + '&prefix=' + encodeURIComponent(mqttPrefix.value)
               + '&enabled=' + (_mqttOn ? '1' : '0')
               + '&save=1';
    fetch('/api/mqtt?' + params, { method: 'POST' })
      .then(function () {
        btnMqttSave.classList.add('saved');
        btnMqttSave.textContent = 'Saved';
      })
      .catch(function () {})
      .finally(function () {
        btnMqttSave.disabled = false;
        setTimeout(function () {
          btnMqttSave.classList.remove('saved');
          btnMqttSave.textContent = 'Save MQTT';
        }, 2000);
      });
  });
})();

// GPIO pin configuration -- fetch current pins and allow saving
(function () {
  var VALID_PINS = [0,1,2,3,4,5,6,7,8,9,10,20,21];
  var selTouch  = document.getElementById('pinTouch');
  var selBuzzer = document.getElementById('pinBuzzer');
  var selSDA    = document.getElementById('pinSDA');
  var selSCL    = document.getElementById('pinSCL');
  var btnPin    = document.getElementById('btnPinSave');
  var pinMsg    = document.getElementById('pinMsg');

  // Populate each <select> with the available GPIO options
  [selTouch, selBuzzer, selSDA, selSCL].forEach(function (sel) {
    VALID_PINS.forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p;
      opt.textContent = 'GPIO ' + p;
      sel.appendChild(opt);
    });
  });

  // Fetch current pin values from device
  fetch('/api/pins').then(function (r) { return r.json(); }).then(function (d) {
    selTouch.value  = d.touch;
    selBuzzer.value = d.buzzer;
    selSDA.value    = d.sda;
    selSCL.value    = d.scl;
  }).catch(function () {});

  btnPin.addEventListener('click', function () {
    // Client-side validation: all 4 must be distinct
    var vals = [selTouch.value, selBuzzer.value, selSDA.value, selSCL.value];
    var unique = new Set(vals);
    if (unique.size < 4) {
      pinMsg.className = 'msg error';
      pinMsg.textContent = 'All four pins must be different.';
      pinMsg.style.display = 'block';
      return;
    }

    pinMsg.className = 'msg';
    pinMsg.style.display = 'none';
    btnPin.disabled = true;

    var params = 'touch=' + selTouch.value
               + '&buzzer=' + selBuzzer.value
               + '&sda=' + selSDA.value
               + '&scl=' + selSCL.value;
    fetch('/api/pins?' + params, { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.ok) {
          pinMsg.className = 'msg ok';
          pinMsg.textContent = 'Saved. Rebooting device...';
          pinMsg.style.display = 'block';
          btnPin.textContent = 'Rebooting...';
        } else {
          pinMsg.className = 'msg error';
          pinMsg.textContent = d.error || 'Save failed.';
          pinMsg.style.display = 'block';
          btnPin.disabled = false;
        }
      })
      .catch(function () {
        pinMsg.className = 'msg error';
        pinMsg.textContent = 'Connection lost (device may be rebooting).';
        pinMsg.style.display = 'block';
        btnPin.disabled = false;
      });
  });
})();

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

// Timezone setting -- fetch current timezone and allow saving
(function () {
  var tzSelect = document.getElementById('tzSelect');
  var tzOffset = document.getElementById('tzOffset');
  var btnTzSave = document.getElementById('btnTzSave');

  fetch('/api/timezone').then(function (r) { return r.json(); }).then(function (d) {
    if (d.iana) tzSelect.value = d.iana;
    if (typeof d.offset === 'number') tzOffset.value = d.offset;
  }).catch(function () {});

  btnTzSave.addEventListener('click', function () {
    btnTzSave.disabled = true;
    var params = 'iana=' + encodeURIComponent(tzSelect.value)
               + '&offset=' + encodeURIComponent(tzOffset.value || '0');
    fetch('/api/timezone?' + params, { method: 'POST' })
      .then(function () {
        btnTzSave.classList.add('saved');
        btnTzSave.textContent = 'Saved';
      })
      .catch(function () {})
      .finally(function () {
        btnTzSave.disabled = false;
        setTimeout(function () {
          btnTzSave.classList.remove('saved');
          btnTzSave.textContent = 'Save Timezone';
        }, 2000);
      });
  });
})();

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
