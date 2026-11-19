# OpenWA Serverless API Gateway (Development)

Serverless API Gateway running on Vercel (`dev-api-wa.mmtechhouse.co`) for OpenWA development environment.

## Architecture
- **API Runtime**: Vercel Serverless Functions (`@vercel/node`)
- **Domain**: `dev-api-wa.mmtechhouse.co`
- **Socket Engine**: Remote Socket via `https://openwa-socket-service.onrender.com`
- **Fallback API**: `https://api-wa.mmtechhouse.co` (Oracle Cloud production API)
- **Sessions**: Proxied seamlessly to the active backend session engine.

## Endpoints
- `GET /api/health` - Healthcheck & engine metadata
- `GET /api/sessions` - List active WhatsApp sessions
- `GET /api/sessions/:id` - Session detail
- `GET /api/sessions/:id/qr` - Session QR code
- `GET /api/sessions/:id/status` - Session status
- `POST /api/sessions/:id/start` - Start session
- `POST /api/sessions/:id/stop` - Stop session
- `POST /api/sessions/:id/logout` - Logout session
- `POST /api/sessions/:id/send-message` - Send WhatsApp message
- `GET /api/sessions/:id/wa-web/view` - WhatsApp Web Companion HTML viewer
- `GET /api/sessions/:id/wa-web/status` - Companion status
- `POST /api/sessions/:id/wa-web/start` - Start companion stream
- `POST /api/sessions/:id/wa-web/stop` - Stop companion stream
- `GET /api/sessions/:id/wa-web/screenshot` - Capture companion screenshot
