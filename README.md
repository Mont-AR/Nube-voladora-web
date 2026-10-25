# Nube Voladora

Web de muestra para un estudio de edición de video y contenido, construida con [Astro](https://astro.build) y [Three.js](https://threejs.org).

El hero es una escena 3D interactiva: una nube voladora lleva una tele CRT sobre un valle synthwave infinito (montañas low-poly, río, luces de pueblo, sol a franjas, estrellas y pájaros). Una cinta de película cian marca la ruta con íconos luminosos. La paleta sale de montivero.ar y la tele retro con borde RGB es un guiño a catannabis.

- **Canales = servicios:** la pantalla muestra 4 canales procedurales (Edición/timeline, Motion, Redes 9:16, Color/etalonaje) con texto sobreimpreso, scanlines y estática al cambiar.
- **Interacción:** arrastrar la nube para girarla, click en la tele para cambiar de canal, click en la nube para un "puff", íconos de la cinta y flechas ◀ ▶ (o el teclado) para sintonizar, botón **8-BIT** para pixelar la imagen.
- **Scroll:** acelera el vuelo y eleva la cámara.
- Todo se genera por código (sin modelos ni imágenes externas).

```bash
npm install
npm run dev      # http://localhost:4321
npm run build
```

La escena vive en `src/scripts/nube-scene.ts`; los textos de cada sección en `src/components/`.
