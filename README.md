# 💈 Barbería – Reserva de citas por link

App web para que tus clientes reserven cita **desde el teléfono entrando a un link**, y tú las veas desde tu **panel privado**.

## Qué hace

**Cliente (el link que compartes):**
- Escribe su **nombre**, **número de teléfono**, elige **fecha y hora**, y **qué se va a hacer** (corte, barba, etc.).
- Solo ve las horas que están libres (no se duplican).
- Al reservar, ve el ticket de confirmación y puede avisarte por WhatsApp.
- Botón **"Ver / cancelar mis citas"**: las citas que reserve en ese teléfono se guardan en su dispositivo y puede consultar el estado o **cancelarla** solo (verificado por su número).

**Tú (panel):**
- Entra a `TULINK/panel` con tu contraseña.
- Ves las citas del día, confirmas, completas, cancelas o eliminas.
- Botón **WhatsApp** para avisar al cliente con el mensaje ya escrito.
- **Buscador** por nombre o teléfono, resumen del día y la **próxima cita** siempre visible.
- **Estadísticas** (total, por estado, últimos 14 días y servicios más pedidos).
- **Exportar / Importar** las citas como backup JSON.

## Ejecutar en tu PC

```bash
npm install
npm start
```

- Cliente: http://localhost:3000
- Panel: http://localhost:3000/panel (contraseña por defecto: `barbero123`)

**En Windows** también puedes doble clic en **`Iniciar.bat`** y la app arranca sola (instala dependencias la primera vez).

El servidor carga automáticamente un archivo `.env` si existe (ver `.env.example`).

## Variables de entorno (importante)

| Variable | Descripción | Por defecto |
|---|---|---|
| `ADMIN_PASSWORD` | Contraseña del panel. **Cámbiala.** | `barbero123` |
| `SHOP_NAME` | Nombre de la barbería | `Mi Barbería` |
| `SHOP_WHATSAPP` | Tu WhatsApp con código de país, ej. `584121234567` | vacío |
| `HORA_INICIO` / `HORA_FIN` | Horario, ej. `09:00` / `19:00` | `09:00` / `19:00` |
| `INTERVALO` | Minutos por cita | `30` |
| `DIAS_ABIERTOS` | Días abiertos (0=domingo…6=sábado) | `1,2,3,4,5,6` |
| `MIN_ANTICIPACION` | Minutos mínimos para reservar | `30` |
| `MAX_CITAS_POR_DIA` | Máximo de citas activas por teléfono y día (`0` = sin límite) | `3` |
| `PORT` | Puerto del servidor | `3000` |
| `SHOP_EMAIL` | Correo que recibe avisos de nuevas citas | vacío (aviso off) |
| `SMTP_HOST/PORT/USER/PASS` | Config SMTP para esos avisos (opcional) | vacío (aviso off) |

## Pruebas

```bash
npm test
```

Usa el runner nativo `node --test` (sin dependencias externas). El proyecto incluye CI en GitHub Actions (archivo `.github/workflows/ci.yml`).

## Publicar el link (Railway o Render)

1. Sube esta carpeta a GitHub.
2. Crea el proyecto en [railway.app](https://railway.app) o [render.com](https://render.com) conectando tu repo.
3. Comando de inicio: `npm start` (Railway lo detecta solo).
4. Agrega las variables de entorno (`ADMIN_PASSWORD`, `SHOP_NAME`, `SHOP_WHATSAPP`, etc.).
5. Abre la URL que te da la plataforma → ese es **el link para tus clientes**.
   - Panel: `https://tu-app.up.railway.app/panel`

Las citas se guardan en `data/citas.db` (SQLite). En Railway/Render ese archivo **se borra al redeployar**; si quieres conservarlas, monta un *volume* (Railway → Volume) en la carpeta `data`. Lo más seguro: **descarga con regularidad un backup desde el panel (⬇ Exportar citas)** y guárdalo tú.

## Otras notas técnicas

- **Login protegido**: tras 5 contraseñas incorrectas desde la misma IP, se bloquea por 15 minutos.
- **Sesiones persistentes**: no tienes que volver a entrar aunque el servidor se reinicie.
- **Backups automáticos**: cada día se copia la base a `data/backups/citas-<fecha>.db` (se guardan las 14 más recientes).
- **Avisos por email** (opcional): si configuras `SHOP_EMAIL` + SMTP, recibes un correo por cada cita nueva y por cada cancelación del cliente.
- **Verificación de salud**: `TULINK/api/health` para monitores de hosting.
- La cancelación del cliente requiere su número de teléfono (no se puede cancelar una cita de otra persona).
- El teléfono del cliente debe incluir el **código de país** (ej. `584121234567`) para que funcione el botón de WhatsApp.
- Cada fecha/hora solo puede reservarse una vez.
- Para desplegar usa **Node 24** (o ≥ 23) porque la base de datos usa el módulo nativo `node:sqlite`.
