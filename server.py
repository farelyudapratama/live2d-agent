"""server.py — Lightweight local HTTP server (Python 3)
Fallback if Node.js not available. No external dependencies.

FIX: manually decode URL (handles CJK like 神宫白子) and stream files in
chunks. Python's SimpleHTTPRequestHandler mangles %-encoded CJK paths on
Windows, which broke Live2D model loading (.moc3 / textures returned a
directory listing instead of the real file).
"""
import http.server
import socketserver
import os
import sys
import urllib.parse
import webbrowser
import threading

PORT = 8310
ROOT = os.path.dirname(os.path.abspath(__file__))

MIME_OVERRIDES = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.js':   'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.moc3': 'application/octet-stream',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.mp3':  'audio/mpeg',
    '.wav':  'audio/wav',
}


class Live2DHandler(http.server.BaseHTTPRequestHandler):
    def _resolve(self):
        raw = urllib.parse.unquote(self.path.split('?')[0])
        if raw in ('', '/'):
            raw = '/index.html'
        # security: strip traversal
        clean = os.path.normpath(raw).lstrip(os.sep + os.altsep + '\\/')
        full = os.path.join(ROOT, clean)
        if not os.path.abspath(full).startswith(os.path.abspath(ROOT)):
            return None
        return full

    def do_GET(self):
        path_ = self._resolve()
        if not path_ or not os.path.isfile(path_):
            self.send_error(404, 'Not Found')
            return
        ext = os.path.splitext(path_)[1].lower()
        mime = MIME_OVERRIDES.get(ext, 'application/octet-stream')
        try:
            size = os.path.getsize(path_)
            self.send_response(200)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(size))
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            with open(path_, 'rb') as f:
                while True:
                    chunk = f.read(64 * 1024)
                    if not chunk:
                        break
                    try:
                        self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionAbortedError):
                        break
        except (BrokenPipeError, ConnectionAbortedError):
            pass

    def log_message(self, fmt, *a):
        sys.stdout.write(f'  {a[0]} → {a[1]}\n')
        sys.stdout.flush()


if __name__ == '__main__':
    url = f'http://127.0.0.1:{PORT}'
    print(f'\n  🎭 Live2D Agent server running at:\n  {url}\n\n  Tekan Ctrl+C untuk menghentikan.\n')
    threading.Timer(1.5, lambda: webbrowser.open(url)).start()
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(('127.0.0.1', PORT), Live2DHandler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\n  Server stopped.')
