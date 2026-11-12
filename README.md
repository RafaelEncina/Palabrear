# Palabrear

Wordle multijugador por turnos, en español. Cada jugador escribe una palabra
secreta y el resto la adivina con el clásico verde / amarillo / gris. Mientras
menos intentos te tome, más puntos.

Sin registro, sin base de datos y sin build: Node.js + Express + Socket.IO en el
servidor y HTML/CSS/JS plano en el cliente.

## Cómo se juega

1. Alguien **crea una sala**, pública (aparece en el listado) o privada (solo
   con el código o el enlace), y la comparte con el botón **Compartir enlace de sala**.
2. El anfitrión configura la sala y empieza la partida. En cada ronda, **cada
   jugador escribe una palabra exactamente una vez**.
3. El escritor elige la palabra y, si quiere, deja una **pista**. Mientras los
   demás adivinan, ve los intentos de cada uno en tiempo real.
4. El turno cierra cuando todos acertaron o se rindieron, cuando se acaba el
   tiempo o cuando el anfitrión lo corta.

### Opciones de la sala

| Opción | Valores |
|---|---|
| Modo de juego | Por tiempo · El primero que adivine |
| Letras por palabra | 5 (como Wordle) · De 3 a 12 |
| Tiempo por turno | 30 a 900 segundos, o sin límite |
| Rondas | 1 a 10 |
| Jugadores | 2 a 12 |
| Pista | Opcional u obligatoria |

### Puntaje

**Por tiempo.** Todos juegan hasta acertar, rendirse o quedarse sin reloj.

| Quién | Cuánto |
|---|---|
| Adivina en 1 intento | 100 puntos |
| Cada intento extra | −10, con piso de 20 |
| Primero en acertar | +10 de bonus |
| El que escribió la palabra | +15 por cada jugador que la descubrió |

**El primero que adivine.** El turno se corta apenas alguien acierta.

| Quién | Cuánto |
|---|---|
| El primero en acertar | 100 puntos |
| El resto | 8 por cada verde y 4 por cada amarilla de su mejor intento (tope 80) |
| El que escribió la palabra | 20 si alguien la descubrió |

## Correr en local

Requiere Node.js 18 o superior.

```bash
npm install
npm start            # http://localhost:3000
npm test             # partida completa de punta a punta en el puerto 3999
```

Para jugar con otros en la misma red, compartan `http://TU_IP_LOCAL:3000`.

## Despliegue

El repo incluye [`render.yaml`](render.yaml) para desplegar en
[Render](https://render.com) (**New → Blueprint**). Las salas viven en memoria,
así que debe correr **una sola instancia**; por eso no sirve un hosting serverless.

| Variable | Para qué |
|---|---|
| `PORT` | Puerto del servidor (por defecto `3000`) |
| `URL_PUBLICA` | Dominio oficial, ej. `https://palabrear.com`. Se usa en la URL canónica, el sitemap y la vista previa al compartir, y redirige (301) cualquier otro dominio hacia este |

## Estructura

```
server.js      Express + Socket.IO: transporte, relojes, SEO (robots, sitemap) y limpieza de salas
juego.js       Lógica pura del juego: salas, evaluación de intentos y puntaje
public/        Cliente: index.html, styles.css, app.js, og.png
test/          Prueba de punta a punta
```

## Autor

Hecho por [Rafael Encina](https://rafaelencina.vercel.app).
