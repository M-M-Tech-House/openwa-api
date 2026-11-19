export function generateWaWebViewerHtml(sessionId: string, apiKey: string, socketServiceUrl: string): string {
  const normalizedSocketUrl = socketServiceUrl.replace(/\/+$/, '');
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>WhatsApp Web Oficial - ${sessionId}</title>
  <script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100%;
      height: 100%;
      overflow: hidden;
      background-color: #111b21;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      user-select: none;
    }
    #container {
      position: relative;
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #viewport {
      display: block;
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      cursor: default;
      outline: none;
    }
    #overlay-loader {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(17, 27, 33, 0.92);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: #00a884;
      font-size: 14px;
      gap: 16px;
      z-index: 10;
      transition: opacity 0.3s ease;
      text-align: center;
      padding: 20px;
    }
    .spinner {
      width: 44px;
      height: 44px;
      border: 3px solid rgba(0, 168, 132, 0.2);
      border-top-color: #00a884;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    #status-pill {
      position: absolute;
      top: 10px;
      right: 10px;
      background: rgba(11, 20, 26, 0.7);
      backdrop-filter: blur(4px);
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 11px;
      color: #8696a0;
      display: flex;
      align-items: center;
      gap: 6px;
      z-index: 5;
    }
    #status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #eab308;
    }
    #status-dot.connected { background: #00a884; }
    #status-dot.disconnected { background: #ea0038; }
    .session-badge {
      font-weight: 600;
      color: #e9edef;
    }
    #error-details {
      color: #8696a0;
      font-size: 12px;
      max-width: 320px;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div id="container">
    <div id="status-pill">
      <span id="status-dot"></span>
      <span id="status-text">Conectando...</span>
      <span class="session-badge">${sessionId}</span>
    </div>
    <div id="overlay-loader">
      <div class="spinner"></div>
      <div id="loader-msg">Iniciando WhatsApp Web Oficial (${sessionId})...</div>
      <div id="error-details">Conectando al servicio remoto de sockets...</div>
    </div>
    <canvas id="viewport" tabindex="0"></canvas>
  </div>
  <script>
    (function() {
      const sessionId = ${JSON.stringify(sessionId)};
      const apiKey = ${JSON.stringify(apiKey)};
      const socketUrl = ${JSON.stringify(normalizedSocketUrl)};
      const canvas = document.getElementById('viewport');
      const ctx = canvas.getContext('2d');
      const loader = document.getElementById('overlay-loader');
      const loaderMsg = document.getElementById('loader-msg');
      const errorDetails = document.getElementById('error-details');
      const statusDot = document.getElementById('status-dot');
      const statusText = document.getElementById('status-text');
      let naturalWidth = 1280;
      let naturalHeight = 800;
      canvas.width = naturalWidth;
      canvas.height = naturalHeight;
      let firstFrameReceived = false;

      // Draw initial placeholder canvas
      ctx.fillStyle = '#111b21';
      ctx.fillRect(0, 0, naturalWidth, naturalHeight);

      if (typeof io === 'undefined') {
        loaderMsg.textContent = 'Error cargando Socket.IO';
        errorDetails.textContent = 'Verifique la conexión a internet.';
        statusDot.className = 'disconnected';
        statusText.textContent = 'Error';
        return;
      }

      // Conectar al servicio de sockets remoto (Render/Oracle)
      const socket = io(socketUrl + '/wa-web-companion', {
        transports: ['websocket', 'polling'],
        auth: { apiKey },
        reconnectionDelay: 2000,
        reconnectionAttempts: 20
      });

      socket.on('connect', () => {
        statusDot.className = 'connected';
        statusText.textContent = 'En vivo';
        loaderMsg.textContent = 'Esperando stream de WhatsApp Web...';
        errorDetails.textContent = 'Sesión ' + sessionId + ' conectada';
        socket.emit('subscribe', { sessionId, apiKey });
      });

      socket.on('disconnect', () => {
        statusDot.className = 'disconnected';
        statusText.textContent = 'Desconectado';
        loader.style.display = 'flex';
        loaderMsg.textContent = 'Reconectando con el servidor...';
        errorDetails.textContent = 'Intentando reconexión a ' + socketUrl;
      });

      socket.on('frame', (payload) => {
        if (!firstFrameReceived) {
          firstFrameReceived = true;
          loader.style.display = 'none';
        }
        if (!payload || !payload.data) return;
        const img = new Image();
        img.onload = () => {
          if (img.width && img.height) {
            naturalWidth = img.width;
            naturalHeight = img.height;
            if (canvas.width !== naturalWidth) canvas.width = naturalWidth;
            if (canvas.height !== naturalHeight) canvas.height = naturalHeight;
          }
          ctx.drawImage(img, 0, 0);
        };
        img.src = 'data:image/jpeg;base64,' + payload.data;
      });

      function getCanvasCoordinates(e) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = naturalWidth / rect.width;
        const scaleY = naturalHeight / rect.height;
        return {
          x: Math.round((e.clientX - rect.left) * scaleX),
          y: Math.round((e.clientY - rect.top) * scaleY)
        };
      }

      function sendMouse(action, e, extra = {}) {
        const coords = getCanvasCoordinates(e);
        const btnMap = { 0: 'left', 1: 'middle', 2: 'right' };
        socket.emit('input', {
          sessionId,
          type: 'mouse',
          action,
          x: coords.x,
          y: coords.y,
          button: btnMap[e.button] || 'left',
          clickCount: e.detail || 1,
          ...extra
        });
      }

      canvas.addEventListener('mousedown', (e) => {
        canvas.focus();
        sendMouse('mousePressed', e);
      });

      canvas.addEventListener('mouseup', (e) => {
        sendMouse('mouseReleased', e);
      });

      let lastMove = 0;
      canvas.addEventListener('mousemove', (e) => {
        const now = Date.now();
        if (now - lastMove > 35) {
          lastMove = now;
          sendMouse('mouseMoved', e);
        }
      });

      canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        sendMouse('mouseWheel', e, { deltaX: e.deltaX, deltaY: e.deltaY });
      }, { passive: false });

      canvas.addEventListener('contextmenu', (e) => e.preventDefault());

      window.addEventListener('keydown', (e) => {
        if (document.activeElement !== canvas) return;
        if (['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
          e.preventDefault();
        }
        socket.emit('input', {
          sessionId,
          type: 'key',
          action: 'keyDown',
          key: e.key,
          code: e.code,
          text: e.key.length === 1 ? e.key : undefined,
          keyCode: e.keyCode
        });
      });

      window.addEventListener('keyup', (e) => {
        if (document.activeElement !== canvas) return;
        socket.emit('input', {
          sessionId,
          type: 'key',
          action: 'keyUp',
          key: e.key,
          code: e.code,
          keyCode: e.keyCode
        });
      });
    })();
  </script>
</body>
</html>`;
}
